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
