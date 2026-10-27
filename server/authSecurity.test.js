import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAccessToken,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  readAccessToken,
  verifyPassword,
} from './authSecurity.js';

test('password hashes are unique and verify only the matching password', async () => {
  const firstHash = await hashPassword('correct horse battery');
  const secondHash = await hashPassword('correct horse battery');

  assert.notEqual(firstHash, secondHash);
  assert.equal(await verifyPassword('correct horse battery', firstHash), true);
  assert.equal(await verifyPassword('incorrect password', firstHash), false);
  assert.equal(await verifyPassword('some password', undefined), false);
});

test('accounts without a local password hash cannot use password login', async () => {
  assert.equal(await verifyPassword('firebase-user-guess', undefined), false);
});

test('access tokens are signed, expire, and reject tampering', () => {
  const now = 1_800_000_000_000;
  const token = createAccessToken('user-id', 'a sufficiently long test secret', now, 3);

  assert.equal(readAccessToken(token, 'a sufficiently long test secret', now)?.sub, 'user-id');
  assert.equal(readAccessToken(token, 'a sufficiently long test secret', now)?.ver, 3);
  assert.equal(readAccessToken(token, 'a different secret', now), null);
  assert.equal(readAccessToken(`${token}x`, 'a sufficiently long test secret', now), null);
  assert.equal(readAccessToken(token, 'a sufficiently long test secret', now + 8 * 24 * 60 * 60 * 1000), null);
});

test('opaque tokens use random material and only their hash is persisted', () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();

  assert.notEqual(first, second);
  assert.notEqual(hashOpaqueToken(first), first);
  assert.notEqual(hashOpaqueToken(first), hashOpaqueToken(second));
});
