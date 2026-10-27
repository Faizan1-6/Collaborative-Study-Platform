function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !/[\u0000-\u001f\u007f]/.test(email)
    ? email
    : '';
}

export class FirebaseIdentityError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'FirebaseIdentityError';
    this.status = status;
  }
}

export function normalizeVerifiedFirebaseIdentity(claims) {
  if (typeof claims?.uid !== 'string' || !claims.uid.trim() || claims.uid.length > 128) {
    throw new FirebaseIdentityError(401, 'Firebase returned an invalid account identity.');
  }
  const email = normalizeEmail(claims.email);
  if (!email || claims.email_verified !== true) {
    throw new FirebaseIdentityError(403, 'Verify your email with Firebase before using this sign-in method.');
  }
  const name = typeof claims.name === 'string'
    ? claims.name.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80)
    : '';
  return { uid: claims.uid, email, name };
}

export async function verifyFirebaseIdentity(auth, token) {
  let claims;
  try {
    claims = await auth.verifyIdToken(token, true);
  } catch (error) {
    const code = error?.code;
    if (['auth/id-token-expired', 'auth/id-token-revoked', 'auth/invalid-id-token', 'auth/argument-error'].includes(code)) {
      throw new FirebaseIdentityError(401, 'The Firebase sign-in token is invalid or expired. Sign in again.');
    }
    if (['app/invalid-credential', 'app/invalid-app-credential', 'auth/invalid-credential'].includes(code)) {
      throw new FirebaseIdentityError(503, 'Firebase Admin credentials are unavailable. Configure local Application Default Credentials or the backend host identity.');
    }
    throw new FirebaseIdentityError(503, 'Firebase sign-in is temporarily unavailable. Please try again.');
  }
  return normalizeVerifiedFirebaseIdentity(claims);
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

async function findExistingFirebaseIdentity(usersCollection, identity) {
  const linkedUser = await usersCollection.findOne({ firebaseUid: identity.uid });
  if (linkedUser) {
    if (linkedUser.emailVerified !== true) {
      throw new FirebaseIdentityError(403, 'Verify this account with StudySphere before using Firebase sign-in.');
    }
    return linkedUser;
  }
  return null;
}

function publicFirebaseUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
  };
}

export async function linkFirebaseIdentity(usersCollection, identity, now = new Date()) {
  const linkedUser = await findExistingFirebaseIdentity(usersCollection, identity);
  if (linkedUser) return publicFirebaseUser(linkedUser);

  const emailUser = await usersCollection.findOne({ email: identity.email });
  if (emailUser) {
    if (emailUser.firebaseUid && emailUser.firebaseUid !== identity.uid) {
      throw new FirebaseIdentityError(409, 'This email is already linked to a different Firebase account.');
    }
    if (emailUser.emailVerified !== true) {
      throw new FirebaseIdentityError(403, 'Verify this StudySphere account using its existing email-verification link before linking Firebase.');
    }

    try {
      await usersCollection.updateOne({
        _id: emailUser._id,
        emailVerified: true,
        $or: [
          { firebaseUid: { $exists: false } },
          { firebaseUid: null },
          { firebaseUid: identity.uid },
        ],
      }, {
        $set: { firebaseUid: identity.uid, updatedAt: now },
        $addToSet: { authProviders: 'firebase' },
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }

    const linked = await usersCollection.findOne({ firebaseUid: identity.uid });
    if (linked?.emailVerified === true) return publicFirebaseUser(linked);
    throw new FirebaseIdentityError(409, 'This account could not be linked safely. Sign in with the existing StudySphere account or contact support.');
  }

  const user = {
    email: identity.email,
    name: identity.name || identity.email.split('@')[0].slice(0, 80),
    firebaseUid: identity.uid,
    authProviders: ['firebase'],
    emailVerified: true,
    sessionVersion: 0,
    createdAt: now,
  };
  try {
    const result = await usersCollection.insertOne(user);
    return publicFirebaseUser({ ...user, _id: result.insertedId });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const racedIdentity = await findExistingFirebaseIdentity(usersCollection, identity);
    if (racedIdentity) return publicFirebaseUser(racedIdentity);
    throw new FirebaseIdentityError(409, 'An account with this email already exists. Sign in through the existing account before linking Firebase.');
  }
}
