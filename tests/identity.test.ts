import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GDB, MapEvent } from 'genosdb';
import { ChatStore } from '../src/store.ts';
import { createProfile, hex, verifyRecord } from '../src/auth-proof.ts';
import { newWords, secretFromWords, openIdentity } from '../src/identity.ts';
import {
  nameOwner,
  nameKey,
  nodeId,
  PRESENCE_TTL,
  PERMANENT_PROFILE_EXPIRY,
  parseRecord,
  type RecordValue,
} from '../src/model.ts';
const secret = () => hex(crypto.getRandomValues(new Uint8Array(32)));
function fixture() {
  const graph = new Map<string, RecordValue>();
  let receive: ((event: MapEvent) => void) | undefined;
  const db = {
    async get(id: string) {
      return { result: graph.has(id) ? { id, value: graph.get(id) } : null };
    },
    async map(options: any, callback?: (event: MapEvent) => void) {
      const records = [...graph.values()]
        .filter(
          (value) =>
            !options.query?.kind ||
            value.kind === options.query.kind ||
            options.query.kind.$in?.includes(value.kind),
        )
        .filter(
          (value) =>
            !options.query?.nameKey ||
            (value.kind === 'profile' && value.nameKey === options.query.nameKey),
        )
        .filter(
          (value) =>
            options.query?.expiresAt?.$lte === undefined ||
            value.expiresAt <= options.query.expiresAt.$lte,
        )
        .filter(
          (value) =>
            options.query?.expiresAt?.$gt === undefined ||
            value.expiresAt > options.query.expiresAt.$gt,
        );
      if (callback) {
        receive = callback;
        for (const value of records)
          callback({
            id: nodeId(value),
            value,
            action: 'initial',
            timestamp: Date.now(),
            edges: [],
          });
      }
      return {
        results: records.map((value) => ({ id: nodeId(value), value })),
        unsubscribe() {
          receive = undefined;
        },
      };
    },
    async put(value: RecordValue, id: string) {
      graph.set(id, value);
      receive?.({ id, value, action: 'updated', timestamp: Date.now(), edges: [] });
      return id;
    },
    async remove(id: string) {
      graph.delete(id);
      receive?.({ id, value: null, action: 'removed', timestamp: Date.now(), edges: [] });
    },
  };
  return {
    graph,
    db,
    store: () =>
      new ChatStore(
        db as unknown as GDB,
        () => {},
        (error) => {
          throw error;
        },
        verifyRecord,
      ),
  };
}

test('P2P registration rejects known names and restores a persistent account from its words', async () => {
  const f = fixture();
  const store = f.store();
  await store.start();
  const words = newWords();
  const owner = await secretFromWords(words);
  const identity = await openIdentity(store, owner, '  Árvíz   TŰRŐ  ', true, 'register');
  assert.equal(identity.name, 'Árvíz TŰRŐ');
  await assert.rejects(openIdentity(store, secret(), 'árvíz tűrő', false, 'register'), /foglalt/);
  store.stop();
  const reloaded = f.store();
  await reloaded.start();
  const restored = await openIdentity(reloaded, await secretFromWords(words));
  assert.equal(restored.id, identity.id);
  assert.equal(restored.profile.signature, identity.profile.signature);
  await reloaded.sweep(Date.now() + 365 * 24 * 60 * 60 * 1000);
  assert.equal(f.graph.get(`profile:${identity.id}`)?.expiresAt, PERMANENT_PROFILE_EXPIRY);
  reloaded.stop();
});

test('all peers resolve simultaneous name claims in the same order; expired guests release the name', () => {
  const now = Date.now();
  const a = createProfile(secret(), 'Name', false, now);
  const b = createProfile(secret(), 'name', true, now);
  const expected = [a, b].sort((x, y) => x.id.localeCompare(y.id))[0];
  assert.equal(nameOwner([a, b], nameKey('NAME'), now)?.id, expected.id);
  assert.equal(nameOwner([b, a], nameKey('NAME'), now)?.id, expected.id);
  assert.equal(nameOwner([a, b], nameKey('NAME'), now + PRESENCE_TTL)?.id, b.id);
  assert.equal(nameOwner([b], nameKey('NAME'), now + 10000000)?.id, b.id);
  assert.equal(parseRecord(nodeId(b), { ...b, expiresAt: b.createdAt + 1000 }), null);
});

test('renewal keeps an active guest claim but reclaiming after a gap gets a new start time', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const store = f.store();
  await store.start();
  const key = secret();
  const original = createProfile(key, 'Guest', false, now - PRESENCE_TTL);
  await f.db.put(original, nodeId(original));
  const renewed = await openIdentity(store, key, '', false, 'login');
  assert.equal(renewed.profile.createdAt, now);
  assert.equal(nameOwner(store.profiles.values(), nameKey('Guest'), now)?.id, original.id);
  store.stop();
});

test('a replayed guest heartbeat cannot shorten the persisted name lease', async () => {
  const f = fixture();
  const store = f.store();
  await store.start();
  const key = secret();
  const now = Date.now();
  const old = createProfile(key, 'Guest', false, now - 50000);
  const latest = createProfile(key, 'Guest', false, now, old.createdAt);
  await f.db.put(latest, nodeId(latest));
  await f.db.put(old, nodeId(old));
  await store.sweep();
  assert.equal((f.graph.get(nodeId(latest)) as typeof latest).updatedAt, latest.updatedAt);
  store.stop();
  const reloaded = f.store();
  await reloaded.start();
  assert.equal(reloaded.profiles.get(latest.id)?.updatedAt, latest.updatedAt);
  reloaded.stop();
});
