/**
 * vexHandler — the vex engine adapted as a Router.
 *
 * Exposes four routes relative to wherever it's mounted:
 *   POST /query       JSON body { name, args? } → { data } | { error }
 *   POST /mutate      JSON body { name, args? } → { data } | { error }
 *   GET  /subscribe?name&args   SSE stream, one event per update
 *   ALL  /webhook/*             → vex.handleWebhook
 *
 * No CORS headers, no auth — those are separate middleware the caller
 * composes on top. This file is the dispatcher only.
 */

import type { Vex } from "../core/engine.js";
import type { VexUser } from "../core/types.js";
import { createRouter, Router } from "./router.js";
import type { Handler, RequestCtx } from "./types.js";

export interface VexHandlerOptions {
  /**
   * Read a VexUser off the ctx. Defaults to `ctx.user` — i.e. whatever
   * auth middleware put there. Override to pull from session, or to
   * ignore user attribution entirely by returning null.
   */
  getUser?: (ctx: RequestCtx) => VexUser | null | undefined;
}

export function vexHandler(
  vex: Vex,
  opts: VexHandlerOptions = {},
): Router {
  const getUser = opts.getUser ?? ((c: RequestCtx) => c.user ?? null);

  const router = createRouter();

  router.post("/query", makeQueryHandler(vex, getUser));
  router.post("/mutate", makeMutateHandler(vex, getUser));
  router.get("/subscribe", makeSubscribeHandler(vex, getUser));
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

function makeSubscribeHandler(
  vex: Vex,
  getUser: (ctx: RequestCtx) => VexUser | null | undefined,
): Handler {
  return (ctx: RequestCtx): Response => {
    const name = ctx.url.searchParams.get("name");
    if (!name) return json({ error: "Missing query name" }, 400);

    let args: Record<string, unknown> = {};
    const rawArgs = ctx.url.searchParams.get("args");
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        return json({ error: "Invalid args" }, 400);
      }
    }

    const user = getUser(ctx) ?? null;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let unsubscribe: (() => void) | null = null;
        try {
          unsubscribe = await vex.subscribe(
            name,
            args,
            (data) => {
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                unsubscribe?.();
              }
            },
            user ? { user } : undefined,
          );
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`,
            ),
          );
          controller.close();
          return;
        }
        ctx.signal.addEventListener("abort", () => {
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
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


