// lib/firebase-admin.js
//
// Initializes the Firebase Admin SDK exactly once per warm serverless
// instance. Vercel Node functions can be reused across invocations
// ("warm starts"), so re-running initializeApp() on every request would
// throw ("app already exists"). Guarding on admin.apps.length is the
// standard fix.
//
// Required env vars (see .env.example):
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY   <- must have literal \n sequences un-escaped

const admin = require('firebase-admin');

function getFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env vars can't hold real newlines, so the private key is stored with
  // literal "\n" escape sequences and must be converted back at runtime.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, ' +
      'FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY in your environment.'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return admin;
}

module.exports = { getFirebaseAdmin };
