/**
 * vexHandler — the vex engine adapted as a Router.
 *
 * Exposes three routes relative to wherever it's mounted:
 *   POST /query      JSON body { name, args? } → { data } | { error }
 *   POST /mutate     JSON body { name, args? } → { data } | { error }
 *   ALL  /webhook/*  → vex.handleWebhook
 *
 * Reactive reads (the "live state" surface) are handled by
 * `vexWebSocket` over a WebSocket at whatever path the host wires
 * up — typically `/subscribe`. One connection per client multiplexes
 * many subscriptions plus one-shot query/mutate calls; see
 * `vex-websocket.ts` for the wire protocol.
 *
 * Why split HTTP and WS into two factories
 *   The Bun.serve API requires a `Server` reference to perform a
 *   WebSocket upgrade, and the Router abstraction here only sees
 *   `Request`. So vex-core ships HTTP one-shot RPC as a Router
 *   (mountable anywhere) and the live channel as a separate
 *   collection of `(upgrade, open, message, close)` hooks the host
 *   plumbs into Bun.serve directly.
 *
 * No CORS headers, no auth — those are separate middleware the caller
 * composes on top. This file is the dispatcher only.
 */

import type { Vex } from "../core/engine.js";
import type { VexUser } from "../core/types.js";
import { createRouter, type Router } from "./router.js";
import type { Handler, RequestCtx } from "./types.js";

export interface VexHandlerOptions {
  /**
   * Read a VexUser off the ctx. Defaults to `ctx.user` — i.e. whatever
   * auth middleware put there. Override to pull from session, or to
   * ignore user attribution entirely by returning null.
   */
  getUser?: (ctx: RequestCtx) => VexUser | null | undefined;
}

export function vexHandler(vex: Vex, opts: VexHandlerOptions = {}): Router {
  const getUser = opts.getUser ?? ((c: RequestCtx) => c.user ?? null);

  const router = createRouter();

  router.post("/query", makeQueryHandler(vex, getUser));
  router.post("/mutate", makeMutateHandler(vex, getUser));
  router.all("/webhook/*", makeWebhookHandler(vex));

  return router;
}

// ─── handlers ────────────────────────────────────────────────────────

function makeQueryHandler(
  vex: Vex,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    const body = await readJson(ctx.req);
    if (!body.name) {
      return json({ error: "Missing query name" }, 400);
    }
    try {
      const data = await vex.query(body.name, body.args ?? {}, {
        user: getUser(ctx),
      });
      return json({ data });
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

function makeMutateHandler(
  vex: Vex,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    const body = await readJson(ctx.req);
    if (!body.name) {
      return json({ error: "Missing mutation name" }, 400);
    }
    try {
      const data = await vex.mutate(body.name, body.args ?? {}, {
        user: getUser(ctx),
      });
      return json({ data });
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

function makeWebhookHandler(vex: Vex): Handler {
  return async (ctx: RequestCtx): Promise<Response> => {
    // URLPattern's `*` capture for `/webhook/*` lands in params["0"].
    // The leading slash is not captured, so prepend one; an empty
    // capture (the bare `/webhook` case) maps to "/".
    const captured = ctx.params["0"] ?? "";
    const webhookPath = captured ? `/${captured}` : "/";

    const rawBody = await ctx.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }

    const query: Record<string, string> = {};
    ctx.url.searchParams.forEach((v, k) => {
      query[k] = v;
    });

    const headers: Record<string, string> = {};
    ctx.req.headers.forEach((v, k) => {
      headers[k] = v;
    });

    try {
      const result = await vex.handleWebhook({
        body,
        rawBody,
        headers,
        method: ctx.req.method,
        path: webhookPath,
        query,
      });

      const status = result.status ?? 200;
      if (result.headers) {
        const respBody =
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? null);
        return new Response(respBody, {
          status,
          headers: result.headers,
        });
      }
      return json(result.body ?? null, status);
    } catch (err: unknown) {
      return json({ error: errorMessage(err) }, 500);
    }
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
