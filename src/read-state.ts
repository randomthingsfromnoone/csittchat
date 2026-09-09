import { isUuid, type MessageRecord } from './model.ts';
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function unreadLabel(count: number) {
  return count > 99 ? '99+' : String(count);
}
export class ReadState {
  private read = new Map<string, number>();
  private key: string;
  private storage?: StorageLike;
  constructor(key: string, storage?: StorageLike) {
    this.key = key;
    this.storage = storage;
    this.merge();
  }
  merge() {
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(this.key) || '[]');
      if (Array.isArray(saved))
        for (const item of saved.slice(-10000)) {
          if (
            Array.isArray(item) &&
            isUuid(item[0]) &&
            Number.isSafeInteger(item[1]) &&
            item[1] > Date.now()
          )
            this.read.set(item[0], item[1]);
        }
    } catch {
      /* A blocked or damaged local store falls back to this tab. */
    }
  }
  has(message: MessageRecord) {
    return this.read.get(message.id) === message.expiresAt;
  }
  mark(messages: MessageRecord[], now = Date.now()) {
    this.merge();
    for (const message of messages)
      if (message.expiresAt > now) this.read.set(message.id, message.expiresAt);
    for (const [id, expiresAt] of this.read) if (expiresAt <= now) this.read.delete(id);
    while (this.read.size > 10000) this.read.delete(this.read.keys().next().value!);
    try {
      this.storage?.setItem(this.key, JSON.stringify([...this.read]));
    } catch {
      /* Reading still works in memory. */
    }
  }
  unread(messages: MessageRecord[], authorId: string) {
    return messages.filter((m) => m.authorId !== authorId && !this.has(m)).length;
  }
}
