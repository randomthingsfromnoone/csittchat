import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_SKEW, MESSAGE_TTL, ROOM_TTL, PRESENCE_TTL, parseRecord, nodeId, isVisibleMessage, type RoomRecord, type MessageRecord } from '../src/model.ts';

const now = Date.UTC(2026, 8, 8);
const id = '019a1111-1111-4111-8111-111111111111';
const authorId = '019a2222-2222-4222-8222-222222222222';
const room: RoomRecord = { kind: 'room', id, title: 'A passing thought', creator: authorId, createdAt: now, expiresAt: now + ROOM_TTL, lastActivityAt: now };
const message: MessageRecord = { kind: 'message', id: authorId, roomId: id, authorId, authorName: 'Alice', text: 'Hello', createdAt: now, expiresAt: now + MESSAGE_TTL };

test('valid public records and expiry boundaries', () => {
  assert.deepEqual(parseRecord(nodeId(room), room, now), room);
  assert.deepEqual(parseRecord(nodeId(message), message, now), message);
  assert.ok(parseRecord(`presence:${id}`, { kind: 'presence', id, roomId: null, authorId, createdAt: now, expiresAt: now + PRESENCE_TTL }, now));
  const rooms = new Map([[id, room]]);
  assert.equal(isVisibleMessage(message, rooms, now + MESSAGE_TTL - 1), true);
  assert.equal(isVisibleMessage(message, rooms, now + MESSAGE_TTL), false);
  assert.equal(isVisibleMessage(message, new Map(), now), false);
  assert.equal(isVisibleMessage({ ...message, roomId: 'main' }, new Map(), now), true);
  const lateMessage = { ...message, createdAt: now + ROOM_TTL - 1, expiresAt: now + ROOM_TTL - 1 + MESSAGE_TTL };
  assert.equal(isVisibleMessage(lateMessage, rooms, now + ROOM_TTL), false);
});

test('reject hostile shapes, excess fields, IDs, lengths and control characters', () => {
  for (const value of [null, [], 'text', 42, { ...message, extra: 'x'.repeat(10000) },
    { ...message, text: 'x'.repeat(2001) }, { ...message, authorName: 'x'.repeat(41) },
    { ...message, text: '\u0000oops' }, { ...message, text: ' \n ' },
    { ...message, authorName: 'two\nlines' }, { ...message, authorId: '__proto__' },
    { ...message, roomId: '../../../somewhere' }, { ...message, id: 'duplicate' }]) {
    assert.equal(parseRecord(nodeId(message), value, now), null);
  }
  assert.equal(parseRecord(`room:${id}`, { ...room, title: 'x'.repeat(101) }, now), null);
  assert.equal(parseRecord(`message:${id}`, message, now), null);
  assert.ok(parseRecord(nodeId(message), { ...message, text: '<img src=x onerror=alert(1)>\nA literal string' }, now));
});

test('reject timestamp inflation and non-deterministic TTLs; accept stale records for cleanup', () => {
  for (const value of [
    { ...message, createdAt: Infinity }, { ...message, createdAt: NaN },
    { ...message, createdAt: 0 }, { ...message, createdAt: now + .5 },
    { ...message, createdAt: now + CLOCK_SKEW + 1, expiresAt: now + CLOCK_SKEW + 1 + MESSAGE_TTL },
    { ...message, expiresAt: now + MESSAGE_TTL + 1 },
  ]) assert.equal(parseRecord(nodeId(message), value, now), null);
  assert.equal(parseRecord(nodeId(room), { ...room, lastActivityAt: now + 1 }, now), null);
  assert.ok(parseRecord(nodeId(message), message, now + ROOM_TTL));
});
