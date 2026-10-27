import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FirebaseIdentityError,
  linkFirebaseIdentity,
  normalizeVerifiedFirebaseIdentity,
  verifyFirebaseIdentity,
} from './firebaseIdentity.js';

function makeUser(id, values) {
  return { _id: { toString: () => id }, ...values };
}

function matches(user, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some((condition) => matches(user, condition));
    if (value && typeof value === 'object' && ('$exists' in value || '$eq' in value)) {
      if ('$exists' in value) return (key in user) === value.$exists;
      return user[key] === value.$eq;
    }
    return user[key] === value;
  });
}

function mockUsersCollection(users = []) {
  return {
    users,
    async findOne(query) {
      return users.find((user) => matches(user, query)) || null;
    },
    async updateOne(query, update) {
      const user = users.find((item) => matches(item, query));
      if (!user) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(user, update.$set);
      for (const [field, value] of Object.entries(update.$addToSet || {})) {
        user[field] = [...new Set([...(user[field] || []), value])];
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async insertOne(user) {
      if (users.some((item) => item.email === user.email || item.firebaseUid === user.firebaseUid)) {
        const error = new Error('Duplicate key');
        error.code = 11000;
        throw error;
      }
      const insertedId = { toString: () => `user-${users.length + 1}` };
      users.push({ _id: insertedId, ...user });
      return { insertedId };
    },
  };
}

test('Firebase identity requires a verified, normalized email and valid UID', () => {
  assert.deepEqual(normalizeVerifiedFirebaseIdentity({
    uid: 'firebase-user-1',
    email: '  Study.User@Example.com ',
    email_verified: true,
    name: 'Study User',
  }), {
    uid: 'firebase-user-1',
    email: 'study.user@example.com',
    name: 'Study User',
  });
  assert.throws(
    () => normalizeVerifiedFirebaseIdentity({ uid: 'user', email: 'user@example.com', email_verified: false }),
    (error) => error instanceof FirebaseIdentityError && error.status === 403,
  );
  assert.throws(
    () => normalizeVerifiedFirebaseIdentity({ uid: '', email: 'user@example.com', email_verified: true }),
    (error) => error instanceof FirebaseIdentityError && error.status === 401,
  );
});

test('Firebase ID tokens are verified with revocation checking and expired tokens are rejected', async () => {
  let revocationCheck;
  const identity = await verifyFirebaseIdentity({
    async verifyIdToken(token, checkRevoked) {
      assert.equal(token, 'valid-id-token');
      revocationCheck = checkRevoked;
      return { uid: 'firebase-user-2', email: 'member@example.com', email_verified: true };
    },
  }, 'valid-id-token');
  assert.equal(revocationCheck, true);
  assert.equal(identity.uid, 'firebase-user-2');

  await assert.rejects(
    verifyFirebaseIdentity({
      async verifyIdToken() {
        const error = new Error('expired');
        error.code = 'auth/id-token-expired';
        throw error;
      },
    }, 'expired-token'),
    (error) => error instanceof FirebaseIdentityError && error.status === 401,
  );
  await assert.rejects(
    verifyFirebaseIdentity({
      async verifyIdToken() {
        const error = new Error('invalid');
        error.code = 'auth/invalid-id-token';
        throw error;
      },
    }, 'invalid-token'),
    (error) => error instanceof FirebaseIdentityError && error.status === 401,
  );
  await assert.rejects(
    verifyFirebaseIdentity({
      async verifyIdToken() {
        const error = new Error('credentials are not configured');
        error.code = 'app/invalid-credential';
        throw error;
      },
    }, 'valid-but-unverifiable-token'),
    (error) => error instanceof FirebaseIdentityError
      && error.status === 503
      && error.message.includes('Application Default Credentials'),
  );
});

test('Firebase-only users are created without a local password hash and repeat sign-in reuses UID', async () => {
  const users = mockUsersCollection();
  const identity = { uid: 'firebase-user-3', email: 'new@example.com', name: 'New User' };
  const created = await linkFirebaseIdentity(users, identity, new Date('2026-01-01T00:00:00Z'));
  const repeated = await linkFirebaseIdentity(users, identity);

  assert.equal(users.users.length, 1);
  assert.equal(created.id, repeated.id);
  assert.equal(users.users[0].firebaseUid, identity.uid);
  assert.equal(users.users[0].emailVerified, true);
  assert.equal(Object.hasOwn(users.users[0], 'passwordHash'), false);
  assert.deepEqual(users.users[0].authProviders, ['firebase']);
});

test('verified Firebase email links an already-verified legacy account without changing its credentials or version', async () => {
  const legacyUser = makeUser('legacy-1', {
    email: 'member@example.com',
    name: 'Legacy Member',
    passwordHash: 'existing-password-hash',
    emailVerified: true,
    sessionVersion: 4,
  });
  const users = mockUsersCollection([legacyUser]);
  const result = await linkFirebaseIdentity(users, {
    uid: 'firebase-user-4',
    email: 'member@example.com',
    name: 'Firebase Display Name',
  });

  assert.equal(result.id, 'legacy-1');
  assert.equal(legacyUser.firebaseUid, 'firebase-user-4');
  assert.equal(legacyUser.passwordHash, 'existing-password-hash');
  assert.equal(legacyUser.emailVerified, true);
  assert.equal(legacyUser.sessionVersion, 4);
  assert.equal(legacyUser.name, 'Legacy Member');
});

test('unverified legacy accounts and emails already linked to another Firebase UID are rejected', async () => {
  const unverified = makeUser('legacy-2', { email: 'pending@example.com', emailVerified: false });
  const linkedToAnother = makeUser('legacy-3', {
    email: 'linked@example.com',
    emailVerified: true,
    firebaseUid: 'different-firebase-uid',
  });
  const users = mockUsersCollection([unverified, linkedToAnother]);

  await assert.rejects(
    linkFirebaseIdentity(users, { uid: 'firebase-new', email: 'pending@example.com', name: '' }),
    (error) => error instanceof FirebaseIdentityError && error.status === 403,
  );
  await assert.rejects(
    linkFirebaseIdentity(users, { uid: 'firebase-other', email: 'linked@example.com', name: '' }),
    (error) => error instanceof FirebaseIdentityError && error.status === 409,
  );
  assert.equal(unverified.firebaseUid, undefined);
});

test('unique-index race cannot create a duplicate Firebase user or silently link another identity', async () => {
  const users = mockUsersCollection();
  users.insertOne = async () => {
    const error = new Error('Duplicate key');
    error.code = 11000;
    throw error;
  };

  await assert.rejects(
    linkFirebaseIdentity(users, { uid: 'firebase-race', email: 'race@example.com', name: '' }),
    (error) => error instanceof FirebaseIdentityError && error.status === 409,
  );
});
