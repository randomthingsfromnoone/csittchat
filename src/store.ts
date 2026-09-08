import type { GDB } from 'genosdb';
import { nodeId, parseRecord, isVisibleMessage, type MessageRecord, type PresenceRecord, type RoomRecord, type RecordValue } from './model.ts';

export class ChatStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly messages = new Map<string, MessageRecord>();
  readonly presence = new Map<string, PresenceRecord>();
  private cleanup = new Set<string>();
  private sweeping = false;
  private lastStorageScan = 0;
  private unsubscribe?: () => void;
  // Keep UI memory bounded. This is not transport-level flood protection.
  private readonly limits = { room: 1000, message: 5000, presence: 2000 };

  readonly db: GDB;
  private changed: () => void;
  private failed: (error: unknown) => void;

  constructor(db: GDB, changed: () => void, failed: (error: unknown) => void) {
    this.db = db;
    this.changed = changed;
    this.failed = failed;
  }

  async start() {
    const subscription = await this.db.map({ realtime: true }, ({ id, value, action }) => {
      if (action === 'removed') {
        this.deleteCached(id);
        this.changed();
        return;
      }
      const record = parseRecord(id, value);
      if (!record) {
        this.deleteCached(id);
        this.changed();
        return;
      }
      if (record.expiresAt <= Date.now()) {
        this.deleteCached(id);
        if (this.cleanup.size < 10000) this.cleanup.add(id);
        this.changed();
        return;
      }
      const cache = this.cache(record.kind);
      const previous = cache.get(record.id);
      // Rooms/messages are immutable in this client. Replays cannot create a
      // second row; changed values at an already observed ID are ignored.
      if (previous && record.kind !== 'presence') return;
      if (previous && record.createdAt < previous.createdAt) return;
      if (cache.size >= this.limits[record.kind] && !previous) return;
      cache.set(record.id, record);
      this.changed();
    });
    this.unsubscribe = subscription.unsubscribe;
    await this.sweep();
  }

  private cache(kind: RecordValue['kind']): Map<string, RecordValue> {
    return (kind === 'room' ? this.rooms : kind === 'message' ? this.messages : this.presence) as Map<string, RecordValue>;
  }

  private deleteCached(id: string) {
    const [kind, uuid] = id.split(':');
    if (kind === 'room' || kind === 'message' || kind === 'presence') this.cache(kind).delete(uuid);
  }

  async put(value: RecordValue) {
    if (!parseRecord(nodeId(value), value)) throw new Error('Invalid record');
    await this.db.put(value, nodeId(value));
  }

  async sweep(now = Date.now()) {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // Also collect expired records outside the bounded UI caches. Otherwise
      // a busy square could leave omitted messages in storage indefinitely.
      if (now - this.lastStorageScan >= 10000) {
        const { results } = await this.db.map({
          query: { kind: { $in: ['room', 'message', 'presence'] }, expiresAt: { $lte: now } },
          $limit: 100,
        });
        for (const node of results) {
          if (parseRecord(node.id, node.value, now)) this.cleanup.add(node.id);
        }
        this.lastStorageScan = now;
      }
      for (const cache of [this.rooms, this.messages, this.presence]) {
        for (const value of cache.values()) {
          const room = value.kind === 'message' ? this.rooms.get(value.roomId) : undefined;
          if (value.expiresAt <= now || (room && room.expiresAt <= now)) {
            this.cleanup.add(nodeId(value));
          }
        }
      }
      // Batches keep cleanup responsive and retry failed removals next tick.
      for (const id of [...this.cleanup].slice(0, 100)) {
        try {
          await this.db.remove(id);
          this.cleanup.delete(id);
          this.deleteCached(id);
        } catch (error) { this.failed(error); break; }
      }
    } catch (error) { this.failed(error); }
    finally { this.sweeping = false; this.changed(); }
  }

  visibleMessages(roomId: string, now: number) {
    return [...this.messages.values()].filter(m => m.roomId === roomId && isVisibleMessage(m, this.rooms, now))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  participants(roomId: string | undefined, now: number) {
    return new Set([...this.presence.values()].filter(p => p.expiresAt > now && (roomId === undefined || p.roomId === roomId)).map(p => p.authorId)).size;
  }

  stop() { this.unsubscribe?.(); }
}
