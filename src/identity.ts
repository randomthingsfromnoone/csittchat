import { generateMnemonic, mnemonicToSeedWebcrypto, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createProfile, hex, unhex, profileId, verifyProfile } from './auth-proof.ts';
import { nameKey, nameOwner, PRESENCE_TTL, type ProfileRecord } from './model.ts';
import type { ChatStore } from './store.ts';
export interface Identity {
  id: string;
  name: string;
  permanent: boolean;
  profile: ProfileRecord;
  secret: string;
}
export interface User {
  id: string;
  name: string;
  permanent: boolean;
  online: boolean;
}
const storageKey = `csittchat.identity.p2p.v1:${import.meta.env?.VITE_CHAT_NETWORK || 'ephemeral-pub-v3'}`;
export const newWords = () => generateMnemonic(wordlist, 128);
export async function secretFromWords(value: string) {
  const words = value.normalize('NFKD').trim().toLowerCase().split(/\s+/).join(' ');
  if (words.split(' ').length !== 12 || !validateMnemonic(words, wordlist))
    throw new Error('A 12 helyreállító szót pontosan, az eredeti sorrendben add meg.');
  const seed = await mnemonicToSeedWebcrypto(words, 'csittchat.identity.v1');
  return hex(seed.slice(0, 32));
}
export const guestSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export function saveIdentity(identity: Identity) {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(identity));
  } catch {
    /* In-memory login remains available. */
  }
}
export function savedIdentity(): Identity | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    return value &&
      /^[a-f0-9]{64}$/.test(value.secret) &&
      verifyProfile(value.profile) &&
      value.id === profileId(hex(ed25519.getPublicKey(unhex(value.secret))))
      ? value
      : null;
  } catch {
    return null;
  }
}
export function forgetIdentity() {
  try {
    sessionStorage.removeItem(storageKey);
  } catch {}
}
export async function lookupProfile(
  store: ChatStore,
  id: string,
): Promise<ProfileRecord | undefined> {
  const { result } = await store.db.get(`profile:${id}`);
  if (result && verifyProfile(result.value)) store.acceptProfile(result.value);
  return store.profiles.get(id);
}
export async function assertNameAvailable(
  store: ChatStore,
  profile: ProfileRecord,
  now = Date.now(),
) {
  const { results } = await store.db.map({ query: { kind: 'profile', nameKey: profile.nameKey } });
  const candidates = results.map(({ value }) => value).filter((value) => verifyProfile(value, now));
  const owner = nameOwner([...candidates, ...store.profiles.values()], profile.nameKey, now);
  if (owner && owner.id !== profile.id)
    throw new Error('Ez a becenév már foglalt. Válassz másikat.');
}
export async function openIdentity(
  store: ChatStore,
  secret: string,
  name = '',
  permanent = false,
  action = 'login',
  fallback?: ProfileRecord,
): Promise<Identity> {
  const id = profileId(hex(ed25519.getPublicKey(unhex(secret))));
  let profile = await lookupProfile(store, id);
  if (!profile && fallback && verifyProfile(fallback) && fallback.id === id) profile = fallback;
  if (!profile && action === 'login') {
    // A new browser may receive the profile only after the mesh handshake/recovery.
    const until = Date.now() + 22000;
    for (let attempt = 0; !profile && attempt < 44 && Date.now() < until; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      profile = await lookupProfile(store, id);
    }
    if (!profile)
      throw new Error(
        'A fiók még nem érkezett meg a hálózatról. Ellenőrizd a szavakat és a kapcsolatot, majd próbáld újra.',
      );
  }
  if (profile) {
    await assertNameAvailable(store, profile);
    if (!profile.permanent) {
      const now = Date.now();
      profile = createProfile(
        secret,
        profile.name,
        false,
        now,
        profile.updatedAt + PRESENCE_TTL > now ? profile.createdAt : now,
      );
    }
  } else {
    profile = createProfile(secret, name, permanent);
    await assertNameAvailable(store, profile);
  }
  await store.put(profile);
  store.acceptProfile(profile);
  const identity = { id, name: profile.name, permanent: profile.permanent, profile, secret };
  // Let near-simultaneous local/remote registrations settle before entering.
  await new Promise((resolve) => setTimeout(resolve, 600));
  const winner = nameOwner(store.profiles.values(), nameKey(profile.name), Date.now());
  if (winner && winner.id !== id)
    throw new Error('Ez a becenév közben foglalttá vált. Válassz másikat.');
  saveIdentity(identity);
  return identity;
}
