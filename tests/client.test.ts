import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import { Vex } from "../src/core/engine.js";
import {
  cors,
  createRouter,
  vexHandler,
} from "../src/http/index.js";

let vex: Vex;
let server: Server;
let base: string;

async function readSSEMessage(url: string): Promise<any> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const match = buf.match(/data: (.+)\n\n/);
    if (match) {
      reader.cancel();
      return JSON.parse(match[1]);
    }
  }
  throw new Error("SSE stream ended without data");
}

async function collectSSEMessages(
  url: string,
  count: number,
  timeoutMs = 3000,
): Promise<any[]> {
  const res = await fetch(url);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const messages: any[] = [];
  let buf = "";

  const deadline = Date.now() + timeoutMs;
  while (messages.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let match;
    while ((match = buf.match(/data: (.+)\n\n/))) {
      messages.push(JSON.parse(match[1]));
      buf = buf.slice(match.index! + match[0].length);
    }
  }
  reader.cancel();
  return messages;
}

beforeAll(async () => {
  vex = await Vex.create({
    transactional: sqliteAdapter(":memory:"),
    analytical: sqliteAdapter(":memory:"),
    plugins: [
      {
        name: "items",
        tables: { items: { columns: { name: "string", value: "number" } } },
        queries: {
          list: {
            args: {},
            handler: async (ctx) => ctx.db.table("items").all(),
          },
          byName: {
            args: { name: "string" },
            handler: async (ctx, args) =>
              ctx.db.table("items").where("name", "=", args.name).all(),
          },
        },
        mutations: {
          create: {
            args: { name: "string", value: "number" },
            handler: async (ctx, args) => ctx.db.table("items").insert(args),
          },
        },
      },
    ],
  });

  // Build the composed app exactly the way dripyard will:
  //   cors  →  mount("/vex", vexHandler(vex))
  const app = createRouter().use(cors()).mount("/vex", vexHandler(vex));
  server = Bun.serve({
    port: 0,
    fetch: (req) => app.handle(req),
  });
  base = `http://localhost:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await vex.close();
});

describe("CORS and routing", () => {
  test("OPTIONS returns 204 with CORS headers", async () => {
    const res = await fetch(`${base}/vex/query`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type",
    );
  });

  test("responses include CORS headers", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.list", args: {} }),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("unknown path returns 404", async () => {
    const res = await fetch(`${base}/vex/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });
});

describe("query endpoint", () => {
  test("returns data for valid query", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.list", args: {} }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test("returns 400 for missing query name", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing query name");
  });

  test("returns error for unknown query", async () => {
    const res = await fetch(`${base}/vex/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.nope", args: {} }),
    });
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("mutation endpoint", () => {
  test("creates item and returns id", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "items.create",
        args: { name: "a", value: 1 },
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(typeof body.data).toBe("string");
  });

  test("returns 400 for missing mutation name", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing mutation name");
  });

  test("returns error for unknown mutation", async () => {
    const res = await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "items.nope", args: {} }),
    });
    expect(res.ok).toBe(false);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });
});

describe("SSE subscription", () => {
  test("returns 400 for missing subscribe name", async () => {
    const res = await fetch(`${base}/vex/subscribe`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing query name");
  });

  test("returns 400 for invalid args JSON", async () => {
    const params = new URLSearchParams({
      name: "items.list",
      args: "not{json",
    });
    const res = await fetch(`${base}/vex/subscribe?${params}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid args");
  });

  test("receives initial data on connect", async () => {
    const params = new URLSearchParams({ name: "items.list", args: "{}" });
    const data = await readSSEMessage(`${base}/vex/subscribe?${params}`);
    expect(Array.isArray(data)).toBe(true);
  });

  test("pushes update after mutation", async () => {
    const params = new URLSearchParams({ name: "items.list", args: "{}" });
    const url = `${base}/vex/subscribe?${params}`;

    const collecting = collectSSEMessages(url, 2);

    await Bun.sleep(100);
    await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "items.create",
        args: { name: "sse-push", value: 77 },
      }),
    });

    const messages = await collecting;
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const last = messages[messages.length - 1];
    expect(last.some((item: any) => item.name === "sse-push")).toBe(true);
  });

  test("receives filtered data with args", async () => {
    await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "items.create",
        args: { name: "unique-filter", value: 42 },
      }),
    });

    const params = new URLSearchParams({
      name: "items.byName",
      args: JSON.stringify({ name: "unique-filter" }),
    });
    const data = await readSSEMessage(`${base}/vex/subscribe?${params}`);
    expect(data.length).toBe(1);
    expect(data[0].name).toBe("unique-filter");
    expect(Number(data[0].value)).toBe(42);
  });

  test("different subscriptions get different data", async () => {
    await fetch(`${base}/vex/mutate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "items.create",
        args: { name: "only-this", value: 999 },
      }),
    });

    const allParams = new URLSearchParams({ name: "items.list", args: "{}" });
    const filteredParams = new URLSearchParams({
      name: "items.byName",
      args: JSON.stringify({ name: "only-this" }),
    });

    const [allData, filteredData] = await Promise.all([
      readSSEMessage(`${base}/vex/subscribe?${allParams}`),
      readSSEMessage(`${base}/vex/subscribe?${filteredParams}`),
    ]);

    expect(allData.length).toBeGreaterThan(filteredData.length);
    expect(filteredData.length).toBe(1);
    expect(filteredData[0].name).toBe("only-this");
  });
});
