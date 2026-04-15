import type { Vex } from "../core/engine.js";
import type { ExecContext } from "../core/tracer.js";
import type { VexUser } from "../core/types.js";

export interface HandlerOptions {
  corsOrigin?: string;
}

export function createHandler(
  basePath = "/vex",
  vex?: Vex,
  opts?: HandlerOptions,
) {
  const CORS = {
    "Access-Control-Allow-Origin": opts?.corsOrigin ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  let instance: Vex | undefined = vex;

  function setVex(v: Vex) {
    instance = v;
  }

  function getVex(): Vex {
    if (!instance)
      throw new Error(
        "Vex not initialized. Pass it to createHandler() or call setVex().",
      );
    return instance;
  }

  async function handle(
    req: Request,
    parent?: ExecContext,
    body?: any,
    url?: URL,
    user?: VexUser | null,
  ): Promise<Response> {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const resolved = url ?? new URL(req.url);
    const path = resolved.pathname;

    if (req.method === "GET" && path === `${basePath}/subscribe`)
      return handleSubscribe(req, resolved, user);
    if (req.method === "POST" && path === `${basePath}/query`)
      return handleQuery(
        body ?? (await req.json().catch(() => ({}))),
        parent,
        user,
      );
    if (req.method === "POST" && path === `${basePath}/mutate`)
      return handleMutate(
        body ?? (await req.json().catch(() => ({}))),
        parent,
        user,
      );

    const webhookPrefix = `${basePath}/webhook/`;
    if (path.startsWith(webhookPrefix))
      return handleWebhook(
        req,
        path.slice(basePath.length + "/webhook".length),
      );

    return json({ error: "Not found" }, 404);
  }

  async function handleQuery(
    body: any,
    parent?: ExecContext,
    user?: VexUser | null,
  ): Promise<Response> {
    try {
      if (!body.name) return json({ error: "Missing query name" }, 400);
      const result = await getVex().query(body.name, body.args ?? {}, {
        parent,
        user,
      });
      return json({ data: result });
    } catch (err: any) {
      return json({ error: err?.message }, 500);
    }
  }

  async function handleMutate(
    body: any,
    parent?: ExecContext,
    user?: VexUser | null,
  ): Promise<Response> {
    try {
      if (!body.name) return json({ error: "Missing mutation name" }, 400);
      const result = await getVex().mutate(body.name, body.args ?? {}, {
        parent,
        user,
      });
      return json({ data: result });
    } catch (err: any) {
      return json({ error: err?.message }, 500);
    }
  }

  async function handleWebhook(
    req: Request,
    webhookPath: string,
  ): Promise<Response> {
    try {
      const rawBody = await req.text();
      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      const url = new URL(req.url);
      const query: Record<string, string> = {};
      url.searchParams.forEach((v, k) => {
        query[k] = v;
      });

      const result = await getVex().handleWebhook({
        body,
        rawBody,
        headers: Object.fromEntries((req.headers as any).entries()),
        method: req.method,
        path: webhookPath,
        query,
      });

      // If the webhook returned custom headers (e.g. Content-Type: text/html),
      // use a raw Response instead of wrapping in JSON
      if (result.headers) {
        const h = { ...CORS, ...result.headers };
        const body =
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body ?? null);
        return new Response(body, { status: result.status ?? 200, headers: h });
      }

      return json(result.body ?? null, result.status ?? 200);
    } catch (err: any) {
      return json({ error: err?.message }, 500);
    }
  }

  function handleSubscribe(
    req: Request,
    url: URL,
    user?: VexUser | null,
  ): Response {
    const queryName = url.searchParams.get("name");
    if (!queryName) return json({ error: "Missing query name" }, 400);

    let args: Record<string, any>;
    try {
      args = JSON.parse(url.searchParams.get("args") || "{}");
    } catch {
      return json({ error: "Invalid args" }, 400);
    }

    const vex = getVex();
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const unsubscribe = await vex.subscribe(
          queryName,
          args,
          (data) => {
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
              );
            } catch {
              unsubscribe();
            }
          },
          user ? { user } : undefined,
        );
        req.signal?.addEventListener("abort", () => {
          unsubscribe();
          try {
            controller.close();
          } catch {}
        });
      },
    });

    return new Response(stream, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const jsonHeaders = { ...CORS, "Content-Type": "application/json" };

  function json(data: any, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
  }

  return { handle, setVex };
}
