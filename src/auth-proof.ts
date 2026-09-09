import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  parseRecord,
  normalizeName,
  nameKey,
  PERMANENT_PROFILE_EXPIRY,
  PRESENCE_TTL,
  MESSAGE_TTL,
  type ProfileRecord,
  type RecordValue,
} from './model.ts';
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const unhex = (value: string) =>
  Uint8Array.from(value.match(/.{2}/g) || [], (b) => parseInt(b, 16));
export const bytes = (value: string) => new TextEncoder().encode(value);
export function profileId(publicKey: string) {
  const hash = sha256(unhex(publicKey)).slice(0, 16);
  hash[6] = (hash[6] & 15) | 64;
  hash[8] = (hash[8] & 63) | 128;
  const value = hex(hash);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function payload(value: RecordValue) {
  return bytes(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== 'signature')
          .sort(([a], [b]) => a.localeCompare(b, 'en')),
      ),
    ),
  );
}
export function createProfile(
  secret: string,
  name: string,
  permanent: boolean,
  now = Date.now(),
  createdAt = now,
): ProfileRecord {
  const publicKey = hex(ed25519.getPublicKey(unhex(secret)));
  const profile: ProfileRecord = {
    kind: 'profile',
    id: profileId(publicKey),
    name: normalizeName(name),
    nameKey: nameKey(name),
    publicKey,
    permanent,
    createdAt,
    updatedAt: now,
    expiresAt: permanent ? PERMANENT_PROFILE_EXPIRY : now + PRESENCE_TTL + MESSAGE_TTL,
    signature: '',
  };
  return { ...profile, signature: hex(ed25519.sign(payload(profile), unhex(secret))) };
}
export function verifyProfile(value: unknown, now = Date.now()): value is ProfileRecord {
  try {
    const profile = value as ProfileRecord;
    return (
      !!parseRecord(`profile:${profile.id}`, profile, now) &&
      profile.id === profileId(profile.publicKey) &&
      ed25519.verify(unhex(profile.signature), payload(profile), unhex(profile.publicKey))
    );
  } catch {
    return false;
  }
}
export function recordProfile(value: RecordValue): ProfileRecord | null {
  if (value.kind === 'room' || value.kind === 'profile') return null;
  try {
    const profile = JSON.parse(value.profile || 'null');
    return verifyProfile(profile) ? profile : null;
  } catch {
    return null;
  }
}
export function signRecord<T extends RecordValue>(
  record: T,
  profile: ProfileRecord,
  secret: string,
): T {
  const value = { ...record, profile: JSON.stringify(profile) };
  return { ...value, signature: hex(ed25519.sign(payload(value), unhex(secret))) };
}
export function verifyRecord(value: RecordValue): boolean {
  if (value.kind === 'room') return true;
  if (value.kind === 'profile') return verifyProfile(value);
  try {
    const profile = recordProfile(value);
    return (
      !!profile &&
      value.authorId === profile.id &&
      value.authorName === profile.name &&
      value.createdAt >= profile.updatedAt &&
      (profile.permanent || value.createdAt < profile.updatedAt + PRESENCE_TTL) &&
      !!value.signature &&
      ed25519.verify(unhex(value.signature), payload(value), unhex(profile.publicKey))
    );
  } catch {
    return false;
  }
}
