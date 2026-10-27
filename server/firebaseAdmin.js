import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const appName = 'studysphere-firebase-auth';

export class FirebaseAdminConfigurationError extends Error {
  constructor() {
    super('Firebase Admin credentials are unavailable. Set FIREBASE_PROJECT_ID and configure Application Default Credentials, or explicitly select service-account mode with its backend-only credentials.');
    this.name = 'FirebaseAdminConfigurationError';
  }
}

export function resolveFirebaseAdminConfiguration(environment) {
  const projectId = environment.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = environment.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKey = environment.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim();
  const configuredMode = environment.FIREBASE_ADMIN_CREDENTIAL_MODE?.trim();
  const hasServiceAccountSetting = Boolean(clientEmail || privateKey);
  const mode = configuredMode || (hasServiceAccountSetting ? 'service-account' : 'adc');

  if (!projectId || !['adc', 'service-account'].includes(mode)) {
    throw new FirebaseAdminConfigurationError();
  }
  if (mode === 'service-account' && (!clientEmail || !privateKey)) {
    throw new FirebaseAdminConfigurationError();
  }
  if (mode === 'adc' && hasServiceAccountSetting) {
    throw new FirebaseAdminConfigurationError();
  }

  return {
    projectId,
    mode,
    ...(mode === 'service-account' ? { clientEmail, privateKey } : {}),
  };
}

export function getFirebaseAdminAuth(environment = process.env, sdk = {
  applicationDefault,
  cert,
  getApps,
  getAuth,
  initializeApp,
}) {
  const configuration = resolveFirebaseAdminConfiguration(environment);
  const existingApp = sdk.getApps().find((app) => app.name === appName);
  if (existingApp) return sdk.getAuth(existingApp);

  const credential = configuration.mode === 'adc'
    ? sdk.applicationDefault()
    : sdk.cert({
      projectId: configuration.projectId,
      clientEmail: configuration.clientEmail,
      privateKey: configuration.privateKey,
    });
  const app = sdk.initializeApp({
    credential,
    projectId: configuration.projectId,
  }, appName);
  return sdk.getAuth(app);
}
