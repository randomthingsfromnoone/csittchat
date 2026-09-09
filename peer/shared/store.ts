import type { GDB } from 'genosdb';
import {
  nodeId,
  parseRecord,
  isVisibleMessage,
  mergeRoom,
  renewRoom,
  nameOwner,
  type ProfileRecord,
  type MessageRecord,
  type PresenceRecord,
  type ReceiptRecord,
  type RoomRecord,
  type RecordValue,
} from './model.ts';

export class ChatStore {
  readonly rooms = new Map<string, RoomRecord>();
  readonly messages = new Map<string, MessageRecord>();
  readonly presence = new Map<string, PresenceRecord>();
  readonly receipts = new Map<string, ReceiptRecord>();
  readonly profiles = new Map<string, ProfileRecord>();
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
  private pendingRooms = new Map<string, RoomRecord>();
  private pendingProfiles = new Map<string, ProfileRecord>();
  private flushingProfiles?: Promise<void>;
  private flushingRooms?: Promise<void>;
  historyState: 'loading' | 'ready' | 'error' = 'ready';
  // Keep UI memory bounded. This is not transport-level flood protection.
  private readonly limits = {
    room: 1000,
    message: 5000,
    presence: 2000,
    receipt: 10000,
    profile: 10000,
  };

  readonly db: GDB;
  private changed: () => void;
  private failed: (error: unknown) => void;

  private verify: (record: RecordValue) => boolean;
  constructor(
    db: GDB,
    changed: () => void,
    failed: (error: unknown) => void,
    verify = (_record: RecordValue) => true,
  ) {
    this.db = db;
    this.changed = changed;
    this.failed = failed;
    this.verify = verify;
  }

  async start() {
    const subscription = await this.db.map({ realtime: true }, ({ id, value, action }) => {
      if (action === 'removed') {
        this.deleteCached(id);
        this.changed();
        return;
      }
      const record = parseRecord(id, value);
      if (!record || !this.verify(record)) {
        this.deleteCached(id);
        this.changed();
        return;
      }
      if (record.kind === 'profile') {
        this.acceptProfile(record);
        return;
      }
      if (record.kind !== 'room' && record.profile) {
        try {
          this.acceptProfile(JSON.parse(record.profile));
        } catch {
          /* The verifier rejects malformed proofs. */
        }
      }
      if (record.kind === 'room') {
        this.receiveRoom(record);
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
      // Messages are immutable in this client. Replays cannot create a
      // second row; changed values at an already observed ID are ignored.
      if (previous && record.kind !== 'presence') return;
      if (previous && record.createdAt < previous.createdAt) return;
      if (cache.size >= this.limits[record.kind] && !previous) return;
      cache.set(record.id, record);
      if (record.kind === 'message') this.applyMessageActivity(record);
      this.changed();
    });
    this.unsubscribe = subscription.unsubscribe;
    await this.sweep();
  }

  private cache(kind: RecordValue['kind']): Map<string, RecordValue> {
    return (
      kind === 'room'
        ? this.rooms
        : kind === 'message'
          ? this.messages
          : kind === 'receipt'
            ? this.receipts
            : kind === 'profile'
              ? this.profiles
              : this.presence
    ) as Map<string, RecordValue>;
  }

  acceptProfile(profile: ProfileRecord) {
    if (!parseRecord(nodeId(profile), profile) || !this.verify(profile)) return;
    const previous = this.profiles.get(profile.id);
    if (
      previous &&
      previous.name === profile.name &&
      previous.permanent === profile.permanent &&
      previous.publicKey === profile.publicKey &&
      previous.updatedAt > profile.updatedAt &&
      previous.expiresAt > Date.now()
    ) {
      this.pendingProfiles.set(previous.id, previous);
      queueMicrotask(() => {
        if (!this.stopped) void this.flushProfileUpdates();
      });
      return;
    }
    if (profile.expiresAt <= Date.now()) return;
    if (
      previous &&
      (previous.name !== profile.name ||
        previous.permanent !== profile.permanent ||
        previous.publicKey !== profile.publicKey ||
        previous.permanent ||
        previous.updatedAt >= profile.updatedAt ||
        profile.createdAt < previous.createdAt)
    )
      return;
    if (!previous && this.profiles.size >= this.limits.profile) return;
    this.profiles.set(profile.id, profile);
    this.cleanup.delete(nodeId(profile));
    this.changed();
  }

  private flushProfileUpdates(): Promise<void> {
    return (this.flushingProfiles ??= (async () => {
      for (const [id, pending] of this.pendingProfiles) {
        if (this.stopped) return;
        try {
          const { result } = await this.db.get(nodeId(pending));
          const current = result && parseRecord(nodeId(pending), result.value);
          const latest = this.profiles.get(id) || pending;
          if (
            current?.kind === 'profile' &&
            this.verify(current) &&
            current.name === latest.name &&
            current.permanent === latest.permanent &&
            current.updatedAt < latest.updatedAt &&
            latest.expiresAt > Date.now()
          )
            await this.db.put(latest, nodeId(latest));
          if (this.pendingProfiles.get(id) === pending) this.pendingProfiles.delete(id);
        } catch (error) {
          this.failed(error);
          return;
        }
      }
    })().finally(() => {
      this.flushingProfiles = undefined;
    }));
  }

  private authorAllowed(value: MessageRecord | PresenceRecord | ReceiptRecord) {
    if (!value.profile) return true; // Legacy test stores can opt out of signature verification.
    try {
      const profile: ProfileRecord = JSON.parse(value.profile);
      const known = this.profiles.get(profile.id);
      if (
        known &&
        (known.name !== profile.name ||
          known.permanent !== profile.permanent ||
          (known.permanent && known.createdAt !== profile.createdAt))
      )
        return false;
      return (
        nameOwner([...this.profiles.values(), profile], profile.nameKey, value.createdAt)?.id ===
        value.authorId
      );
    } catch {
      return false;
    }
  }

  private deleteCached(id: string) {
    const [kind, uuid] = id.split(':');
    if (
      kind === 'room' ||
      kind === 'message' ||
      kind === 'presence' ||
      kind === 'receipt' ||
      kind === 'profile'
    )
      this.cache(kind).delete(uuid);
    if (kind === 'room') this.pendingRooms.delete(uuid);
    if (kind === 'profile') this.pendingProfiles.delete(uuid);
  }

  private receiveRoom(incoming: RoomRecord) {
    const previous = this.rooms.get(incoming.id);
    let room = previous ? mergeRoom(previous, incoming) : incoming;
    if (room.expiresAt <= Date.now()) {
      if (this.cleanup.size < 10000) this.cleanup.add(nodeId(room));
      return;
    }
    if (!previous && this.rooms.size >= this.limits.room) return;
    // Initial sync can deliver messages before their room metadata.
    for (const message of this.messages.values()) room = renewRoom(room, message);
    this.rooms.set(room.id, room);
    this.cleanup.delete(nodeId(room));
    if (room.lastActivityAt > incoming.lastActivityAt) this.queueRoom(room);
  }

  private applyMessageActivity(message: MessageRecord) {
    const room = this.rooms.get(message.roomId);
    if (!room) return;
    const renewed = renewRoom(room, message);
    if (renewed === room) return;
    this.rooms.set(room.id, renewed);
    this.cleanup.delete(nodeId(room));
    this.queueRoom(renewed);
  }

  private queueRoom(room: RoomRecord) {
    this.pendingRooms.set(room.id, room);
    queueMicrotask(() => {
      if (!this.stopped) void this.flushRoomUpdates();
    });
  }

  private flushRoomUpdates(): Promise<void> {
    return (this.flushingRooms ??= this.persistRoomUpdates().finally(() => {
      this.flushingRooms = undefined;
    }));
  }

  private async persistRoomUpdates() {
    for (const [id, pending] of this.pendingRooms) {
      if (this.stopped) return;
      try {
        const { result } = await this.db.get(nodeId(pending));
        const current = result && parseRecord(nodeId(pending), result.value);
        // A deletion must not be undone by a queued renewal.
        if (!current || current.kind !== 'room') {
          this.pendingRooms.delete(id);
          continue;
        }
        const room = mergeRoom(pending, current);
        if (room.expiresAt <= Date.now()) {
          this.pendingRooms.delete(id);
          continue;
        }
        if (room.lastActivityAt > current.lastActivityAt) await this.db.put(room, nodeId(room));
        if (this.pendingRooms.get(id) === pending) this.pendingRooms.delete(id);
      } catch (error) {
        this.failed(error);
        return;
      } // Retry on the next sweep.
    }
  }

  async put(value: RecordValue) {
    if (!parseRecord(nodeId(value), value) || !this.verify(value))
      throw new Error('Invalid record');
    if (value.kind === 'message' && value.roomId !== 'main') {
      const id = `room:${value.roomId}`;
      const { result } = await this.db.get(id);
      const room = result && parseRecord(id, result.value);
      if (!room || room.kind !== 'room') throw new Error('Room unavailable');
      this.receiveRoom(room);
      const current = this.rooms.get(value.roomId);
      if (
        !current ||
        current.expiresAt <= Date.now() ||
        value.createdAt < current.createdAt ||
        value.createdAt >= current.expiresAt
      )
        throw new Error('Room expired');
    }
    await this.db.put(value, nodeId(value));
    if (value.kind === 'message') {
      this.applyMessageActivity(value);
      await this.flushRoomUpdates();
      await this.flushProfileUpdates();
      this.changed();
    }
  }

  scheduleHistoryRecovery() {
    // Cellular Mesh can lose the initial graph handshake while connections
    // settle. Coalesce joins and repeat ordinary writes twice after that window.
    // This uses the supported DB API, with no extra wire protocol or new IDs.
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers = [5000, 20000].map((delay) =>
      setTimeout(() => {
        void this.republishHistory().catch(this.failed);
      }, delay),
    );
  }

  async republishHistory() {
    if (this.recovering || this.stopped) return;
    this.recovering = true;
    try {
      // Read storage rather than the activity cache. Any remaining holder can
      // pass history on, even if its original author has already left.
      for (const [kind, limit] of [
        ['profile', 10000],
        ['room', 1000],
        ['message', 500],
        ['receipt', 1000],
      ] as const) {
        const { results } = await this.db.map({
          query: { kind, expiresAt: { $gt: Date.now() } },
          field: 'createdAt',
          order: 'desc',
          $limit: limit,
        });
        for (const { id } of results) {
          if (this.stopped) return;
          // A record may have expired or been removed since the snapshot.
          const { result } = await this.db.get(id);
          const value = result && parseRecord(id, result.value);
          if (!value || !this.verify(value) || value.kind !== kind || value.expiresAt <= Date.now())
            continue;
          if (value.kind === 'message' && value.roomId !== 'main') {
            const { result: roomNode } = await this.db.get(`room:${value.roomId}`);
            const room = roomNode && parseRecord(roomNode.id, roomNode.value);
            if (!room || room.kind !== 'room' || room.expiresAt <= Date.now()) continue;
          }
          // Keep the entire payload, including createdAt and expiresAt.
          await this.db.put(value, id);
        }
      }
    } finally {
      this.recovering = false;
    }
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
        if (
          !record ||
          !this.verify(record) ||
          record.kind !== 'message' ||
          record.roomId !== roomId
        )
          return;
        if (record.expiresAt <= Date.now()) {
          this.cleanup.add(id);
          this.roomMessages.delete(record.id);
        } else if (!this.roomMessages.has(record.id)) {
          this.roomMessages.set(record.id, record);
          this.applyMessageActivity(record);
        }
      }
      this.changed();
    };
    try {
      // Read the actual graph on entry and keep this room subscribed. Its
      // history must not depend on the bounded, all-room activity cache.
      const subscription = await this.db.map(
        {
          query: { kind: 'message', roomId },
          field: 'createdAt',
          order: 'desc',
          $limit: 500,
          realtime: true,
        },
        ({ id, value, action }) => receive(id, value, action === 'removed'),
      );
      if (generation !== this.roomGeneration) {
        subscription.unsubscribe?.();
        return;
      }
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
      await this.flushRoomUpdates();
      await this.flushProfileUpdates();
      // Also collect expired records outside the bounded UI caches. Otherwise
      // a busy square could leave omitted messages in storage indefinitely.
      if (now - this.lastStorageScan >= 10000) {
        const { results } = await this.db.map({
          query: {
            kind: { $in: ['room', 'message', 'presence', 'receipt', 'profile'] },
            expiresAt: { $lte: now },
          },
          $limit: 100,
        });
        for (const node of results) {
          if (parseRecord(node.id, node.value, now)) this.cleanup.add(node.id);
        }
        this.lastStorageScan = now;
      }
      for (const cache of [
        this.rooms,
        this.messages,
        this.presence,
        this.receipts,
        this.profiles,
      ]) {
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
          // A room renewal or presence heartbeat may supersede the scan.
          const { result } = await this.db.get(id);
          const current = result && parseRecord(id, result.value, now);
          const cachedRoom = current?.kind === 'room' ? this.rooms.get(current.id) : undefined;
          const latest =
            current?.kind === 'room' && cachedRoom ? mergeRoom(current, cachedRoom) : current;
          if (latest && latest.expiresAt > now) {
            const room = latest.kind === 'message' ? this.rooms.get(latest.roomId) : undefined;
            if (!room || room.expiresAt > now) {
              this.cleanup.delete(id);
              continue;
            }
          }
          await this.db.remove(id);
          this.cleanup.delete(id);
          this.deleteCached(id);
        } catch (error) {
          this.failed(error);
          break;
        }
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.sweeping = false;
      this.changed();
    }
  }

  visibleMessages(roomId: string, now: number) {
    const source = this.activeRoom === roomId ? this.roomMessages : this.messages;
    return [...source.values()]
      .filter(
        (m) => m.roomId === roomId && this.authorAllowed(m) && isVisibleMessage(m, this.rooms, now),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  participants(roomId: string | undefined, now: number) {
    return new Set(
      [...this.presence.values()]
        .filter(
          (p) =>
            this.authorAllowed(p) &&
            p.expiresAt > now &&
            (roomId === undefined || p.roomId === roomId),
        )
        .map((p) => p.authorId),
    ).size;
  }

  readers(message: MessageRecord, now: number) {
    const readers = new Map<string, ReceiptRecord>();
    for (const receipt of this.receipts.values()) {
      if (
        !this.authorAllowed(receipt) ||
        receipt.messageId !== message.id ||
        receipt.roomId !== message.roomId ||
        receipt.expiresAt !== message.expiresAt ||
        receipt.createdAt < message.createdAt ||
        receipt.expiresAt <= now ||
        receipt.authorId === message.authorId
      )
        continue;
      const old = readers.get(receipt.authorId);
      if (!old || receipt.createdAt < old.createdAt) readers.set(receipt.authorId, receipt);
    }
    return [...readers.values()].sort((a, b) => a.authorName.localeCompare(b.authorName, 'hu'));
  }

  stop() {
    this.stopped = true;
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.roomGeneration++;
    this.unsubscribe?.();
    this.unsubscribeRoom?.();
  }
}
