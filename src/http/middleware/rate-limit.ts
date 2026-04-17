/**
 * rateLimit — request-level rate limit using the existing
 * `RateLimiter`. Keyed by IP by default; pass a custom `key` to rate
 * limit by user, API key, route, or any combination.
 *
 * Over-limit requests get a 429 with `Retry-After`. Returns `X-RateLimit-*`
 * headers on every response so clients can self-throttle.
 */

import { RateLimiter } from "../../core/auth.js";
import { HttpError } from "../error.js";
import type { Middleware, RequestCtx } from "../types.js";

export interface RateLimitOptions {
  /** Max requests per window. */
  requests: number;
  /** Window size in seconds. */
  window: number;
  /**
   * Identity extractor. Default: first entry of X-Forwarded-For,
   * falling back to X-Real-IP, falling back to "unknown".
   */
  key?: (ctx: RequestCtx) => string;
  /** Label shown in the Retry-After message. Default "requests". */
  resource?: string;
}

export function rateLimit(options: RateLimitOptions): Middleware {
  const limiter = new RateLimiter();
  const limit = { requests: options.requests, window: options.window };
  const extractKey = options.key ?? defaultKey;

  // Periodic prune — cheap, runs every `window` seconds.
  const pruneHandle = setInterval(
    () => limiter.prune(),
    Math.max(1_000, options.window * 1000),
  );
  // Don't keep the process alive just for the pruner.
  pruneHandle.unref?.();

  return async (ctx, next) => {
    const identity = extractKey(ctx);
    const { allowed, retryAfter } = limiter.check(identity, limit);
    if (!allowed) {
      throw new HttpError(429, "Too Many Requests", {
        body: {
          error: "too_many_requests",
          retryAfter,
          resource: options.resource ?? "requests",
        },
        headers: {
          "retry-after": String(retryAfter),
          "x-ratelimit-limit": String(options.requests),
          "x-ratelimit-remaining": "0",
        },
      });
    }
    const response = await next();
    // Echo the limit on successful responses too; clients can plan.
    const headers = new Headers(response.headers);
    if (!headers.has("x-ratelimit-limit"))
      headers.set("x-ratelimit-limit", String(options.requests));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function defaultKey(ctx: RequestCtx): string {
  const xff = ctx.req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const real = ctx.req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
