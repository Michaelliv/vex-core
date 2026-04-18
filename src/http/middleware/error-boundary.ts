/**
 * errorBoundary — catches anything the chain throws that the router's
 * own onError handlers didn't handle. Renders HttpError directly;
 * wraps other errors as HttpError.internal with optional stack trace
 * for dev.
 *
 * This usually lives at the top of the middleware stack so every
 * downstream error surfaces as a proper HTTP response instead of a
 * 500 from Bun.serve's default fallback.
 */

import { HttpError, isHttpError } from "../error.js";
import type { Middleware } from "../types.js";

export interface ErrorBoundaryOptions {
  /** Include stack traces in 500 response bodies. Default false. */
  devStackTraces?: boolean;
  /** Log errors. Default console.error. */
  logger?: (err: unknown) => void;
}

export function errorBoundary(options: ErrorBoundaryOptions = {}): Middleware {
  const devStackTraces = options.devStackTraces ?? false;
  const logger =
    options.logger ??
    ((err: unknown) => {
      // biome-ignore lint/suspicious/noConsole: last-resort error log
      console.error("[error]", err);
    });

  return async (_ctx, next) => {
    try {
      return await next();
    } catch (err) {
      if (isHttpError(err)) {
        if (err.status >= 500) logger(err);
        return err.toResponse();
      }
      logger(err);
      if (devStackTraces) {
        const msg =
          err instanceof Error ? (err.stack ?? err.message) : String(err);
        return new Response(msg, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return HttpError.internal(
        err instanceof Error ? err.message : String(err),
        err,
      ).toResponse();
    }
  };
}
