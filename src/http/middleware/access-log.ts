/**
 * accessLog — structured one-line-per-request log.
 *
 * Output looks like:
 *   GET /lanes -> 200 (12ms) [req=7hXp] user=alice
 * Easy to grep, easy to parse, stable column order.
 *
 * Uses console.log by default so it interleaves with the rest of the
 * server's output. Pass a custom logger for JSON lines / structured
 * shipping.
 */

import { isHttpError } from "../error.js";
import type { Middleware, RequestCtx } from "../types.js";

export interface AccessLogOptions {
  logger?: (line: string, ctx: RequestCtx, meta: AccessLogMeta) => void;
  /** Suppress logs for these paths (healthchecks, favicons). */
  skipPaths?: string[];
}

export interface AccessLogMeta {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string | null;
  userId: string | null;
}

export function accessLog(options: AccessLogOptions = {}): Middleware {
  const logger =
    options.logger ??
    ((line: string) => {
      // biome-ignore lint/suspicious/noConsole: access log is a console primitive
      console.log(line);
    });
  const skip = new Set(options.skipPaths ?? []);

  return async (ctx, next) => {
    if (skip.has(ctx.url.pathname)) return next();

    const start = performance.now();
    let response: Response;
    try {
      response = await next();
    } catch (err) {
      const dur = Math.round(performance.now() - start);
      // An HttpError is an intentional status — log it as such, not
      // as a 500. Anything else is an unexpected throw.
      const status = isHttpError(err) ? err.status : 500;
      const suffix = isHttpError(err) ? null : "error";
      const meta: AccessLogMeta = {
        method: ctx.req.method,
        path: ctx.url.pathname,
        status,
        durationMs: dur,
        requestId: (ctx.state.requestId as string | undefined) ?? null,
        userId: ctx.user?.id ?? null,
      };
      logger(format(meta, suffix), ctx, meta);
      throw err;
    }

    const dur = Math.round(performance.now() - start);
    const meta: AccessLogMeta = {
      method: ctx.req.method,
      path: ctx.url.pathname,
      status: response.status,
      durationMs: dur,
      requestId: (ctx.state.requestId as string | undefined) ?? null,
      userId: ctx.user?.id ?? null,
    };
    logger(format(meta, null), ctx, meta);
    return response;
  };
}

function format(m: AccessLogMeta, suffix: string | null): string {
  const parts = [
    `${m.method} ${m.path}`,
    `->`,
    `${m.status}`,
    `(${m.durationMs}ms)`,
  ];
  if (m.requestId) parts.push(`[req=${m.requestId}]`);
  if (m.userId) parts.push(`user=${m.userId}`);
  if (suffix) parts.push(suffix);
  return parts.join(" ");
}
