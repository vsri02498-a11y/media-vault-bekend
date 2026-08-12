// lib/errors.js
//
// One error shape for the whole backend, matching what the ZenQ
// frontend's AI layer already expects: it reads `res.status` to decide
// whether to retry (see HTTP_ERROR_INFO / RETRYABLE_STATUSES in
// index.html) and reads the JSON body's message for the toast. Never
// send a raw provider error body or a stack trace to the client.

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }

  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

/**
 * Sends a normalized JSON error response and ends it.
 * Safe to call even after some bytes have already been written to the
 * response IF headers have not yet been sent (checked via res.headersSent).
 */
function sendError(res, err) {
  const status = err instanceof AppError ? err.status : 500;
  const body = err instanceof AppError
    ? err.toJSON()
    : {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Something went wrong. Please try again.',
        },
      };

  if (!(err instanceof AppError)) {
    // Unexpected errors are logged in full server-side, never surfaced
    // to the client (no stack traces in production responses).
    console.error('[unhandled]', err);
  }

  if (res.headersSent) {
    // We were already mid-stream (SSE headers sent) when this failed —
    // the client's SSE parser will just see the connection end. Nothing
    // more we can safely send at this point.
    res.end();
    return;
  }

  res.status(status).json(body);
}

module.exports = { AppError, sendError };
