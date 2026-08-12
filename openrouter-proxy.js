// lib/openrouter-proxy.js
//
// Thin streaming pass-through to OpenRouter's chat completions endpoint.
// Matches the contract the ZenQ frontend already codes against (see the
// AI object / _streamOpenRouterOnce in index.html):
//
//   - We forward { model, messages, stream:true, temperature? } as-is.
//   - We DO NOT transform, buffer, or re-frame the upstream SSE body —
//     the client's own parser expects OpenRouter's native
//     "data: {json}\n\n" framing terminated by "data: [DONE]".
//   - HTTP status codes are preserved exactly, because the client uses
//     them to decide whether to retry (408/429/500/502/503/504) or fail
//     fast (400/401/403/404). Swallowing/rewriting these would break
//     its retry logic.

const { AppError } = require('./errors');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 45_000; // longer than the client's 30s so we never race it

class ValidationError extends AppError {
  constructor(message) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

/**
 * Validates the incoming request body shape. Throws ValidationError
 * (400, fail-fast — matches client's no-retry-on-400 behavior) on any
 * problem.
 */
function validateBody(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object.');
  }
  if (typeof body.model !== 'string' || body.model.trim().length === 0) {
    throw new ValidationError('"model" is required and must be a non-empty string.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new ValidationError('"messages" is required and must be a non-empty array.');
  }
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
      throw new ValidationError('Each message must be an object with a "role".');
    }
  }
  if (body.temperature != null && typeof body.temperature !== 'number') {
    throw new ValidationError('"temperature" must be a number if provided.');
  }
}

/**
 * Streams an OpenRouter chat completion response directly onto `res`.
 * Sets SSE headers itself. Resolves once the upstream stream ends;
 * rejects with an AppError if the upstream call fails before any bytes
 * are sent (so the caller can still send a clean JSON error).
 *
 * @param {object} body - already-validated request body from the client
 * @param {import('http').ServerResponse} res
 */
async function streamChatCompletion(body, res) {
  validateBody(body);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Config problem, not a client problem — but we still fail fast
    // rather than hang, and we never echo the missing-key detail to
    // the client.
    console.error('[openrouter] OPENROUTER_API_KEY is not set');
    throw new AppError(500, 'CONFIG_ERROR', 'The AI service is not configured. Please try again later.');
  }

  const upstreamBody = {
    model: body.model,
    messages: body.messages,
    stream: true,
    ...(body.temperature != null ? { temperature: body.temperature } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  // If the client disconnects (closes tab, hits Stop), stop pulling from
  // upstream immediately instead of paying for tokens nobody will read.
  const onClientClose = () => controller.abort();
  res.on('close', onClientClose);

  let upstreamRes;
  try {
    upstreamRes = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // Recommended by OpenRouter for their leaderboard/attribution;
        // harmless to omit if you'd rather not send it.
        'HTTP-Referer': process.env.FRONTEND_URL || '',
        'X-Title': 'ZenQ AI',
      },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    res.off('close', onClientClose);
    if (err.name === 'AbortError') {
      // Either our own timeout or the client disconnecting. If the
      // client is gone there's nowhere to send a response anyway.
      throw new AppError(504, 'UPSTREAM_TIMEOUT', 'The AI provider took too long to respond.');
    }
    console.error('[openrouter] Network error reaching OpenRouter:', err.message);
    throw new AppError(502, 'UPSTREAM_UNREACHABLE', 'Could not reach the AI provider.');
  }

  if (!upstreamRes.ok) {
    clearTimeout(timeout);
    res.off('close', onClientClose);
    // Preserve the real status code so the client's retry logic
    // (RETRYABLE_STATUSES) behaves exactly as it already expects.
    let detail = '';
    try {
      const errJson = await upstreamRes.json();
      detail = errJson?.error?.message || '';
    } catch {
      /* upstream didn't return JSON — ignore, we don't forward raw text anyway */
    }
    console.warn(`[openrouter] Upstream ${upstreamRes.status}${detail ? ': ' + detail : ''}`);
    throw new AppError(
      upstreamRes.status,
      'UPSTREAM_ERROR',
      upstreamRes.status === 404
        ? `Model "${body.model}" was not found on OpenRouter.`
        : 'The AI provider returned an error.'
    );
  }

  if (!upstreamRes.body) {
    clearTimeout(timeout);
    res.off('close', onClientClose);
    throw new AppError(502, 'UPSTREAM_ERROR', 'The AI provider did not return a streamable response.');
  }

  // From here on, headers are about to be sent — any further failure
  // must end the stream rather than attempt a JSON error response.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering (nginx-style intermediaries)
  });

  try {
    // upstreamRes.body is a WHATWG ReadableStream in the Node fetch
    // implementation; pipe it through manually so we can clear the
    // timeout once real bytes start flowing.
    const reader = upstreamRes.body.getReader();
    let gotFirstChunk = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        clearTimeout(timeout);
      }
      res.write(value);
    }
  } catch (err) {
    console.warn('[openrouter] Stream interrupted:', err.message);
    // Nothing more we can do — headers are already sent. Just end it;
    // the client's reader will see the stream terminate.
  } finally {
    clearTimeout(timeout);
    res.off('close', onClientClose);
    res.end();
  }
}

module.exports = { streamChatCompletion, validateBody, ValidationError };
