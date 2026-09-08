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
  private unsubscribeRoom?: () => void;
  private roomGeneration = 0;
  private activeRoom: string | null = null;
  private roomMessages = new Map<string, MessageRecord>();
  private recoveryTimers: ReturnType<typeof setTimeout>[] = [];
  private recovering = false;
  private stopped = false;
  historyState: 'loading' | 'ready' | 'error' = 'ready';
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

  scheduleHistoryRecovery() {
    // Cellular Mesh can lose the initial graph handshake while connections
    // settle. Coalesce joins and repeat ordinary writes twice after that window.
    // This uses the supported DB API, with no extra wire protocol or new IDs.
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers = [5000, 20000].map(delay => setTimeout(() => {
      void this.republishHistory().catch(this.failed);
    }, delay));
  }

  async republishHistory() {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      // Read storage rather than the activity cache. Any remaining holder can
      // pass history on, even if its original author has already left.
      for (const [kind, limit] of [['room', 1000], ['message', 500]] as const) {
        const { results } = await this.db.map({
          query: { kind, expiresAt: { $gt: Date.now() } },
          field: 'createdAt', order: 'desc', $limit: limit,
        });
        for (const { id } of results) {
          if (this.stopped) return;
          // A record may have expired or been removed since the snapshot.
          const { result } = await this.db.get(id);
          const value = result && parseRecord(id, result.value);
          if (!value || value.kind !== kind || value.expiresAt <= Date.now()) continue;
          if (value.kind === 'message' && value.roomId !== 'main') {
            const { result: roomNode } = await this.db.get(`room:${value.roomId}`);
            const room = roomNode && parseRecord(roomNode.id, roomNode.value);
            if (!room || room.kind !== 'room' || room.expiresAt <= Date.now()) continue;
          }
          // Keep the entire payload, including createdAt and expiresAt.
          await this.db.put(value, id);
        }
      }
    } finally { this.recovering = false; }
  }

  async watchRoom(roomId: string | null) {
    const generation = ++this.roomGeneration;
    this.unsubscribeRoom?.();
    this.unsubscribeRoom = undefined;
    this.activeRoom = roomId;
    this.roomMessages.clear();
    this.historyState = roomId ? 'loading' : 'ready';
    this.changed();
    if (!roomId) return;

    const receive = (id: string, value: unknown, removed = false) => {
      if (generation !== this.roomGeneration) return;
      if (removed) this.roomMessages.delete(id.slice('message:'.length));
      else {
        const record = parseRecord(id, value);
        if (!record || record.kind !== 'message' || record.roomId !== roomId) return;
        if (record.expiresAt <= Date.now()) {
          this.cleanup.add(id);
          this.roomMessages.delete(record.id);
        } else if (!this.roomMessages.has(record.id)) this.roomMessages.set(record.id, record);
      }
      this.changed();
    };
    try {
      // Read the actual graph on entry and keep this room subscribed. Its
      // history must not depend on the bounded, all-room activity cache.
      const subscription = await this.db.map({
        query: { kind: 'message', roomId },
        field: 'createdAt', order: 'desc', $limit: 500, realtime: true,
      }, ({ id, value, action }) => receive(id, value, action === 'removed'));
      if (generation !== this.roomGeneration) { subscription.unsubscribe?.(); return; }
      this.unsubscribeRoom = subscription.unsubscribe;
      for (const { id, value } of subscription.results) receive(id, value);
      this.historyState = 'ready';
    } catch (error) {
      if (generation !== this.roomGeneration) return;
      this.historyState = 'error';
      this.failed(error);
    }
    this.changed();
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
    const source = this.activeRoom === roomId ? this.roomMessages : this.messages;
    return [...source.values()].filter(m => m.roomId === roomId && isVisibleMessage(m, this.rooms, now))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  participants(roomId: string | undefined, now: number) {
    return new Set([...this.presence.values()].filter(p => p.expiresAt > now && (roomId === undefined || p.roomId === roomId)).map(p => p.authorId)).size;
  }

  stop() {
    this.stopped = true;
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.roomGeneration++; this.unsubscribe?.(); this.unsubscribeRoom?.();
  }
}
