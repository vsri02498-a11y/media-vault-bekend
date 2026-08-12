# Frontend patch notes

Three small, additive changes to `index.html`. Nothing was removed,
redesigned, or restructured — this is the one "backend integration
change" your spec allows for when it's genuinely required.

## What changed and why

The backend now requires a verified Firebase ID token on
`/api/openrouter/chat/completions`. The frontend previously sent no
auth header at all, so it needs a way to attach one.

### 1. New `getIdToken()` helper in the Firebase auth module

Added next to `signOutUser()`. Returns the current user's ID token,
or `null` if nobody's signed in. Firebase's SDK auto-refreshes an
expired token under the hood, so no manual refresh logic is needed.

### 2. Exposed it on `window.ZenQAuth`

Added `getIdToken` to the `window.ZenQAuth` export object, alongside
the existing `signInWithGoogle`, `signOutUser`, etc.

### 3. Attached it to the chat request

In `AI._streamOpenRouterOnce`, right before the `fetch()` call: grabs
the token and adds `Authorization: Bearer <token>` to the request
headers if one's available. If nobody's signed in, the request still
goes out without the header — the backend's existing 401 handling
takes it from there, using the same fail-fast/error-toast path the
frontend already has for any other 401.

## Applying it

The patched file is `index.html` in this same output — download it
and use it in place of your current one. If you've made other local
edits since the version you gave me, re-apply these three changes by
hand instead (they're small and self-contained — see the diff below).

```diff
@@ AI._streamOpenRouterOnce, just before the fetch() call @@
+    const idToken = await window.ZenQAuth?.getIdToken?.().catch(() => null);
+
     try {
       let res;
       try {
         res = await fetch(url, {
           method: 'POST',
-          headers: { 'Content-Type': 'application/json' },
+          headers: {
+            'Content-Type': 'application/json',
+            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
+          },
           body: JSON.stringify(body),
           signal: combined.signal,
         });

@@ Firebase auth module, after signOutUser() @@
+async function getIdToken() {
+  if (!auth) return null;
+  await authReady;
+  const user = auth.currentUser;
+  if (!user) return null;
+  try {
+    return await user.getIdToken();
+  } catch (err) {
+    console.error('[ZenQ] Failed to get ID token:', err);
+    return null;
+  }
+}

@@ window.ZenQAuth export @@
   signOutUser,
   friendlyAuthError,
   isBenignAuthCancel,
+  getIdToken,
 };
```

## Testing it

1. Deploy the backend, set `FRONTEND_URL` to wherever you're serving
   `index.html` from during testing (e.g. `http://localhost:5500`).
2. Open ZenQ, sign in (Google/email/phone — any method).
3. Set Settings → Backend URL to your deployed backend.
4. Send a chat message. In DevTools → Network, confirm the request to
   `/api/openrouter/chat/completions` carries an `Authorization: Bearer
   ...` header and gets a streaming 200 back.
5. Sign out, try sending again — should fail with a 401 and the
   existing "Backend rejected the request (unauthorized)" toast the
   frontend already has wired up for that status code.
