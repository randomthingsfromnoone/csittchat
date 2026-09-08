import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GDB, MapEvent } from 'genosdb';
import { ChatStore } from '../src/store.ts';
import { MESSAGE_TTL, ROOM_TTL, nodeId, type MessageRecord, type RoomRecord } from '../src/model.ts';

test('cleanup removes expired nodes, retries failures, and does not depend on current room', async () => {
  const now = Date.now();
  const room: RoomRecord = { kind: 'room', id: crypto.randomUUID(), creator: crypto.randomUUID(), title: 'A room', createdAt: now, expiresAt: now + ROOM_TTL, lastActivityAt: now };
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: room.id, authorId: room.creator, authorName: 'Alice', text: 'hello', createdAt: now, expiresAt: now + MESSAGE_TTL };
  let receive: (e: MapEvent) => void = () => {};
  const removed: string[] = [];
  let failOnce = true;
  let failures = 0;
  let unsubscribed = false;
  const db = {
    async map(_: unknown, callback?: (e: MapEvent) => void) { if (callback) receive = callback; return { results: [], unsubscribe: () => { unsubscribed = true; } }; },
    async remove(id: string) { if (failOnce) { failOnce = false; throw new Error('disk failure'); } removed.push(id); },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => { failures++; });
  await store.start();
  const emit = (value: RoomRecord | MessageRecord) => receive({ id: nodeId(value), value, action: 'added', timestamp: now, edges: [] });
  emit(room); emit(message); emit(message);
  assert.equal(store.messages.size, 1);
  emit({ ...message, text: 'mutated replay' });
  assert.equal(store.messages.get(message.id)?.text, 'hello');
  await store.sweep(now + MESSAGE_TTL);
  assert.equal(failures, 1);
  assert.equal(store.visibleMessages(room.id, now + MESSAGE_TTL).length, 0);
  await store.sweep(now + MESSAGE_TTL);
  assert.deepEqual(removed, [nodeId(message)]);
  assert.equal(store.messages.size, 0);
  await store.sweep(now + ROOM_TTL);
  assert.deepEqual(removed, [nodeId(message), nodeId(room)]);
  assert.equal(store.rooms.size, 0);
  store.stop(); assert.equal(unsubscribed, true);
});

test('already expired records arriving from offline peers are hidden and removed', async () => {
  const now = Date.now() - MESSAGE_TTL - 1000;
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: 'main', authorId: crypto.randomUUID(), authorName: 'Alice', text: 'stale', createdAt: now, expiresAt: now + MESSAGE_TTL };
  const removed: string[] = [];
  const db = {
    async map(_: unknown, callback?: (e: MapEvent) => void) { callback?.({ id: nodeId(message), value: message, action: 'initial', timestamp: now, edges: [] }); return { results: [] }; },
    async remove(id: string) { removed.push(id); },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => {});
  await store.start();
  assert.equal(store.messages.size, 0);
  assert.deepEqual(removed, [nodeId(message)]);
});

test('storage scan cleans records not held in the UI cache', async () => {
  const now = Date.now() - MESSAGE_TTL - 1000;
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: 'main', authorId: crypto.randomUUID(), authorName: 'Alice', text: 'outside cache', createdAt: now, expiresAt: now + MESSAGE_TTL };
  const removed: string[] = [];
  const db = {
    async map(_: unknown, callback?: unknown) { return { results: callback ? [] : [{ id: nodeId(message), value: message }] }; },
    async remove(id: string) { removed.push(id); },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => {});
  await store.start();
  assert.equal(store.messages.size, 0);
  assert.deepEqual(removed, [nodeId(message)]);
});

test('room history reads the graph even when the global cache has no message', async () => {
  const now = Date.now();
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: 'main', authorId: crypto.randomUUID(), authorName: 'Alice', text: 'existing history', createdAt: now, expiresAt: now + MESSAGE_TTL };
  let receive: (e: MapEvent) => void = () => {};
  const db = {
    async map(options: { query?: { roomId?: string } }, callback?: (e: MapEvent) => void) {
      if (options.query?.roomId === 'main') {
        receive = callback!;
        return { results: [{ id: nodeId(message), value: message }], unsubscribe() {} };
      }
      return { results: [] };
    },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => {});
  await store.start();
  assert.equal(store.messages.size, 0);
  await store.watchRoom('main');
  assert.equal(store.historyState, 'ready');
  assert.deepEqual(store.visibleMessages('main', now), [message]);
  receive({ id: nodeId(message), value: null, action: 'removed', timestamp: now, edges: [] });
  assert.deepEqual(store.visibleMessages('main', now), []);
});

test('switching rooms discards late snapshots and unsubscribes old history', async () => {
  const now = Date.now();
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: 'main', authorId: crypto.randomUUID(), authorName: 'Alice', text: 'old room history', createdAt: now, expiresAt: now + MESSAGE_TTL };
  let resolveOld: (value: unknown) => void = () => {};
  let unsubscribed = false;
  const db = {
    async map() { return new Promise(resolve => { resolveOld = resolve; }); },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => {});
  const pending = store.watchRoom('main');
  await store.watchRoom(null);
  resolveOld({ results: [{ id: nodeId(message), value: message }], unsubscribe() { unsubscribed = true; } });
  await pending;
  assert.equal(unsubscribed, true);
  assert.equal(store.historyState, 'ready');
  assert.deepEqual(store.visibleMessages('main', now), []);
});

test('history recovery forwards existing records without extending TTL or resurrecting deletions', async () => {
  const now = Date.now();
  const room: RoomRecord = { kind: 'room', id: crypto.randomUUID(), creator: crypto.randomUUID(), title: 'Existing room', createdAt: now, expiresAt: now + ROOM_TTL, lastActivityAt: now };
  const message: MessageRecord = { kind: 'message', id: crypto.randomUUID(), roomId: room.id, authorId: room.creator, authorName: 'Gone author', text: 'Held by another participant', createdAt: now, expiresAt: now + MESSAGE_TTL };
  const deleted = { ...message, id: crypto.randomUUID() };
  const expired = { ...message, id: crypto.randomUUID(), createdAt: now - MESSAGE_TTL, expiresAt: now };
  const unknownRoom = { ...message, id: crypto.randomUUID(), roomId: crypto.randomUUID() };
  const invalid = { ...message, id: crypto.randomUUID(), text: 'x'.repeat(2001) };
  const records = [room, message, deleted, expired, unknownRoom, invalid];
  const graph = new Map(records.filter(r => r !== deleted).map(r => [nodeId(r), r]));
  const delivered = new Map<string, unknown>();
  const db = {
    async map(options: { query: { kind: string } }) {
      return { results: records.filter(r => r.kind === options.query.kind).map(value => ({ id: nodeId(value), value })) };
    },
    async get(id: string) { return { result: graph.has(id) ? { id, value: graph.get(id) } : null }; },
    async put(value: unknown, id: string) { delivered.set(id, structuredClone(value)); return id; },
  } as unknown as GDB;
  const store = new ChatStore(db, () => {}, () => {});
  await store.republishHistory();
  await store.republishHistory();
  assert.deepEqual([...delivered.entries()], [[nodeId(room), room], [nodeId(message), message]]);
  store.stop();
  delivered.clear();
  await store.republishHistory();
  assert.equal(delivered.size, 0);
});

test('peer joins coalesce into two recovery attempts and stop cancels pending work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = new ChatStore({} as GDB, () => {}, () => {});
  const replay = t.mock.method(store, 'republishHistory', async () => {});
  store.scheduleHistoryRecovery();
  t.mock.timers.tick(1000);
  store.scheduleHistoryRecovery();
  t.mock.timers.tick(4999);
  assert.equal(replay.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.equal(replay.mock.callCount(), 1);
  t.mock.timers.tick(15000);
  assert.equal(replay.mock.callCount(), 2);
  t.mock.timers.tick(60000);
  assert.equal(replay.mock.callCount(), 2);
  store.scheduleHistoryRecovery();
  store.stop();
  t.mock.timers.tick(60000);
  assert.equal(replay.mock.callCount(), 2);
});
