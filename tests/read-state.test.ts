import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadState, unreadLabel } from '../src/read-state.ts';
import { MESSAGE_TTL, type MessageRecord } from '../src/model.ts';
test('unread state survives reload, merges tabs and handles late messages without a timestamp watermark', () => {
  const now = Date.now();
  const authorId = crypto.randomUUID();
  const message: MessageRecord = {
    kind: 'message',
    id: crypto.randomUUID(),
    roomId: 'main',
    authorId,
    authorName: 'Alice',
    text: 'hello',
    createdAt: now,
    expiresAt: now + MESSAGE_TTL,
  };
  let saved: string | null = null;
  const storage = {
    getItem: () => saved,
    setItem: (_: string, value: string) => {
      saved = value;
    },
  };
  const a = new ReadState('test', storage);
  const b = new ReadState('test', storage);
  a.mark([message]);
  const late = {
    ...message,
    id: crypto.randomUUID(),
    createdAt: now - 1000,
    expiresAt: now - 1000 + MESSAGE_TTL,
  };
  assert.equal(a.unread([message, late], 'other'), 1);
  b.mark([late]);
  const reloaded = new ReadState('test', storage);
  assert.equal(reloaded.unread([message, late], 'other'), 0);
  assert.equal(reloaded.unread([{ ...message, id: crypto.randomUUID() }], authorId), 0);
  assert.equal(unreadLabel(99), '99');
  assert.equal(unreadLabel(100), '99+');
});
