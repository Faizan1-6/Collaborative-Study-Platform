import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const requiredFirebaseConfig = ['apiKey', 'authDomain', 'projectId', 'appId'];
const hasFirebaseConfig = requiredFirebaseConfig.every((key) => (
  typeof firebaseConfig[key] === 'string' && firebaseConfig[key].trim()
));

export let firebaseAuth = null;
export let firebaseAuthError = '';

if (hasFirebaseConfig) {
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    firebaseAuth = getAuth(app);
  } catch {
    firebaseAuthError = 'Firebase Authentication could not be initialized. Check the client Firebase configuration.';
  }
} else {
  firebaseAuthError = 'Firebase Authentication is not configured. Add the VITE_FIREBASE_* settings to the client environment.';
}

export async function prepareFirebaseAuth() {
  if (!firebaseAuth) throw new Error(firebaseAuthError);
  await setPersistence(firebaseAuth, browserLocalPersistence);
  return firebaseAuth;
}
