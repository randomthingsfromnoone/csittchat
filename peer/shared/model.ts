export const ROOM_TTL = 6 * 60 * 60 * 1000;
export const MESSAGE_TTL = 30 * 60 * 1000;
export const PRESENCE_TTL = 90 * 1000;
export const CLOCK_SKEW = 2 * 60 * 1000;
const EARLIEST = Date.UTC(2025, 0, 1);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const isRoomId = (value: unknown): value is string => value === 'main' || isUuid(value);

export interface RoomRecord {
  kind: 'room';
  id: string;
  title: string;
  creator: string;
  createdAt: number;
  expiresAt: number;
  lastActivityAt: number;
}
interface SignedRecord {
  profile?: string;
  signature?: string;
}
export interface ProfileRecord {
  kind: 'profile';
  id: string;
  name: string;
  nameKey: string;
  publicKey: string;
  permanent: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  signature: string;
}
export const PERMANENT_PROFILE_EXPIRY = Number.MAX_SAFE_INTEGER;
export function normalizeName(value: string): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new Error('Adj meg 1–40 látható karakteres becenevet.');
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!validText(name, 40)) throw new Error('Adj meg 1–40 látható karakteres becenevet.');
  return name;
}
export const nameKey = (name: string) => normalizeName(name).toLocaleLowerCase('hu-HU');
export function profileOwnsName(profile: ProfileRecord, now: number) {
  return profile.createdAt <= now && (profile.permanent || profile.updatedAt + PRESENCE_TTL > now);
}
export function nameOwner(
  profiles: Iterable<ProfileRecord>,
  key: string,
  now: number,
): ProfileRecord | undefined {
  return [...profiles]
    .filter((p) => p.nameKey === key && profileOwnsName(p, now))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}
export interface MessageRecord extends SignedRecord {
  kind: 'message';
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  text: string;
  createdAt: number;
  expiresAt: number;
}
export interface PresenceRecord extends SignedRecord {
  kind: 'presence';
  id: string;
  roomId: string | null;
  authorId: string;
  authorName?: string;
  createdAt: number;
  expiresAt: number;
}
export interface ReceiptRecord extends SignedRecord {
  kind: 'receipt';
  id: string;
  messageId: string;
  roomId: string;
  authorId: string;
  authorName: string;
  createdAt: number;
  expiresAt: number;
}
export type RecordValue =
  RoomRecord | MessageRecord | PresenceRecord | ReceiptRecord | ProfileRecord;
export const nodeId = (value: RecordValue) => `${value.kind}:${value.id}`;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
export function validText(value: unknown, max: number, multiline = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= max &&
    value.trim().length > 0 &&
    !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(
      value,
    )
  );
}

// Exact keys prevent a small visible string from smuggling a huge hidden object.
export function parseRecord(id: unknown, value: unknown, now = Date.now()): RecordValue | null {
  if (typeof id !== 'string' || id.length > 50 || !plain(value) || !isUuid(value.id)) return null;
  const { kind, createdAt, expiresAt } = value;
  if (kind === 'profile') {
    const keys = [
      'kind',
      'id',
      'name',
      'nameKey',
      'publicKey',
      'permanent',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'signature',
    ];
    if (
      id !== `profile:${value.id}` ||
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      !validText(value.name, 40) ||
      typeof value.publicKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.publicKey) ||
      typeof value.signature !== 'string' ||
      !/^[a-f0-9]{128}$/.test(value.signature) ||
      typeof value.permanent !== 'boolean' ||
      typeof createdAt !== 'number' ||
      !Number.isSafeInteger(createdAt) ||
      createdAt < EARLIEST ||
      createdAt > now + CLOCK_SKEW ||
      typeof value.updatedAt !== 'number' ||
      !Number.isSafeInteger(value.updatedAt) ||
      value.updatedAt < createdAt ||
      value.updatedAt > now + CLOCK_SKEW ||
      (value.permanent
        ? value.updatedAt !== createdAt || expiresAt !== PERMANENT_PROFILE_EXPIRY
        : expiresAt !== value.updatedAt + PRESENCE_TTL + MESSAGE_TTL)
    )
      return null;
    try {
      if (normalizeName(value.name) !== value.name || nameKey(value.name) !== value.nameKey)
        return null;
    } catch {
      return null;
    }
    return value as unknown as ProfileRecord;
  }
  if (kind !== 'room' && kind !== 'message' && kind !== 'presence' && kind !== 'receipt')
    return null;
  if (id !== `${kind}:${value.id}`) return null;
  const keys =
    kind === 'room'
      ? ['kind', 'id', 'title', 'creator', 'createdAt', 'expiresAt', 'lastActivityAt']
      : kind === 'message'
        ? ['kind', 'id', 'roomId', 'authorId', 'authorName', 'text', 'createdAt', 'expiresAt']
        : kind === 'receipt'
          ? [
              'kind',
              'id',
              'messageId',
              'roomId',
              'authorId',
              'authorName',
              'createdAt',
              'expiresAt',
            ]
          : ['kind', 'id', 'roomId', 'authorId', 'createdAt', 'expiresAt'];
  if (kind === 'presence' && Object.hasOwn(value, 'authorName')) {
    if (!validText(value.authorName, 40)) return null;
    keys.push('authorName');
  }
  if (kind !== 'room' && (Object.hasOwn(value, 'profile') || Object.hasOwn(value, 'signature'))) {
    if (
      typeof value.profile !== 'string' ||
      value.profile.length > 1000 ||
      typeof value.signature !== 'string' ||
      !/^[a-f0-9]{128}$/.test(value.signature)
    )
      return null;
    keys.push('profile', 'signature');
  }
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    return null;
  if (
    typeof createdAt !== 'number' ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < EARLIEST ||
    createdAt > now + CLOCK_SKEW
  )
    return null;
  const ttl = kind === 'room' ? ROOM_TTL : kind === 'message' ? MESSAGE_TTL : PRESENCE_TTL;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) return null;
  if (kind === 'room') {
    if (
      !validText(value.title, 100) ||
      !isUuid(value.creator) ||
      typeof value.lastActivityAt !== 'number' ||
      !Number.isSafeInteger(value.lastActivityAt) ||
      value.lastActivityAt < createdAt ||
      value.lastActivityAt > now + CLOCK_SKEW ||
      expiresAt !== value.lastActivityAt + ttl
    )
      return null;
  } else {
    if (kind === 'receipt') {
      if (
        !isUuid(value.messageId) ||
        !validText(value.authorName, 40) ||
        expiresAt <= createdAt ||
        expiresAt > createdAt + MESSAGE_TTL
      )
        return null;
    } else if (expiresAt !== createdAt + ttl) return null;
    if (
      !isUuid(value.authorId) ||
      !(isRoomId(value.roomId) || (kind === 'presence' && value.roomId === null))
    )
      return null;
    if (
      kind === 'message' &&
      (!validText(value.authorName, 40) ||
        !validText(value.text, 2000, true) ||
        new TextEncoder().encode(value.text).length > 8000)
    )
      return null;
  }
  return value as unknown as RecordValue;
}

// Room identity stays immutable; concurrent activity updates only move forward.
export function mergeRoom(previous: RoomRecord, incoming: RoomRecord): RoomRecord {
  if (
    previous.id !== incoming.id ||
    previous.createdAt !== incoming.createdAt ||
    previous.creator !== incoming.creator ||
    previous.title !== incoming.title
  )
    return previous;
  return incoming.lastActivityAt > previous.lastActivityAt ? incoming : previous;
}

export function renewRoom(room: RoomRecord, message: MessageRecord, now = Date.now()): RoomRecord {
  if (
    message.roomId !== room.id ||
    room.expiresAt <= now ||
    message.expiresAt <= now ||
    message.createdAt <= room.lastActivityAt ||
    message.createdAt >= room.expiresAt ||
    message.createdAt > now + CLOCK_SKEW
  )
    return room;
  return { ...room, lastActivityAt: message.createdAt, expiresAt: message.createdAt + ROOM_TTL };
}

export function isVisibleMessage(
  message: MessageRecord,
  rooms: Map<string, RoomRecord>,
  now: number,
): boolean {
  if (message.expiresAt <= now) return false;
  if (message.roomId === 'main') return true;
  const room = rooms.get(message.roomId);
  return (
    !!room &&
    room.expiresAt > now &&
    message.createdAt >= room.createdAt &&
    message.createdAt < room.expiresAt
  );
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} mp`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} perc`;
  return `${Math.floor(minutes / 60)} óra${minutes % 60 ? ` ${minutes % 60} perc` : ''}`;
}
