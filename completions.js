// api/openrouter/chat/completions.js
//
// POST /api/openrouter/chat/completions
//
// This is the ONLY endpoint the ZenQ frontend currently calls (see
// index.html's AI._streamOpenRouterOnce). Contract preserved exactly:
//   Request:  { model, messages, stream: true, temperature? }
//   Response: text/event-stream, OpenRouter's native SSE framing
//
// New requirement layered on top: every request must carry a verified
// Firebase ID token in the Authorization header. The frontend was
// patched (see PATCH_NOTES.md) to attach it; requests without one are
// rejected with 401 before we ever call OpenRouter.
//
// Runs as a Vercel Node.js serverless function (NOT Edge) because
// Firebase Admin's verifyIdToken() needs Node's crypto internals.
// Node functions on Vercel support streaming responses, so we still
// get true SSE all the way through — no separate Edge hop needed.

const { verifyRequestToken } = require('../../../lib/verify-token');
const { streamChatCompletion } = require('../../../lib/openrouter-proxy');
const { sendError, AppError } = require('../../../lib/errors');

// Explicit Node runtime (this is the default for files under /api on
// Vercel, but stated here so the SSE/streaming requirement is obvious
// to anyone reading this file — do not switch this to 'edge').
module.exports.config = {
  runtime: 'nodejs',
  maxDuration: 60, // seconds; long enough for slow models, still bounded
};

module.exports = async function handler(req, res) {
  // ---- CORS ----
  // Locked to a single configured origin rather than '*', since this
  // endpoint requires credentials (the Authorization header) and
  // browsers won't send those to a wildcard-CORS endpoint anyway.
  //
  // IMPORTANT: these headers (and the OPTIONS short-circuit below) must
  // run BEFORE the POST-only method check. Browsers send an OPTIONS
  // preflight ahead of the real POST for any cross-origin request that
  // carries an Authorization header; if that preflight falls through to
  // the "POST only" check it gets rejected with 405 and has no CORS
  // headers on it, so the browser blocks the real request before it's
  // ever sent. CORS handling has to happen first, for every method.
  const allowedOrigin = process.env.FRONTEND_URL || '';
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return sendError(res, new AppError(405, 'METHOD_NOT_ALLOWED', 'Only POST is supported.'));
  }

  try {
    // ---- Authentication ----
    // Never trust any user identifier from the request body — identity
    // comes exclusively from the verified token. `user` is available
    // here for future use (rate limiting per-uid, usage logging, etc.)
    // even though the proxy itself doesn't need it today.
    const user = await verifyRequestToken(req);

    // ---- Body parsing ----
    // Vercel Node functions parse JSON bodies automatically when
    // Content-Type is application/json, but we guard in case a client
    // sends something else or an empty body.
    const body = req.body;
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
    }

    // ---- Safe request log (no keys, no message content) ----
    console.log(
      `[chat] uid=${user.uid} model=${body.model || 'unknown'} messageCount=${Array.isArray(body.messages) ? body.messages.length : 0}`
    );

    // ---- Proxy + stream ----
    await streamChatCompletion(body, res);
  } catch (err) {
    sendError(res, err);
  }
};
