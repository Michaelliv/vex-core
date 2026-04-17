/**
 * Body parser middleware.
 *
 * Populates `ctx.state.body` (parsed) and `ctx.state.rawBody` (string)
 * based on Content-Type. Subsequent handlers read the already-parsed
 * body from state instead of re-awaiting req.json(), which matters
 * because Request bodies can only be consumed once.
 *
 * Respects a size limit (default 1 MiB). Oversized requests produce a
 * 413 HttpError before any downstream work.
 *
 * Not run: multipart/form-data. Streaming uploads belong to a future
 * middleware that can expose each part without buffering.
 */

import { HttpError } from "../error.js";
import type { Middleware } from "../types.js";

export interface BodyParserOptions {
  /** Max bytes for any parsed body. Default 1 MiB. */
  limit?: number;
  /** Parse application/json. Default true. */
  json?: boolean;
  /** Parse application/x-www-form-urlencoded. Default true. */
  urlencoded?: boolean;
  /** Parse text/* as a string. Default true. */
  text?: boolean;
}

const DEFAULT_LIMIT = 1024 * 1024;

export function bodyParser(options: BodyParserOptions = {}): Middleware {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const parseJson = options.json ?? true;
  const parseUrl = options.urlencoded ?? true;
  const parseText = options.text ?? true;

  return async (ctx, next) => {
    if (
      ctx.req.method === "GET" ||
      ctx.req.method === "HEAD" ||
      ctx.req.method === "OPTIONS"
    ) {
      return next();
    }

    const contentType =
      ctx.req.headers.get("content-type")?.toLowerCase() ?? "";
    const contentLength = Number(ctx.req.headers.get("content-length") ?? "0");
    if (contentLength && contentLength > limit) {
      throw new HttpError(413, "Payload too large");
    }

    if (parseJson && contentType.startsWith("application/json")) {
      const raw = await ctx.req.text();
      if (raw.length > limit) throw new HttpError(413, "Payload too large");
      ctx.state.rawBody = raw;
      try {
        ctx.state.body = raw.length > 0 ? JSON.parse(raw) : null;
      } catch {
        throw HttpError.badRequest("Invalid JSON body");
      }
      return next();
    }

    if (
      parseUrl &&
      contentType.startsWith("application/x-www-form-urlencoded")
    ) {
      const raw = await ctx.req.text();
      if (raw.length > limit) throw new HttpError(413, "Payload too large");
      ctx.state.rawBody = raw;
      const parsed: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) parsed[k] = v;
      ctx.state.body = parsed;
      return next();
    }

    if (parseText && contentType.startsWith("text/")) {
      const raw = await ctx.req.text();
      if (raw.length > limit) throw new HttpError(413, "Payload too large");
      ctx.state.rawBody = raw;
      ctx.state.body = raw;
      return next();
    }

    // Unknown or multipart — leave the Request untouched; handlers
    // that care can still call ctx.req.formData() / .arrayBuffer().
    return next();
  };
}
