import { createHash, createPublicKey, verify } from 'node:crypto';
import { parseRecord, PRESENCE_TTL } from './model.ts';
const key = (value) =>
  createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(value, 'hex').toString('base64url') },
    format: 'jwk',
  });
const payload = (value) =>
  Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => name !== 'signature')
          .sort(([a], [b]) => a.localeCompare(b, 'en')),
      ),
    ),
  );
function profileId(publicKey) {
  const hash = createHash('sha256').update(Buffer.from(publicKey, 'hex')).digest().subarray(0, 16);
  hash[6] = (hash[6] & 15) | 64;
  hash[8] = (hash[8] & 63) | 128;
  const value = hash.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
function verifyProfile(profile) {
  return (
    !!parseRecord(`profile:${profile.id}`, profile) &&
    profile.id === profileId(profile.publicKey) &&
    verify(null, payload(profile), key(profile.publicKey), Buffer.from(profile.signature, 'hex'))
  );
}
export function verifyRecord(record) {
  if (record.kind === 'room') return true;
  try {
    if (record.kind === 'profile') return verifyProfile(record);
    const profile = JSON.parse(record.profile);
    if (
      !verifyProfile(profile) ||
      profile.id !== record.authorId ||
      profile.name !== record.authorName ||
      record.createdAt < profile.updatedAt ||
      (!profile.permanent && record.createdAt >= profile.updatedAt + PRESENCE_TTL)
    )
      return false;
    return verify(
      null,
      payload(record),
      key(profile.publicKey),
      Buffer.from(record.signature, 'hex'),
    );
  } catch {
    return false;
  }
}
