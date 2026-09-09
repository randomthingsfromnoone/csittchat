import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, hex, signRecord, verifyProfile, verifyRecord } from '../src/auth-proof.ts';
import { verifyRecord as peerVerify } from '../src/peer-proof.mjs';
import {
  parseRecord,
  nodeId,
  MESSAGE_TTL,
  PRESENCE_TTL,
  type MessageRecord,
} from '../src/model.ts';

test('self-signed profiles bind names, keys and messages without a certificate authority', () => {
  const now = Date.now();
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const profile = createProfile(secret, 'Alice', true, now);
  const message: MessageRecord = {
    kind: 'message',
    id: crypto.randomUUID(),
    roomId: 'main',
    authorId: profile.id,
    authorName: profile.name,
    createdAt: now,
    expiresAt: now + MESSAGE_TTL,
    text: 'hello',
  };
  const signed = signRecord(message, profile, secret);
  assert.ok(verifyProfile(profile));
  assert.ok(peerVerify(profile));
  assert.ok(parseRecord(nodeId(signed), signed));
  assert.ok(verifyRecord(signed));
  assert.ok(peerVerify(signed));
  for (const modified of [
    { ...signed, text: 'forged' },
    { ...signed, authorName: 'Bob' },
    { ...signed, authorId: crypto.randomUUID() },
  ]) {
    assert.equal(verifyRecord(modified), false);
    assert.equal(peerVerify(modified), false);
  }
  assert.equal(verifyRecord(message), false);
  assert.equal(verifyProfile({ ...profile, id: crypto.randomUUID() }), false);
  assert.equal(verifyProfile({ ...profile, name: 'Bob' }), false);
});

test('expired guest snapshots cannot sign fresh messages, but existing messages remain verifiable', () => {
  const now = Date.now();
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const profile = createProfile(secret, 'Guest', false, now);
  const value: MessageRecord = {
    kind: 'message',
    id: crypto.randomUUID(),
    roomId: 'main',
    authorId: profile.id,
    authorName: profile.name,
    createdAt: now,
    expiresAt: now + MESSAGE_TTL,
    text: 'hello',
  };
  assert.ok(verifyRecord(signRecord(value, profile, secret)));
  const late = signRecord(
    { ...value, createdAt: now + PRESENCE_TTL, expiresAt: now + PRESENCE_TTL + MESSAGE_TTL },
    profile,
    secret,
  );
  assert.equal(verifyRecord(late), false);
  assert.equal(peerVerify(late), false);
});
