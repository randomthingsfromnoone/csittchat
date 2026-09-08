export const ROOM_TTL = 6 * 60 * 60 * 1000;
export const MESSAGE_TTL = 30 * 60 * 1000;
export const PRESENCE_TTL = 90 * 1000;
export const CLOCK_SKEW = 2 * 60 * 1000;
const EARLIEST = Date.UTC(2025, 0, 1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const isRoomId = (value: unknown): value is string => value === 'main' || isUuid(value);

export interface RoomRecord {
  kind: 'room'; id: string; title: string; creator: string;
  createdAt: number; expiresAt: number; lastActivityAt: number;
}
export interface MessageRecord {
  kind: 'message'; id: string; roomId: string; authorId: string;
  authorName: string; text: string; createdAt: number; expiresAt: number;
}
export interface PresenceRecord {
  kind: 'presence'; id: string; roomId: string | null; authorId: string;
  createdAt: number; expiresAt: number;
}
export type RecordValue = RoomRecord | MessageRecord | PresenceRecord;
export const nodeId = (value: RecordValue) => `${value.kind}:${value.id}`;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function validText(value: unknown, max: number, multiline = false): value is string {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0 &&
    !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value);
}

// Exact keys prevent a small visible string from smuggling a huge hidden object.
export function parseRecord(id: unknown, value: unknown, now = Date.now()): RecordValue | null {
  if (typeof id !== 'string' || id.length > 50 || !plain(value) || !isUuid(value.id)) return null;
  const { kind, createdAt, expiresAt } = value;
  if (kind !== 'room' && kind !== 'message' && kind !== 'presence') return null;
  if (id !== `${kind}:${value.id}`) return null;
  const keys = kind === 'room'
    ? ['kind', 'id', 'title', 'creator', 'createdAt', 'expiresAt', 'lastActivityAt']
    : kind === 'message'
      ? ['kind', 'id', 'roomId', 'authorId', 'authorName', 'text', 'createdAt', 'expiresAt']
      : ['kind', 'id', 'roomId', 'authorId', 'createdAt', 'expiresAt'];
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return null;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < EARLIEST || createdAt > now + CLOCK_SKEW) return null;
  const ttl = kind === 'room' ? ROOM_TTL : kind === 'message' ? MESSAGE_TTL : PRESENCE_TTL;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt !== createdAt + ttl) return null;
  if (kind === 'room') {
    if (!validText(value.title, 100) || !isUuid(value.creator) || value.lastActivityAt !== createdAt) return null;
  } else {
    if (!isUuid(value.authorId) || !(isRoomId(value.roomId) || (kind === 'presence' && value.roomId === null))) return null;
    if (kind === 'message' && (!validText(value.authorName, 40) || !validText(value.text, 2000, true) || new TextEncoder().encode(value.text).length > 8000)) return null;
  }
  return value as unknown as RecordValue;
}

export function isVisibleMessage(message: MessageRecord, rooms: Map<string, RoomRecord>, now: number): boolean {
  if (message.expiresAt <= now) return false;
  if (message.roomId === 'main') return true;
  const room = rooms.get(message.roomId);
  return !!room && room.expiresAt > now && message.createdAt >= room.createdAt && message.createdAt < room.expiresAt;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} mp`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} perc`;
  return `${Math.floor(minutes / 60)} óra${minutes % 60 ? ` ${minutes % 60} perc` : ''}`;
}
