import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { Server } from 'socket.io';
import { MongoClient, ObjectId } from 'mongodb';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v2 as cloudinary } from 'cloudinary';
import { classifyProviderError } from './providerErrors.js';
import {
  createAccessToken,
  createOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  readAccessToken,
  verifyPassword,
} from './authSecurity.js';
import {
  getFirebaseAdminAuth,
  FirebaseAdminConfigurationError,
  resolveFirebaseAdminConfiguration,
} from './firebaseAdmin.js';
import { FirebaseIdentityError, linkFirebaseIdentity, verifyFirebaseIdentity } from './firebaseIdentity.js';
import nodemailer from 'nodemailer';

const app = express();
const server = createServer(app);
const isProduction = process.env.NODE_ENV === 'production';
const configuredOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(!isProduction ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
]);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('This origin is not allowed by the server CORS configuration.'));
  },
  credentials: true,
};
const io = new Server(server, { cors: corsOptions });
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/collaborative_study_platform';
const configuredDatabase = decodeURIComponent(new URL(mongoUri).pathname.slice(1));
const databaseName = configuredDatabase || 'collaborative_study';
const mongoClient = new MongoClient(
  mongoUri,
  { serverSelectionTimeoutMS: 5000 },
);
let notesCollection;
let resourcesCollection;
let roomsCollection;
let usersCollection;

const clientBaseUrl = (process.env.CLIENT_URL || configuredOrigins[0] || (isProduction ? '' : 'http://localhost:5173')).replace(/\/+$/, '');
const publicApiBaseUrl = (process.env.API_PUBLIC_URL || (isProduction ? '' : clientBaseUrl)).replace(/\/+$/, '');
const sessionCookieName = 'studysphere_session';
const resetCookieName = 'studysphere_reset';
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const rateLimitBuckets = new Map();

if (isProduction) app.set('trust proxy', 1);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '15mb' }));

function validRoomId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
}

function validSessionSecret() {
  const secret = process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.length >= 32 && !/replace_me|change_me|your_secret/i.test(secret);
}

function missingSmtpSettings() {
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS']
    .filter((name) => !process.env[name]?.trim());
  const port = Number(process.env.SMTP_PORT);
  if (process.env.SMTP_PORT && (!Number.isInteger(port) || port < 1 || port > 65535)) missing.push('SMTP_PORT (must be 1-65535)');
  return missing;
}

function productionConfigurationErrors() {
  if (!isProduction) return [];
  const errors = [];
  const required = ['MONGODB_URI', 'JWT_SECRET', 'CLIENT_URL', 'API_PUBLIC_URL', 'CLIENT_ORIGIN',
    'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) errors.push(`Set ${missing.join(', ')} in the production environment.`);
  if (!validSessionSecret()) errors.push('JWT_SECRET must be unique and at least 32 characters long.');
  if (missingSmtpSettings().length) errors.push(`SMTP configuration is invalid: ${missingSmtpSettings().join(', ')}.`);
  const firebaseAdminSettings = [
    'FIREBASE_PROJECT_ID',
    'FIREBASE_ADMIN_CREDENTIAL_MODE',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  ];
  if (firebaseAdminSettings.some((name) => process.env[name]?.trim())) {
    try {
      resolveFirebaseAdminConfiguration(process.env);
    } catch (error) {
      if (error instanceof FirebaseAdminConfigurationError) {
        errors.push('Firebase Admin configuration is incomplete. Provide FIREBASE_PROJECT_ID and valid ADC credentials, or explicitly configure service-account mode with both backend-only credential variables.');
      } else {
        errors.push('Firebase Admin configuration is invalid.');
      }
    }
  }

  for (const [name, value] of [['CLIENT_URL', process.env.CLIENT_URL], ['API_PUBLIC_URL', process.env.API_PUBLIC_URL]]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash
        || hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') {
        errors.push(`${name} must be a non-local HTTPS origin without a path, credentials, query, or fragment.`);
      }
    } catch {
      errors.push(`${name} must be a valid HTTPS URL.`);
    }
  }

  for (const origin of configuredOrigins) {
    try {
      const url = new URL(origin);
      const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (url.protocol !== 'https:' || url.origin !== origin
        || hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') {
        errors.push('Every CLIENT_ORIGIN entry must be a non-local HTTPS origin with no path, query, or fragment.');
        break;
      }
    } catch {
      errors.push('Every CLIENT_ORIGIN entry must be a valid HTTPS origin.');
      break;
    }
  }
  if (process.env.MONGODB_URI) {
    try {
      const mongoUrl = new URL(process.env.MONGODB_URI);
      const hostname = mongoUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!['mongodb:', 'mongodb+srv:'].includes(mongoUrl.protocol)
        || hostname === 'localhost' || hostname.endsWith('.localhost')
        || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') {
        errors.push('MONGODB_URI must use a remote MongoDB connection, not a local database.');
      }
    } catch {
      errors.push('MONGODB_URI must be a valid MongoDB connection URI.');
    }
  }
  return errors;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[\u0000-\u001f\u007f]/.test(email)
    ? email
    : '';
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') return '';
  for (const part of cookieHeader.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(valueParts.join('='));
      } catch {
        return '';
      }
    }
  }
  return '';
}

function sessionCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${sessionLifetimeSeconds}${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${sessionCookieName}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`;
}

function resetCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${resetCookieName}=${token}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=900${secure}`;
}

function clearResetCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const sameSite = process.env.NODE_ENV === 'production' ? 'None' : 'Lax';
  return `${resetCookieName}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure}`;
}

function rateLimit(limit, windowMs) {
  return (request, response, next) => {
    const now = Date.now();
    const key = `${request.baseUrl}${request.path}:${request.ip}`;
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      response.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      return response.status(429).json({ error: 'Too many requests. Please wait before trying again.' });
    }
    bucket.count += 1;
    if (rateLimitBuckets.size > 5000) {
      for (const [bucketKey, value] of rateLimitBuckets) {
        if (value.resetAt <= now) rateLimitBuckets.delete(bucketKey);
      }
    }
    return next();
  };
}

async function optionalAuth(request, _response, next) {
  request.user = null;
  const token = readCookie(request, sessionCookieName);
  if (token && validSessionSecret() && usersCollection) {
    const session = readAccessToken(token, process.env.JWT_SECRET);
    if (session && ObjectId.isValid(session.sub)) {
      const user = await usersCollection.findOne(
        { _id: new ObjectId(session.sub), emailVerified: true },
        { projection: { name: 1, email: 1, emailVerified: 1, createdAt: 1, sessionVersion: 1 } },
      );
      if (user && (session.ver ?? 0) === (user.sessionVersion ?? 0)) {
        request.user = { id: user._id.toString(), name: user.name, email: user.email };
      }
    }
  }
  return next();
}

function requireAuth(request, response, next) {
  if (!request.user) return response.status(401).json({ error: 'Sign in to access your account.' });
  return next();
}

function requireAllowedOrigin(request, response, next) {
  const origin = request.get('origin');
  if (origin && !allowedOrigins.has(origin)) {
    return response.status(403).json({ error: 'This origin is not allowed to update your account.' });
  }
  return next();
}

function configuredMailer() {
  if (missingSmtpSettings().length) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

async function sendAccountEmail(to, subject, text, html) {
  const mailer = configuredMailer();
  if (!mailer) return { sent: false, configured: false };
  try {
    const result = await mailer.sendMail({
      from: process.env.SMTP_FROM || `StudySphere <${process.env.SMTP_USER}>`,
      to,
      subject,
      text,
      html,
    });
    if (!Array.isArray(result.accepted) || !result.accepted.length) {
      console.error('SMTP delivery was not accepted by a recipient.');
      return { sent: false, configured: true };
    }
    return { sent: true, configured: true };
  } catch (error) {
    console.error(`SMTP delivery failed (${error?.code || error?.name || 'mail error'}, status ${error?.responseCode || 'unknown'}).`);
    return { sent: false, configured: true };
  }
}

async function findRoomForJoin(roomId) {
  if (!roomsCollection) return null;
  const existingRoom = await roomsCollection.findOne({ _id: roomId });
  if (existingRoom) return existingRoom;
  const legacyNotes = notesCollection && await notesCollection.findOne({ room: roomId }, { projection: { _id: 1 } });
  const legacyResource = resourcesCollection && await resourcesCollection.findOne({ room: roomId }, { projection: { _id: 1 } });
  if (!legacyNotes && !legacyResource) return null;
  await roomsCollection.updateOne(
    { _id: roomId },
    { $setOnInsert: { createdAt: new Date(), createdBy: null, migrated: true } },
    { upsert: true },
  );
  return roomsCollection.findOne({ _id: roomId });
}

function validateAccountInput(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email) return { error: 'Enter a valid email address.' };
  if (!password || password.length < 10 || password.length > 128) {
    return { error: 'Passwords must be 10-128 characters long.' };
  }
  if (name && (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))) {
    return { error: 'Names must be 1-80 printable characters.' };
  }
  return { name, email, password };
}

function validResourceContent(mimeType, buffer) {
  if (mimeType === 'application/pdf') {
    return buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'));
  }
  if (mimeType === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function getPrompt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.prompt !== 'string') {
    return { error: 'Provide a prompt as a string.' };
  }
  const prompt = body.prompt.trim();
  if (!prompt) return { error: 'Enter a question before asking the assistant.' };
  if (prompt.length > 4000) return { error: 'Questions must be 4,000 characters or fewer.' };
  return { prompt };
}

function sendProviderError(provider, error, response) {
  const status = Number(error?.status);
  const providerCode = error?.error?.code || error?.code || error?.error?.type || 'unknown';
  console.error(`${provider} request failed (${error?.name || 'provider error'}, status ${status || 'unknown'}, code ${providerCode}).`);
  const failure = classifyProviderError(provider, error);
  return response.status(failure.status).json({ error: failure.error });
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    database: notesCollection ? 'connected' : 'disconnected',
    cloudinary: Boolean(
      process.env.CLOUDINARY_CLOUD_NAME
      && process.env.CLOUDINARY_API_KEY
      && process.env.CLOUDINARY_API_SECRET,
    ),
    providers: {
      groq: Boolean(process.env.GROQ_API_KEY),
      gemini: Boolean(process.env.GEMINI_API_KEY),
    },
    authentication: Boolean(usersCollection && validSessionSecret()),
    email: {
      configured: missingSmtpSettings().length === 0,
      missing: missingSmtpSettings(),
    },
  });
});

app.get('/api/auth/verify-email', rateLimit(10, 15 * 60 * 1000), async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Email verification is unavailable.' });
  const token = typeof request.query.token === 'string' ? request.query.token : '';
  let verified = false;
  if (token.length >= 20 && token.length <= 200) {
    const result = await usersCollection.updateOne({
      verificationTokenHash: hashOpaqueToken(token),
      verificationExpiresAt: { $gt: new Date() },
      emailVerified: false,
    }, {
      $set: { emailVerified: true, verifiedAt: new Date() },
      $unset: { verificationTokenHash: '', verificationExpiresAt: '' },
    });
    verified = result.modifiedCount === 1;
  }
  return response.redirect(302, `${clientBaseUrl}/?verified=${verified ? '1' : 'invalid'}`);
});

app.post('/api/auth/register', rateLimit(5, 60 * 60 * 1000), async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Registration is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Set a unique JWT_SECRET of at least 32 characters in server/.env before enabling authentication.' });
  const input = validateAccountInput(request.body);
  if (input.error) return response.status(400).json({ error: input.error });
  if (!input.name) return response.status(400).json({ error: 'Enter your name.' });
  const missingSmtp = missingSmtpSettings();
  if (missingSmtp.length) {
    return response.status(503).json({ error: `Email verification is unavailable. Configure ${missingSmtp.join(', ')} in server/.env.` });
  }

  const verificationToken = createOpaqueToken();
  const user = {
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    sessionVersion: 0,
    emailVerified: false,
    verificationTokenHash: hashOpaqueToken(verificationToken),
    verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
  };
  try {
    await usersCollection.insertOne(user);
  } catch (error) {
    if (error?.code === 11000) return response.status(409).json({ error: 'An account with this email already exists.' });
    throw error;
  }

  const verificationUrl = `${publicApiBaseUrl}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`;
  const escapedName = user.name.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const delivery = await sendAccountEmail(
    user.email,
    'Verify your StudySphere email',
    `Hello ${user.name},\n\nVerify your email address within 24 hours:\n${verificationUrl}`,
    `<p>Hello ${escapedName},</p><p><a href="${verificationUrl}">Verify your email address</a>. This link expires in 24 hours.</p>`,
  );
  if (!delivery.sent) {
    return response.status(502).json({
      error: 'Your account was created, but the verification email was not confirmed as sent. Check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in server/.env, then request a new verification email.',
    });
  }
  return response.status(201).json({ message: 'Account created. Check your email for a verification link that expires in 24 hours.' });
});

app.post('/api/auth/verification/resend', rateLimit(5, 60 * 60 * 1000), async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Email verification is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Authentication is unavailable. Check JWT_SECRET in server/.env.' });
  const email = normalizeEmail(request.body?.email);
  if (!email) return response.status(400).json({ error: 'Enter a valid email address.' });
  const missingSmtp = missingSmtpSettings();
  if (missingSmtp.length) {
    return response.status(503).json({ error: `Email delivery is unavailable. Configure ${missingSmtp.join(', ')} in server/.env.` });
  }

  const user = await usersCollection.findOne({ email, emailVerified: false });
  if (!user) return response.json({ message: 'If an unverified account exists for that address, a new verification link will be sent.' });
  const verificationToken = createOpaqueToken();
  await usersCollection.updateOne({ _id: user._id }, {
    $set: {
      verificationTokenHash: hashOpaqueToken(verificationToken),
      verificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  const verificationUrl = `${publicApiBaseUrl}/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}`;
  const delivery = await sendAccountEmail(
    email,
    'Verify your StudySphere email',
    `Verify your email address within 24 hours:\n${verificationUrl}`,
    `<p><a href="${verificationUrl}">Verify your email address</a>. This link expires in 24 hours.</p>`,
  );
  if (!delivery.sent) return response.status(502).json({ error: 'The verification email was not confirmed as sent. Check SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS in server/.env.' });
  return response.json({ message: 'If an unverified account exists for that address, a new verification link has been sent.' });
});

app.post('/api/auth/firebase-session', rateLimit(10, 15 * 60 * 1000), requireAllowedOrigin, async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Firebase sign-in is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Authentication is unavailable. Check JWT_SECRET in the backend environment.' });
  const token = request.body?.idToken;
  if (typeof token !== 'string' || token.length < 100 || token.length > 8192 || /\s/.test(token)) {
    return response.status(400).json({ error: 'Provide a valid Firebase sign-in token.' });
  }

  try {
    const identity = await verifyFirebaseIdentity(getFirebaseAdminAuth(), token);
    const user = await linkFirebaseIdentity(usersCollection, identity);
    const mongoUser = await usersCollection.findOne({ firebaseUid: identity.uid }, { projection: { sessionVersion: 1 } });
    if (!mongoUser) {
      return response.status(503).json({ error: 'The account could not be loaded. Please try signing in again.' });
    }
    const session = createAccessToken(mongoUser._id.toString(), process.env.JWT_SECRET, Date.now(), mongoUser.sessionVersion || 0);
    response.setHeader('Set-Cookie', sessionCookie(session));
    return response.json({ user });
  } catch (error) {
    if (error instanceof FirebaseAdminConfigurationError) {
      return response.status(503).json({ error: 'Firebase Admin credentials are unavailable. Configure local Application Default Credentials or the backend host identity.' });
    }
    if (error instanceof FirebaseIdentityError) {
      return response.status(error.status).json({ error: error.message });
    }
    console.error(`Firebase sign-in failed (${error?.code || error?.name || 'authentication error'}).`);
    return response.status(503).json({ error: 'Firebase sign-in is temporarily unavailable. Please try again.' });
  }
});

app.post('/api/auth/login', rateLimit(10, 15 * 60 * 1000), async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Sign-in is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Set a unique JWT_SECRET of at least 32 characters in server/.env before enabling authentication.' });
  const email = normalizeEmail(request.body?.email);
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!email || !password || password.length > 128) return response.status(400).json({ error: 'Enter a valid email address and password.' });
  const user = await usersCollection.findOne({ email });
  if (!user) {
    await hashPassword('studysphere-invalid-login-check');
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (typeof user.passwordHash !== 'string') {
    await hashPassword('studysphere-invalid-login-check');
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (!await verifyPassword(password, user.passwordHash)) {
    return response.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (!user.emailVerified) {
    return response.status(403).json({ error: 'Verify your email before signing in. You can request a new verification link below.' });
  }

  const session = createAccessToken(user._id.toString(), process.env.JWT_SECRET, Date.now(), user.sessionVersion || 0);
  response.setHeader('Set-Cookie', sessionCookie(session));
  return response.json({ user: { id: user._id.toString(), name: user.name, email: user.email } });
});

app.get('/api/auth/me', optionalAuth, (request, response) => {
  return response.json({ user: request.user });
});

app.post('/api/auth/logout', requireAllowedOrigin, (_request, response) => {
  response.setHeader('Set-Cookie', clearSessionCookie());
  return response.json({ message: 'You have signed out.' });
});

app.patch('/api/auth/profile', optionalAuth, requireAuth, requireAllowedOrigin, async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Profile updates are unavailable.' });
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    return response.status(400).json({ error: 'Names must contain 1-80 printable characters.' });
  }
  await usersCollection.updateOne({ _id: new ObjectId(request.user.id) }, { $set: { name, updatedAt: new Date() } });
  request.user.name = name;
  return response.json({ user: request.user });
});

const genericResetMessage = 'If an account exists for that address, password reset instructions will be sent if email delivery succeeds. This response does not confirm whether an account exists.';

app.post('/api/auth/forgot-password', rateLimit(5, 60 * 60 * 1000), async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Password reset is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Authentication is unavailable. Check JWT_SECRET in server/.env.' });
  const email = normalizeEmail(request.body?.email);
  if (!email) return response.status(400).json({ error: 'Enter a valid email address.' });
  const missingSmtp = missingSmtpSettings();
  if (missingSmtp.length) {
    return response.status(503).json({ error: `Password reset email is unavailable. Configure ${missingSmtp.join(', ')} in server/.env.` });
  }

  const user = await usersCollection.findOne({ email, emailVerified: true });
  if (user) {
    const resetToken = createOpaqueToken();
    await usersCollection.updateOne({ _id: user._id }, {
      $set: {
        resetTokenHash: hashOpaqueToken(resetToken),
        resetExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const resetUrl = `${publicApiBaseUrl}/api/auth/reset-password?token=${encodeURIComponent(resetToken)}`;
    const delivery = await sendAccountEmail(
      email,
      'Reset your StudySphere password',
      `A password reset was requested for your account. Set a new password within one hour:\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`,
      `<p>A password reset was requested for your account.</p><p><a href="${resetUrl}">Set a new password</a>. This link expires in one hour.</p><p>If you did not request this, you can ignore this message.</p>`,
    );
    if (!delivery.sent) {
      await usersCollection.updateOne({ _id: user._id, resetTokenHash: hashOpaqueToken(resetToken) }, {
        $unset: { resetTokenHash: '', resetExpiresAt: '' },
      });
    }
  }
  return response.status(202).json({ message: genericResetMessage });
});

app.get('/api/auth/reset-password', rateLimit(20, 15 * 60 * 1000), async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Password reset is unavailable.' });
  const token = typeof request.query.token === 'string' ? request.query.token : '';
  const clientResetUrl = `${clientBaseUrl}/?reset=invalid`;
  if (token.length < 20 || token.length > 200) {
    response.setHeader('Set-Cookie', clearResetCookie());
    return response.redirect(302, clientResetUrl);
  }
  const user = await usersCollection.findOne({
    resetTokenHash: hashOpaqueToken(token),
    resetExpiresAt: { $gt: new Date() },
    emailVerified: true,
  }, { projection: { _id: 1 } });
  if (!user) {
    response.setHeader('Set-Cookie', clearResetCookie());
    return response.redirect(302, clientResetUrl);
  }
  response.setHeader('Set-Cookie', resetCookie(token));
  return response.redirect(302, `${clientBaseUrl}/?reset=1`);
});

app.post('/api/auth/reset-password', rateLimit(10, 15 * 60 * 1000), async (request, response) => {
  if (!usersCollection) return response.status(503).json({ error: 'MongoDB is not connected. Password reset is unavailable.' });
  if (!validSessionSecret()) return response.status(503).json({ error: 'Authentication is unavailable. Check JWT_SECRET in server/.env.' });
  const token = readCookie(request, resetCookieName);
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!token || token.length < 20 || token.length > 200) {
    response.setHeader('Set-Cookie', clearResetCookie());
    return response.status(400).json({ error: 'The password reset link is invalid, expired, or already used.' });
  }
  if (password.length < 10 || password.length > 128) return response.status(400).json({ error: 'Passwords must be 10-128 characters long.' });
  const passwordHash = await hashPassword(password);
  const result = await usersCollection.updateOne({
    resetTokenHash: hashOpaqueToken(token),
    resetExpiresAt: { $gt: new Date() },
    emailVerified: true,
  }, {
    $set: { passwordHash, passwordUpdatedAt: new Date() },
    $inc: { sessionVersion: 1 },
    $unset: { resetTokenHash: '', resetExpiresAt: '' },
  });
  if (!result.modifiedCount) {
    response.setHeader('Set-Cookie', clearResetCookie());
    return response.status(400).json({ error: 'The password reset link is invalid, expired, or already used.' });
  }
  response.setHeader('Set-Cookie', clearResetCookie());
  return response.json({ message: 'Password updated. Sign in with your new password.' });
});

app.get('/api/dashboard/stats', optionalAuth, async (request, response) => {
  if (!roomsCollection || !notesCollection || !resourcesCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Dashboard statistics are unavailable.' });
  }
  const roomFilter = request.user ? { createdBy: request.user.id } : {};
  const rooms = await roomsCollection.find(roomFilter).sort({ createdAt: -1 }).toArray();
  const roomIds = rooms.map((item) => item._id);
  const roomDataFilter = roomIds.length ? { room: { $in: roomIds } } : { room: { $in: [] } };
  const [roomsCount, notesCount, resourcesCount, recentRooms, recentNotes, recentResources] = await Promise.all([
    request.user ? Promise.resolve(rooms.length) : roomsCollection.countDocuments({}),
    notesCollection.countDocuments({ ...roomDataFilter, text: { $regex: '\\S' } }),
    resourcesCollection.countDocuments(roomDataFilter),
    roomsCollection.find(roomFilter).sort({ createdAt: -1 }).limit(5).project({ _id: 1, createdAt: 1 }).toArray(),
    notesCollection.find(roomDataFilter).sort({ updatedAt: -1 }).limit(5).project({ room: 1, updatedAt: 1 }).toArray(),
    resourcesCollection.find(roomDataFilter).sort({ createdAt: -1 }).limit(5).project({ room: 1, name: 1, createdAt: 1 }).toArray(),
  ]);
  const activity = [
    ...recentRooms.map((item) => ({ kind: 'room', title: `Study room ${item._id} created`, at: item.createdAt })),
    ...recentNotes.map((item) => ({ kind: 'notes', title: `Notes updated in ${item.room}`, at: item.updatedAt })),
    ...recentResources.map((item) => ({ kind: 'resource', title: `${item.name} shared in ${item.room}`, at: item.createdAt })),
  ].filter((item) => item.at instanceof Date && !Number.isNaN(item.at.getTime()))
    .sort((left, right) => right.at - left.at)
    .slice(0, 5);

  return response.json({
    scope: request.user ? 'your rooms' : 'community',
    stats: { rooms: roomsCount, notes: notesCount, resources: resourcesCount },
    activity,
  });
});

app.post('/api/rooms', optionalAuth, rateLimit(30, 60 * 60 * 1000), async (request, response) => {
  if (!roomsCollection) return response.status(503).json({ error: 'MongoDB is not connected. Room creation is unavailable.' });
  const roomId = `study-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const room = {
    _id: roomId,
    createdAt: new Date(),
    createdBy: request.user?.id || null,
    memberIds: request.user ? [request.user.id] : [],
  };
  await roomsCollection.insertOne(room);
  return response.status(201).json({ room: { id: room._id, createdAt: room.createdAt } });
});

app.post('/api/rooms/:room/join', optionalAuth, rateLimit(60, 60 * 60 * 1000), async (request, response) => {
  const roomId = request.params.room;
  if (!validRoomId(roomId)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!roomsCollection) return response.status(503).json({ error: 'MongoDB is not connected. Room joining is unavailable.' });
  const room = await findRoomForJoin(roomId);
  if (!room) return response.status(404).json({ error: `Study room "${roomId}" does not exist. Check the ID or create a room.` });
  if (request.user) {
    await roomsCollection.updateOne({ _id: roomId }, { $addToSet: { memberIds: request.user.id } });
  }
  return response.json({ room: { id: room._id, createdAt: room.createdAt } });
});

app.get('/api/notes/:room', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!notesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });

  const note = await notesCollection.findOne({ room: request.params.room });
  return response.json({ text: note?.text || '' });
});

app.put('/api/notes/:room', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!notesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });
  if (!request.body || typeof request.body.text !== 'string') {
    return response.status(400).json({ error: 'Provide notes as a text string.' });
  }
  if (!request.body.text.trim()) {
    return response.status(400).json({ error: 'Write a note before saving.' });
  }
  if (request.body.text.length > 50000) {
    return response.status(400).json({ error: 'Notes must be 50,000 characters or fewer.' });
  }

  await notesCollection.updateOne(
    { room: request.params.room },
    { $set: { text: request.body.text, updatedAt: new Date() } },
    { upsert: true },
  );
  io.to(request.params.room).emit('notes:update', request.body.text);
  return response.json({ ok: true });
});

app.get('/api/resources/:room', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!resourcesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });

  const resources = await resourcesCollection
    .find({ room: request.params.room })
    .sort({ createdAt: -1 })
    .toArray();
  return response.json({
    resources: resources.map((resource) => ({
      id: resource._id.toString(),
      name: resource.name,
      mimeType: resource.mimeType,
      url: resource.url,
      size: resource.size,
      createdAt: resource.createdAt,
    })),
  });
});

app.get('/api/resources/:room/:id/preview', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!ObjectId.isValid(request.params.id)) {
    return response.status(400).json({ error: 'Resource ID is invalid.' });
  }
  if (!resourcesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });

  const resource = await resourcesCollection.findOne({
    _id: new ObjectId(request.params.id),
    room: request.params.room,
  });
  if (!resource) return response.status(404).json({ error: 'The resource was not found in this room.' });
  if (resource.mimeType !== 'application/pdf') return response.json({ url: resource.url });

  let delivery;
  try {
    delivery = await fetch(resource.url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  } catch (error) {
    console.error(`Cloudinary PDF check failed (${error?.name || 'delivery error'}).`);
    return response.status(502).json({ error: 'Cloudinary could not verify PDF delivery. Check the resource URL and try again.' });
  }
  if (delivery.status === 401 || delivery.status === 403) {
    return response.status(503).json({ error: 'Cloudinary is blocking PDF delivery (deny or ACL failure). Enable PDF delivery and shared access in the Cloudinary account security settings.' });
  }
  if (!delivery.ok) {
    return response.status(502).json({ error: `Cloudinary could not deliver this PDF (HTTP ${delivery.status}).` });
  }
  return response.json({ url: resource.url });
});

app.post('/api/resources/:room', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!resourcesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return response.status(503).json({ error: 'Resource uploads are unavailable. Configure CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in server/.env.' });
  }
  if (!request.body || typeof request.body.name !== 'string' || typeof request.body.mimeType !== 'string' || typeof request.body.data !== 'string') {
    return response.status(400).json({ error: 'Provide a file name, supported MIME type, and base64 file data.' });
  }

  const name = request.body.name.split(/[\\/]/).pop().trim();
  const mimeType = request.body.mimeType;
  const dataMatch = request.body.data.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!name || name.length > 180 || /[\u0000-\u001f\u007f]/.test(name)) {
    return response.status(400).json({ error: 'File names must contain 1-180 printable characters.' });
  }
  if (!dataMatch || dataMatch[1] !== mimeType || dataMatch[2].length % 4 !== 0) {
    return response.status(400).json({ error: 'Upload a valid PDF, JPEG, PNG, or WebP file.' });
  }

  const fileBuffer = Buffer.from(dataMatch[2], 'base64');
  if (!fileBuffer.length || fileBuffer.length > 10 * 1024 * 1024 || fileBuffer.toString('base64').replace(/=+$/, '') !== dataMatch[2].replace(/=+$/, '')) {
    return response.status(400).json({ error: 'Files must be smaller than 10 MB and contain valid file data.' });
  }
  if (!validResourceContent(mimeType, fileBuffer)) {
    return response.status(400).json({ error: 'The file content does not match its PDF, JPEG, PNG, or WebP type.' });
  }

  const resourceType = mimeType === 'application/pdf' ? 'raw' : 'image';
  const extension = (name.includes('.') ? name.split('.').pop() : '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const publicId = `${randomUUID()}${resourceType === 'raw' && extension ? `.${extension}` : ''}`;
  let uploaded;
  try {
    uploaded = await new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream({
        folder: 'studysphere/resources',
        public_id: publicId,
        resource_type: resourceType,
        overwrite: false,
      }, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        if (!result) {
          reject(new Error('Cloudinary returned an empty upload response.'));
          return;
        }
        resolve(result);
      });
      Readable.from([fileBuffer]).pipe(upload);
    });
  } catch (error) {
    console.error(`Cloudinary upload failed (${error?.name || 'upload error'}, status ${error?.http_code || 'unknown'}).`);
    return response.status(502).json({ error: 'Cloudinary could not upload this file. Check its configuration and try again.' });
  }

  const document = {
    room: request.params.room,
    name,
    mimeType,
    url: uploaded.secure_url,
    publicId: uploaded.public_id,
    cloudinaryResourceType: resourceType,
    size: fileBuffer.length,
    createdAt: new Date(),
  };
  let insertResult;
  try {
    insertResult = await resourcesCollection.insertOne(document);
  } catch (error) {
    try {
      await cloudinary.uploader.destroy(uploaded.public_id, { resource_type: resourceType });
    } catch (cleanupError) {
      console.error(`Cloudinary cleanup failed (${cleanupError?.name || 'cleanup error'}).`);
    }
    throw error;
  }

  io.to(request.params.room).emit('resources:update');
  return response.status(201).json({
    ok: true,
    resource: {
      id: insertResult.insertedId.toString(),
      name: document.name,
      mimeType: document.mimeType,
      url: document.url,
      size: document.size,
      createdAt: document.createdAt,
    },
  });
});

app.delete('/api/resources/:room/:id', async (request, response) => {
  if (!validRoomId(request.params.room)) {
    return response.status(400).json({ error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
  }
  if (!ObjectId.isValid(request.params.id)) {
    return response.status(400).json({ error: 'Resource ID is invalid.' });
  }
  if (!resourcesCollection || !roomsCollection) {
    return response.status(503).json({ error: 'MongoDB is not connected. Check MONGODB_URI and restart the server.' });
  }
  if (!await findRoomForJoin(request.params.room)) return response.status(404).json({ error: 'This study room does not exist.' });
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    return response.status(503).json({ error: 'Resource management is unavailable. Configure the Cloudinary credentials in server/.env.' });
  }

  const resource = await resourcesCollection.findOne({
    _id: new ObjectId(request.params.id),
    room: request.params.room,
  });
  if (!resource) return response.status(404).json({ error: 'The resource was not found in this room.' });

  let deletion;
  try {
    deletion = await cloudinary.uploader.destroy(resource.publicId, {
      resource_type: resource.cloudinaryResourceType,
    });
  } catch (error) {
    console.error(`Cloudinary resource deletion failed (${error?.name || 'delete error'}).`);
    return response.status(502).json({ error: 'Cloudinary could not remove this resource. Please try again.' });
  }
  if (deletion.result !== 'ok' && deletion.result !== 'not found') {
    return response.status(502).json({ error: 'Cloudinary could not remove this resource. Please try again.' });
  }
  await resourcesCollection.deleteOne({ _id: resource._id, room: request.params.room });
  io.to(request.params.room).emit('resources:update');
  return response.json({ ok: true });
});

app.post('/api/ai/groq', async (request, response) => {
  const input = getPrompt(request.body);
  if (input.error) return response.status(400).json({ error: input.error });
  if (!process.env.GROQ_API_KEY) {
    return response.status(503).json({ error: 'Groq is not configured. Set GROQ_API_KEY in server/.env and restart the server.' });
  }

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const result = await groq.chat.completions.create({
      model: 'qwen/qwen3.8-27b',
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: 512,
    });
    const text = result.choices[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      return response.status(502).json({ error: 'Groq returned an empty response. Please try again.' });
    }
    return response.json({ text });
  } catch (error) {
    return sendProviderError('Groq', error, response);
  }
});

app.post('/api/ai/gemini', async (request, response) => {
  const input = getPrompt(request.body);
  if (input.error) return response.status(400).json({ error: input.error });
  if (!process.env.GEMINI_API_KEY) {
    return response.status(503).json({ error: 'Gemini is not configured. Set GEMINI_API_KEY in server/.env and restart the server.' });
  }

  try {
    const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = gemini.getGenerativeModel({ model: 'gemini-3.1-flash-lite' });
    const result = await model.generateContent(input.prompt);
    const text = result.response.text();
    if (!text.trim()) {
      return response.status(502).json({ error: 'Gemini returned an empty response. Please try again.' });
    }
    return response.json({ text });
  } catch (error) {
    return sendProviderError('Gemini', error, response);
  }
});

app.get('/api/libreoffice', (_request, response) => {
  execFile('libreoffice', ['--version'], (error, stdout) => {
    if (error) {
      return response.status(503).json({ error: 'LibreOffice is not available on the server. Install it to enable this integration.' });
    }
    return response.json({ version: stdout.trim() });
  });
});

io.on('connection', (socket) => {
  socket.on('room:join', async (roomId, acknowledge) => {
    const reply = typeof acknowledge === 'function' ? acknowledge : () => {};
    if (!validRoomId(roomId)) {
      reply({ ok: false, error: 'Room ID must be 1-80 letters, numbers, hyphens, or underscores.' });
      return;
    }

    try {
      if (!roomsCollection) {
        reply({ ok: false, error: 'MongoDB is not connected. The room cannot be verified right now.' });
        return;
      }
      if (!await findRoomForJoin(roomId)) {
        reply({ ok: false, error: `Study room "${roomId}" does not exist. Check the ID or create a room.` });
        return;
      }
      for (const joinedRoom of socket.rooms) {
        if (joinedRoom !== socket.id) await socket.leave(joinedRoom);
      }
      await socket.join(roomId);
      reply({ ok: true, room: roomId });
    } catch (error) {
      console.error(`Socket room join failed (${error?.name || 'socket error'}).`);
      reply({ ok: false, error: 'Unable to join the study room. Reconnect and try again.' });
    }
  });
});

app.use((error, _request, response, _next) => {
  if (response.headersSent) return;
  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  if (error?.type === 'entity.too.large') {
    return response.status(413).json({ error: 'Request body is too large.' });
  }
  if (error?.message === 'This origin is not allowed by the server CORS configuration.') {
    return response.status(403).json({ error: error.message });
  }
  console.error(`Request failed (${error?.name || 'server error'}).`);
  return response.status(500).json({ error: 'The server could not complete the request. Check the server logs.' });
});

async function start() {
  const configurationErrors = productionConfigurationErrors();
  if (configurationErrors.length) {
    console.error(`Production configuration is incomplete: ${configurationErrors.join(' ')}`);
    process.exitCode = 1;
    return;
  }
  try {
    await mongoClient.connect();
    const database = mongoClient.db(databaseName);
    notesCollection = database.collection('notes');
    resourcesCollection = database.collection('resources');
    roomsCollection = database.collection('rooms');
    usersCollection = database.collection('users');
    await usersCollection.createIndex({ email: 1 }, { unique: true, name: 'unique_user_email' });
    await usersCollection.createIndex({ firebaseUid: 1 }, { unique: true, sparse: true, name: 'unique_firebase_uid' });
    await roomsCollection.updateOne(
      { _id: 'study-room-1' },
      { $setOnInsert: { createdAt: new Date(), createdBy: null } },
      { upsert: true },
    );
    const legacyRoomIds = new Set([
      ...(await notesCollection.distinct('room')),
      ...(await resourcesCollection.distinct('room')),
    ]);
    for (const roomId of legacyRoomIds) {
      if (!validRoomId(roomId)) continue;
      await roomsCollection.updateOne(
        { _id: roomId },
        { $setOnInsert: { createdAt: new Date(), createdBy: null, migrated: true } },
        { upsert: true },
      );
    }
    console.log('MongoDB connected.');
  } catch (error) {
    console.error(`MongoDB connection failed (${error?.name || 'connection error'}). Database-backed features are unavailable until the server reconnects.`);
  }

  const port = Number(process.env.PORT || 5000);
  server.listen(port, () => console.log(`Study API ready on port ${port}.`));
}

start().catch((error) => {
  console.error(`Server startup failed (${error?.name || 'startup error'}).`);
  process.exitCode = 1;
});
