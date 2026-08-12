// lib/verify-token.js
//
// Pulls the Firebase ID token out of the Authorization header and
// verifies it against the Firebase Admin SDK. This is the ONLY source
// of user identity the backend trusts — a userId sent in the request
// body is never honored (see api/openrouter/chat/completions.js).
//
// Throws an AuthError (with .status = 401) on any failure — missing
// header, malformed header, expired token, revoked token, wrong
// project, etc. Callers should catch this and respond with a 401 in
// the app's standard error shape (see lib/errors.js).

const { getFirebaseAdmin } = require('./firebase-admin');
const { AppError } = require('./errors');

class AuthError extends AppError {
  constructor(message) {
    super(401, 'AUTH_REQUIRED', message);
  }
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ uid: string, email: string | null }>}
 */
async function verifyRequestToken(req) {
  const header = req.headers['authorization'] || req.headers['Authorization'];

  if (!header || typeof header !== 'string' || !header.startsWith('Bearer ')) {
    throw new AuthError('Missing or malformed Authorization header. Expected "Bearer <firebase-id-token>".');
  }

  const idToken = header.slice('Bearer '.length).trim();
  if (!idToken) {
    throw new AuthError('Empty bearer token.');
  }

  let decoded;
  try {
    const admin = getFirebaseAdmin();
    // checkRevoked:true costs an extra lookup but ensures a signed-out /
    // revoked session can't keep streaming chat completions.
    decoded = await admin.auth().verifyIdToken(idToken, true);
  } catch (err) {
    // Firebase Admin throws distinguishable error codes; we don't leak
    // them verbatim to the client, but they're safe to log server-side.
    console.error('[auth] Token verification failed:', err.code || err.message);
    throw new AuthError('Invalid or expired authentication token.');
  }

  return {
    uid: decoded.uid,
    email: decoded.email || null,
  };
}

module.exports = { verifyRequestToken, AuthError };
