import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, hex } from '../src/auth-proof.ts';
import {
  identityStorageKey,
  saveIdentity,
  savedIdentity,
  forgetIdentity,
  type Identity,
} from '../src/identity.ts';

function identity(remember = true): Identity {
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const profile = createProfile(secret, 'Stored user', true);
  return { id: profile.id, name: profile.name, permanent: true, profile, secret, remember };
}
function storage(t: TestContext) {
  const session = new Map<string, string>();
  const persistent = new Map<string, string>();
  for (const [name, map] of [
    ['sessionStorage', session],
    ['localStorage', persistent],
  ] as const) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => map.set(key, value),
        removeItem: (key: string) => map.delete(key),
      },
    });
    t.after(() => {
      if (before) Object.defineProperty(globalThis, name, before);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return { session, persistent };
}

test('an existing session migrates to remembered storage and signing out removes both copies', (t) => {
  const { session, persistent } = storage(t);
  const value = identity();
  const { remember: _, ...legacy } = value;
  session.set(identityStorageKey, JSON.stringify(legacy));
  const migrated = savedIdentity()!;
  assert.equal(migrated.remember, true);
  saveIdentity(migrated);
  assert.ok(persistent.has(identityStorageKey));
  session.clear();
  assert.equal(savedIdentity()?.id, value.id);
  forgetIdentity(value.id);
  assert.equal(savedIdentity(), null);
});

test('opting out stays within this tab and does not remove another remembered account', (t) => {
  const { session, persistent } = storage(t);
  const owner = identity();
  saveIdentity(owner);
  const tab = identity(false);
  saveIdentity(tab);
  assert.equal(savedIdentity()?.id, tab.id);
  forgetIdentity(tab.id);
  assert.equal(session.size, 0);
  assert.equal(JSON.parse(persistent.get(identityStorageKey)!).id, owner.id);
});

test('blocked persistent storage falls back to session storage', (t) => {
  storage(t);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  const value = identity();
  assert.doesNotThrow(() => saveIdentity(value));
  assert.equal(savedIdentity()?.id, value.id);
  assert.doesNotThrow(() => forgetIdentity(value.id));
  assert.equal(savedIdentity(), null);
});

test('saved profile must belong to the saved signing key', (t) => {
  const { persistent } = storage(t);
  const value = identity();
  persistent.set(identityStorageKey, JSON.stringify({ ...value, profile: identity().profile }));
  assert.equal(savedIdentity(), null);
  forgetIdentity(value.id);
  assert.equal(persistent.size, 0);
});

test('a dormant tab cannot restore a remembered identity after another tab signs out', (t) => {
  const { persistent } = storage(t);
  saveIdentity(identity());
  persistent.delete(identityStorageKey); // Other tab signed out while this tab was suspended.
  assert.equal(savedIdentity(), null);
});
