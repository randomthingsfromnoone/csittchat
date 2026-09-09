import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGraph } from '../peer/policy.ts';
import { MESSAGE_TTL, PRESENCE_TTL, ROOM_TTL, nodeId } from '../peer/shared/model.ts';

test('removes invalid and expired data and messages in expired rooms, preserves live IDs and TTL', async () => {
  const now = Date.now();
  const authorId = crypto.randomUUID();
  const room = { kind: 'room', id: crypto.randomUUID(), creator: authorId, title: 'Lejárt', createdAt: now - ROOM_TTL, expiresAt: now, lastActivityAt: now - ROOM_TTL };
  const message = { kind: 'message', id: crypto.randomUUID(), roomId: 'main', authorId, authorName: 'Teszt', text: 'Megmarad', createdAt: now - 1000, expiresAt: now - 1000 + MESSAGE_TTL };
  const expired = { ...message, id: crypto.randomUUID(), createdAt: now - MESSAGE_TTL, expiresAt: now };
  const orphan = { ...message, id: crypto.randomUUID(), roomId: room.id };
  const pendingRoom = { ...message, id: crypto.randomUUID(), roomId: crypto.randomUUID() };
  const invalid = { ...message, id: crypto.randomUUID(), extra: 'not allowed' };
  const presence = { kind: 'presence', id: crypto.randomUUID(), roomId: 'main', authorId, createdAt: now - PRESENCE_TTL, expiresAt: now };
  const records = [room, message, expired, orphan, pendingRoom, invalid, presence];
  const graph = new Map(records.map(value => [nodeId(value as any), value]));
  const db = {
    async map() { return { results: [...graph].map(([id, value]) => ({ id, value })) }; },
    async get(id: string) { return { result: graph.has(id) ? { value: graph.get(id) } : null }; },
    async remove(id: string) { graph.delete(id); },
  };
  assert.equal(await cleanGraph(db, now), 5);
  assert.deepEqual([...graph.values()], [message, pendingRoom]);
  assert.equal(await cleanGraph(db, now + MESSAGE_TTL), 2);
  assert.equal(graph.size, 0);
});

test('does not delete a heartbeat refreshed after taking the graph snapshot', async () => {
  const now = Date.now();
  const value = { kind: 'presence', id: crypto.randomUUID(), roomId: null, authorId: crypto.randomUUID(), createdAt: now, expiresAt: now + PRESENCE_TTL };
  const db = {
    async map() { return { results: [{ id: nodeId(value as any), value: { ...value, createdAt: now - PRESENCE_TTL, expiresAt: now } }] }; },
    async get() { return { result: { value } }; },
    async remove() { throw new Error('must not remove current heartbeat'); },
  };
  assert.equal(await cleanGraph(db, now), 0);
});

test('failed deletion can be retried on the next sweep', async () => {
  let removed = false;
  let fail = true;
  const db = {
    async map() { return { results: removed ? [] : [{ id: 'bad', value: {} }] }; },
    async get() { return { result: { value: {} } }; },
    async remove() { if (fail) { fail = false; throw new Error('storage failure'); } removed = true; },
  };
  await assert.rejects(cleanGraph(db), /storage failure/);
  assert.equal(await cleanGraph(db), 1);
});

test('a renewed room and its message survive a stale expiration snapshot', async () => {
  const now = Date.now();
  const room = { kind: 'room' as const, id: crypto.randomUUID(), creator: crypto.randomUUID(), title: 'Renewed', createdAt: now - ROOM_TTL, lastActivityAt: now - ROOM_TTL, expiresAt: now };
  const message = { kind: 'message' as const, id: crypto.randomUUID(), roomId: room.id, authorId: room.creator, authorName: 'Alice', text: 'Still here', createdAt: now - 1000, expiresAt: now - 1000 + MESSAGE_TTL };
  const renewed = { ...room, lastActivityAt: message.createdAt, expiresAt: message.createdAt + ROOM_TTL };
  const db = {
    async map() { return { results: [message, room].map(value => ({ id: nodeId(value), value })) }; },
    async get(id: string) { return { result: { value: id === nodeId(room) ? renewed : message } }; },
    async remove() { throw new Error('must preserve renewed room and message'); },
  };
  assert.equal(await cleanGraph(db, now), 0);
});


test('permanent profiles survive cleanup while expired guest profiles are removed', async () => {
  const { createProfile, hex, verifyRecord } = await import('../src/auth-proof.ts');
  const now = Date.now();
  const permanent = createProfile(hex(crypto.getRandomValues(new Uint8Array(32))), 'Permanent', true);
  const guest = createProfile(hex(crypto.getRandomValues(new Uint8Array(32))), 'Guest', false);
  const graph = new Map([permanent, guest].map(value => [nodeId(value), value]));
  const db = {
    async map() { return { results: [...graph].map(([id, value]) => ({ id, value })) }; },
    async get(id: string) { return { result: graph.has(id) ? { value: graph.get(id) } : null }; },
    async remove(id: string) { graph.delete(id); },
  };
  assert.equal(await cleanGraph(db, now + 365 * 24 * 60 * 60 * 1000, verifyRecord), 1);
  assert.deepEqual([...graph.values()], [permanent]);
});
