import type { GDB, gdb as GdbFactory } from 'genosdb';
import { ChatStore } from './store';
import {
  isRoomId,
  MESSAGE_TTL,
  PRESENCE_TTL,
  ROOM_TTL,
  validText,
  nameOwner,
  nameKey,
  profileOwnsName,
  type MessageRecord,
  type RecordValue,
} from './model';
import {
  forgetIdentity,
  openIdentity,
  savedIdentity,
  saveIdentity,
  assertNameAvailable,
  type Identity,
  type User,
} from './identity';
import { createProfile, signRecord, verifyRecord } from './auth-proof';
import { ReadState } from './read-state';

export class ChatClient {
  identity: Identity | null = null;
  get users(): User[] {
    if (!this.store) return [];
    const profiles = this.store.profiles;
    const online = new Set(
      [...(this.store?.presence.values() || [])]
        .filter((p) => p.expiresAt > this.now)
        .map((p) => p.authorId),
    );
    return [...profiles.values()]
      .filter(
        (p) =>
          profileOwnsName(p, this.now) &&
          nameOwner(profiles.values(), p.nameKey, this.now)?.id === p.id,
      )
      .map((p) => ({ id: p.id, name: p.name, permanent: p.permanent, online: online.has(p.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'hu'));
  }
  store?: ChatStore;
  selected: string | null = null;
  notice = '';
  starting = false;
  initialized = false;
  busy = false;
  roomEnteredAt = Date.now();
  now = Date.now();
  read?: ReadState;
  readonly drafts = new Map<string, string>();
  private revision = 0;
  private listeners = new Set<() => void>();
  private sessionId = crypto.randomUUID();
  private lastWrite = 0;
  private refreshing = false;
  private receiptQueue = new Map<string, MessageRecord>();
  private postingReceipts = false;
  private startPromise?: Promise<void>;
  private cleanup: (() => void)[] = [];
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.revision;
  changed = () => {
    if (this.identity && this.store) {
      const winner = nameOwner(
        this.store.profiles.values(),
        nameKey(this.identity.name),
        Date.now(),
      );
      if (winner && winner.id !== this.identity.id) {
        this.identity = null;
        this.read = undefined;
        this.receiptQueue.clear();
        forgetIdentity();
        this.notice = 'Szinkronizáláskor korábbi névfoglalás érkezett. Válassz másik becenevet.';
      }
    }
    this.revision++;
    this.listeners.forEach((listener) => listener());
  };
  fail = (error: unknown) => {
    this.notice = error instanceof Error ? error.message : 'Nem sikerült a művelet. Próbáld újra.';
    this.changed();
  };
  get canWrite() {
    return (
      !!this.identity &&
      !!this.store &&
      profileOwnsName(this.identity.profile, Date.now()) &&
      nameOwner(this.store.profiles.values(), this.identity.profile.nameKey, Date.now())?.id ===
        this.identity.id
    );
  }
  get available() {
    return (
      this.selected === 'main' ||
      (!!this.selected && (this.store?.rooms.get(this.selected)?.expiresAt || 0) > this.now)
    );
  }
  get messages() {
    return this.selected && this.available
      ? this.store?.visibleMessages(this.selected, this.now) || []
      : [];
  }
  unread(roomId: string) {
    return this.read && this.identity
      ? this.read.unread(this.store?.visibleMessages(roomId, this.now) || [], this.identity.id)
      : 0;
  }
  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.navigate();
    const listen = (target: Window | Document, event: string, fn: () => void) => {
      target.addEventListener(event, fn);
      this.cleanup.push(() => target.removeEventListener(event, fn));
    };
    listen(window, 'hashchange', this.navigate);
    listen(window, 'storage', () => {
      this.read?.merge();
      this.changed();
    });
    listen(window, 'online', () => {
      void this.refreshIdentity();
      this.store?.scheduleHistoryRecovery();
    });
    listen(window, 'offline', this.changed);
    listen(document, 'visibilitychange', () => {
      if (!document.hidden) {
        void this.refreshIdentity();
        void this.store?.watchRoom(this.selected);
        this.store?.scheduleHistoryRecovery();
      }
    });
    const tick = setInterval(() => {
      this.now = Date.now();
      this.changed();
      void this.store?.sweep();
      void this.flushReceipts();
    }, 1000);
    const heartbeat = setInterval(() => void this.refreshIdentity(), 25000);
    this.cleanup.push(() => {
      clearInterval(tick);
      clearInterval(heartbeat);
    });
    const saved = savedIdentity();
    this.starting = true;
    this.changed();
    void this.start()
      .then(async () => {
        if (saved)
          await this.enter(
            await openIdentity(this.store!, saved.secret, '', false, 'login', saved.profile),
          );
      })
      .catch(this.fail)
      .finally(() => {
        this.starting = false;
        this.changed();
      });
  }
  async login(secret: string, name: string, permanent: boolean, action: string) {
    await this.start();
    await this.enter(await openIdentity(this.store!, secret, name, permanent, action));
  }

  async enter(identity: Identity) {
    this.identity = identity;
    let storage: Storage | undefined;
    try {
      storage = localStorage;
    } catch {}
    this.read = new ReadState(
      `csittchat.read.v1:${import.meta.env.VITE_CHAT_NETWORK || 'ephemeral-pub-v3'}:${identity.id}`,
      storage,
    );
    this.notice = '';
    this.changed();
    await this.start();
    await this.refreshUsers();
    await this.heartbeat();
  }
  private start() {
    return (this.startPromise ??= this.connect().catch((error) => {
      this.startPromise = undefined;
      this.fail(error);
      throw error;
    }));
  }
  private async connect() {
    const url = new URL('./vendor/genosdb/index.js', document.baseURI).href;
    const { gdb } = (await import(/* @vite-ignore */ url)) as { gdb: typeof GdbFactory };
    const relayUrls = (import.meta.env.VITE_CHAT_RELAYS || '')
      .split(',')
      .map((url: string) => url.trim())
      .filter(Boolean);
    if (
      relayUrls.some(
        (url: string) =>
          !/^wss:\/\//.test(url) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url),
      )
    )
      throw new Error('A relayhez wss:// cím szükséges.');
    const db: GDB = await gdb(import.meta.env.VITE_CHAT_NETWORK || 'ephemeral-pub-v3', {
      rtc: { cells: true, ...(relayUrls.length ? { relayUrls } : {}) },
      debug: import.meta.env.VITE_GDB_DEBUG === '1',
    });
    this.store = new ChatStore(db, this.changed, this.fail, verifyRecord);
    await this.store.start();
    for (const event of ['peer:leave', 'mesh:state']) db.room?.on(event, this.changed);
    db.room?.on('peer:join', () => {
      this.changed();
      this.store?.scheduleHistoryRecovery();
      void this.store?.watchRoom(this.selected);
    });
    if (db.room && Object.keys(db.room.getPeers()).length) this.store.scheduleHistoryRecovery();
    await this.store.watchRoom(this.selected);
    this.changed();
  }
  async refreshUsers() {
    if (!this.store) return;
    try {
      const { results } = await this.store.db.map({ query: { kind: 'profile' }, $limit: 10000 });
      for (const { value } of results) {
        if (value?.kind === 'profile') this.store.acceptProfile(value);
      }
      this.changed();
    } catch (error) {
      this.fail(error);
    }
  }

  private async refreshIdentity() {
    if (!this.identity || this.refreshing) return;
    this.refreshing = true;
    try {
      const identity = this.identity;
      if (!this.store) await this.start();
      await assertNameAvailable(this.store!, identity.profile);
      if (this.identity !== identity) return;
      if (!identity.permanent) {
        const now = Date.now();
        identity.profile = createProfile(
          identity.secret,
          identity.name,
          false,
          now,
          profileOwnsName(identity.profile, now) ? identity.profile.createdAt : now,
        );
      }
      await this.store!.put(identity.profile);
      this.store!.acceptProfile(identity.profile);
      if (this.identity !== identity) return;
      saveIdentity(identity);
      this.notice = '';
      if (!this.store) await this.start();
      await this.heartbeat();
      await this.refreshUsers();
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
      this.changed();
    }
  }
  private signed<T extends RecordValue>(value: T): T {
    if (!this.identity || !profileOwnsName(this.identity.profile, value.createdAt))
      throw new Error('A névfoglalás lejárt. Kapcsolódj újra a belépéshez.');
    return signRecord(value, this.identity.profile, this.identity.secret);
  }
  private timestamp() {
    return Math.max(Date.now(), this.identity?.profile.updatedAt || 0);
  }
  private async heartbeat() {
    if (!this.store || !this.identity || !this.canWrite) return;
    const now = this.timestamp();
    await this.store.put(
      this.signed({
        kind: 'presence',
        id: this.sessionId,
        roomId: this.selected,
        authorId: this.identity.id,
        authorName: this.identity.name,
        createdAt: now,
        expiresAt: now + PRESENCE_TTL,
      }),
    );
  }
  navigate = () => {
    const id = location.hash.startsWith('#room/') ? location.hash.slice(6) : null;
    this.selected = isRoomId(id) ? id : null;
    this.roomEnteredAt = Date.now();
    this.changed();
    void this.store?.watchRoom(this.selected);
    void this.heartbeat().catch(this.fail);
  };
  async createRoom(title: string) {
    if (!this.canWrite || !this.identity || !this.store)
      throw new Error('A belépés még nem áll készen.');
    title = title.trim();
    if (!validText(title, 100))
      throw new Error('Adj meg 1–100 karakteres szobanevet, vezérlőkarakterek nélkül.');
    const now = this.timestamp();
    const id = crypto.randomUUID();
    await this.store.put({
      kind: 'room',
      id,
      title,
      creator: this.identity.id,
      createdAt: now,
      expiresAt: now + ROOM_TTL,
      lastActivityAt: now,
    });
    location.hash = `room/${id}`;
  }
  async send() {
    if (
      !this.canWrite ||
      !this.store ||
      !this.identity ||
      !this.selected ||
      !this.available ||
      this.busy
    )
      return;
    const roomId = this.selected;
    const text = (this.drafts.get(roomId) || '').trim();
    const now = this.timestamp();
    if (!validText(text, 2000, true)) {
      this.fail(new Error('Írj 1–2000 karakteres üzenetet, vezérlőkarakterek nélkül.'));
      return;
    }
    if (now - this.lastWrite < 750) {
      this.fail(new Error('Várj egy pillanatot a következő üzenet előtt.'));
      return;
    }
    const draft = this.drafts.get(roomId);
    this.busy = true;
    this.changed();
    try {
      await this.store.put(
        this.signed({
          kind: 'message',
          id: crypto.randomUUID(),
          roomId,
          authorId: this.identity.id,
          authorName: this.identity.name,
          text,
          createdAt: now,
          expiresAt: now + MESSAGE_TTL,
        }),
      );
      this.lastWrite = now;
      if (this.drafts.get(roomId) === draft) this.drafts.delete(roomId);
      this.notice = '';
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy = false;
      this.changed();
    }
  }
  markRead(messages: MessageRecord[]) {
    if (!this.identity || !this.read) return;
    const unread = messages.filter((message) => !this.read!.has(message));
    if (unread.length) this.read.mark(unread);
    // A failed receipt can be retried after reload even if the local read bit was saved.
    for (const message of messages)
      if (
        message.authorId !== this.identity.id &&
        !this.store
          ?.readers(message, Date.now())
          .some((receipt) => receipt.authorId === this.identity!.id)
      )
        this.receiptQueue.set(message.id, message);
    if (unread.length) this.changed();
    void this.flushReceipts();
  }
  private async flushReceipts() {
    if (!this.canWrite || !this.identity || !this.store || this.postingReceipts) return;
    this.postingReceipts = true;
    const identity = this.identity;
    try {
      for (const [id, message] of this.receiptQueue) {
        const now = this.timestamp();
        if (message.expiresAt <= now) {
          this.receiptQueue.delete(id);
          continue;
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${identity.id}:${id}`)),
        );
        if (this.identity !== identity || !this.canWrite) return;
        digest[6] = (digest[6] & 15) | 64;
        digest[8] = (digest[8] & 63) | 128;
        const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join(
          '',
        );
        const receiptId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        if (!this.store.receipts.has(receiptId))
          await this.store.put(
            this.signed({
              kind: 'receipt',
              id: receiptId,
              messageId: id,
              roomId: message.roomId,
              authorId: this.identity.id,
              authorName: this.identity.name,
              createdAt: now,
              expiresAt: message.expiresAt,
            }),
          );
        this.receiptQueue.delete(id);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.postingReceipts = false;
    }
  }
  logout() {
    forgetIdentity();
    // Reload discards session keys, subscriptions and any in-memory account data.
    location.reload();
  }
}
export const client = new ChatClient();
