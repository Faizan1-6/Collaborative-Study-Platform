import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FirebaseAdminConfigurationError,
  getFirebaseAdminAuth,
  resolveFirebaseAdminConfiguration,
} from './firebaseAdmin.js';

test('Firebase Admin defaults to ADC with an explicit project ID and no service-account key', () => {
  const credentials = resolveFirebaseAdminConfiguration({
    FIREBASE_PROJECT_ID: 'study-test-project',
  });
  assert.deepEqual(credentials, { projectId: 'study-test-project', mode: 'adc' });

  const calls = [];
  const auth = { name: 'test-auth' };
  const sdk = {
    applicationDefault() {
      calls.push('applicationDefault');
      return { type: 'adc-credential' };
    },
    cert() {
      calls.push('cert');
      throw new Error('service-account credentials should not be used in ADC mode');
    },
    getApps: () => [],
    initializeApp(options, name) {
      calls.push({ options, name });
      return { name };
    },
    getAuth(app) {
      calls.push({ app });
      return auth;
    },
  };
  assert.equal(getFirebaseAdminAuth({ FIREBASE_PROJECT_ID: 'study-test-project' }, sdk), auth);
  assert.equal(calls[0], 'applicationDefault');
  assert.equal(calls[1].options.projectId, 'study-test-project');
  assert.deepEqual(calls[1].options.credential, { type: 'adc-credential' });
  assert.equal(calls[1].name, 'studysphere-firebase-auth');
});

test('Firebase Admin keeps explicit service-account mode as a compatible option', () => {
  const legacyConfiguration = resolveFirebaseAdminConfiguration({
    FIREBASE_PROJECT_ID: 'study-test-project',
    FIREBASE_CLIENT_EMAIL: 'firebase-admin@example.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'legacy-private-key',
  });
  assert.equal(legacyConfiguration.mode, 'service-account');

  const credentials = resolveFirebaseAdminConfiguration({
    FIREBASE_PROJECT_ID: 'study-test-project',
    FIREBASE_ADMIN_CREDENTIAL_MODE: 'service-account',
    FIREBASE_CLIENT_EMAIL: 'firebase-admin@example.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nline-one\\nline-two\\n-----END PRIVATE KEY-----',
  });

  assert.equal(credentials.projectId, 'study-test-project');
  assert.equal(credentials.mode, 'service-account');
  assert.equal(credentials.clientEmail, 'firebase-admin@example.iam.gserviceaccount.com');
  assert.equal(credentials.privateKey.includes('\\n'), false);
  assert.equal(credentials.privateKey.includes('\n'), true);
});

test('Firebase Admin rejects missing project ID, invalid mode, and partial service-account values', () => {
  assert.throws(
    () => resolveFirebaseAdminConfiguration({}),
    FirebaseAdminConfigurationError,
  );
  assert.throws(
    () => resolveFirebaseAdminConfiguration({ FIREBASE_PROJECT_ID: 'study-test-project', FIREBASE_ADMIN_CREDENTIAL_MODE: 'unknown' }),
    FirebaseAdminConfigurationError,
  );
  assert.throws(
    () => resolveFirebaseAdminConfiguration({
      FIREBASE_PROJECT_ID: 'study-test-project',
      FIREBASE_CLIENT_EMAIL: 'firebase-admin@example.iam.gserviceaccount.com',
    }),
    FirebaseAdminConfigurationError,
  );
});

test('Firebase Admin does not request ADC when project ID is missing', () => {
  let credentialRequested = false;
  assert.throws(
    () => getFirebaseAdminAuth({}, {
      applicationDefault() {
        credentialRequested = true;
        return {};
      },
      getApps: () => [],
      getAuth: () => ({}),
      initializeApp: () => ({}),
    }),
    FirebaseAdminConfigurationError,
  );
  assert.equal(credentialRequested, false);
});

test('ADC mode refuses ambiguous service-account credentials instead of silently ignoring them', () => {
  assert.throws(
    () => resolveFirebaseAdminConfiguration({
      FIREBASE_PROJECT_ID: 'study-test-project',
      FIREBASE_ADMIN_CREDENTIAL_MODE: 'adc',
      FIREBASE_CLIENT_EMAIL: 'firebase-admin@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'private-key',
    }),
    FirebaseAdminConfigurationError,
  );
});
