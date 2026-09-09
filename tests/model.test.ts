import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOCK_SKEW, MESSAGE_TTL, ROOM_TTL, PRESENCE_TTL, parseRecord, nodeId, isVisibleMessage, renewRoom, mergeRoom, type RoomRecord, type MessageRecord } from '../src/model.ts';

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

test('room expiry follows validated activity while message TTL remains fixed', () => {
  const sentAt = now + ROOM_TTL - 1;
  const sent = { ...message, createdAt: sentAt, expiresAt: sentAt + MESSAGE_TTL };
  const renewed = renewRoom(room, sent, sentAt);
  assert.equal(renewed.expiresAt, sentAt + ROOM_TTL);
  assert.equal(renewed.createdAt, room.createdAt);
  assert.ok(parseRecord(nodeId(renewed), renewed, sentAt));
  assert.equal(isVisibleMessage(sent, new Map([[id, renewed]]), sentAt + MESSAGE_TTL - 1), true);
  assert.equal(isVisibleMessage(sent, new Map([[id, renewed]]), sentAt + MESSAGE_TTL), false);
  for (const lastActivityAt of [now - 1, sentAt + CLOCK_SKEW + 1, NaN, Infinity, sentAt + .5]) {
    assert.equal(parseRecord(nodeId(room), { ...room, lastActivityAt, expiresAt: lastActivityAt + ROOM_TTL }, sentAt), null);
  }
});

test('replays, late arrivals and conflicting room metadata cannot restart the timer', () => {
  const sentAt = now + 1000;
  const sent = { ...message, createdAt: sentAt, expiresAt: sentAt + MESSAGE_TTL };
  const renewed = renewRoom(room, sent, sentAt);
  assert.equal(renewRoom(renewed, sent, sentAt + 1000), renewed);
  assert.equal(renewRoom(renewed, message, sentAt + 1000), renewed);
  assert.equal(mergeRoom(renewed, room), renewed);
  assert.equal(mergeRoom(room, renewed), renewed);
  assert.equal(mergeRoom(room, { ...renewed, title: 'Changed title' }), room);
  assert.equal(renewRoom(room, sent, now + ROOM_TTL), room);
  assert.equal(renewRoom(room, { ...sent, createdAt: room.expiresAt }, room.expiresAt - 1), room);
  assert.equal(renewRoom(room, { ...sent, roomId: 'main' }, sentAt), room);
});

test('receipts have bounded text, a valid message ID and cannot outlive the message window', () => {
  const receipt = { kind: 'receipt', id, messageId: authorId, roomId: 'main', authorId, authorName: 'Bob', createdAt: now, expiresAt: now + MESSAGE_TTL - 1000 };
  assert.ok(parseRecord(`receipt:${id}`, receipt, now));
  for (const value of [{ ...receipt, messageId: 'bad' }, { ...receipt, expiresAt: now }, { ...receipt, expiresAt: now + MESSAGE_TTL + 1 }, { ...receipt, authorName: 'x'.repeat(41) }]) assert.equal(parseRecord(`receipt:${id}`, value, now), null);
});
