# ZenQ Backend

A single-purpose backend for the ZenQ AI frontend: verifies a Firebase
ID token, then proxies chat completions to OpenRouter without ever
exposing the OpenRouter API key to the browser.

## Scope

This build intentionally does **one thing**. The ZenQ frontend
(`index.html`) currently makes exactly one server call:

```
POST /api/openrouter/chat/completions
```

Everything else in a typical "full backend" spec — user profiles,
settings sync, file uploads, OCR — has no corresponding frontend call
yet, so none of it is built here. Adding those later means designing
new contracts from scratch when you're ready, not preserving existing
ones.

## What this backend does

1. Requires a valid Firebase ID token on every request
   (`Authorization: Bearer <token>`) — rejects with 401 if missing,
   malformed, expired, or revoked.
2. Validates the request body shape (`model`, `messages`).
3. Forwards the request to OpenRouter with the real API key attached
   server-side.
4. Streams OpenRouter's SSE response straight back to the client,
   byte for byte — no re-framing, so the frontend's existing SSE
   parser and retry logic keep working unmodified.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Firebase service account**
   Firebase Console → Project settings → Service accounts → Generate
   new private key. This downloads a JSON file with `project_id`,
   `client_email`, and `private_key` — you'll need those three values.

3. **Environment variables**
   Copy `.env.example` to `.env` and fill in:
   - `FRONTEND_URL` — your deployed frontend's exact origin (for CORS)
   - `OPENROUTER_API_KEY` — from https://openrouter.ai/keys
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
     — from the service account JSON above

   On Vercel, set these under Project Settings → Environment
   Variables instead of committing `.env`. For `FIREBASE_PRIVATE_KEY`,
   paste the value exactly as it appears in the JSON file (with
   literal `\n` sequences) — the code un-escapes them at runtime.

4. **Deploy**
   ```bash
   vercel deploy --prod
   ```

5. **Point the frontend at it**
   In ZenQ's Settings → Backend URL, enter your deployed URL (e.g.
   `https://zenq-backend.vercel.app`), or leave it blank if the
   frontend is served from the same domain as this backend.

## Required frontend change

The current frontend sends no headers on the chat request. Since this
backend now requires a Firebase ID token, `index.html` needs a small
patch to attach one — see `PATCH_NOTES.md` for the exact diff. This is
the one frontend change your own spec allows for ("unless a backend
integration change is absolutely required").

## Why Node functions, not Edge

Firebase Admin's `verifyIdToken()` relies on Node's crypto module,
which isn't available in Vercel's Edge runtime. Vercel Node
(serverless) functions support streaming responses, so token
verification and SSE streaming both happen in the same function —
no need to split into an Edge hop + Node hop.

## Error shape

All errors follow:

```json
{
  "success": false,
  "error": { "code": "AUTH_REQUIRED", "message": "..." }
}
```

HTTP status codes are preserved exactly as OpenRouter returns them
(or as generated for auth/validation failures), because the frontend's
retry logic keys off the status code, not the body.

## Extending this later

If you build out profile/settings/uploads/OCR down the line, follow
the same pattern: a `lib/` module per concern, a thin `api/` handler
that wires auth → validation → the module, and always verify identity
via `verify-token.js` — never trust a `userId` in the request body.
