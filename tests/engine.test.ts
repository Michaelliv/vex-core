import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../src/adapters/sqlite.js";
import type { VexPluginAPI } from "../src/core/api.js";
import { Vex } from "../src/core/engine.js";
import type {
  MiddlewareInfo,
  MutationContext,
  QueryContext,
} from "../src/core/types.js";

// Inline KV plugin for testing (replaces app-specific plugin imports)
function kvPlugin(api: VexPluginAPI) {
  api.setName("kv");
  api.registerTable("kv", {
    columns: {
      scope: { type: "string", index: true },
      key: { type: "string" },
      value: { type: "json" },
    },
    unique: [["scope", "key"]],
  });
  api.registerQuery("get", {
    args: { scope: "string", key: "string" },
    async handler(ctx, args) {
      const row = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .where("key", "=", args.key)
        .first<{ value: any }>();
      return row?.value ?? null;
    },
  });
  api.registerQuery("getAll", {
    args: { scope: "string" },
    async handler(ctx, args) {
      const rows = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .all<{ key: string; value: any }>();
      const result: Record<string, any> = {};
      for (const r of rows) result[r.key] = r.value;
      return result;
    },
  });
  api.registerMutation("set", {
    args: { scope: "string", key: "string", value: "any" },
    async handler(ctx, args) {
      await ctx.db
        .table("kv")
        .upsert({ scope: args.scope, key: args.key }, { value: args.value });
    },
  });
  api.registerMutation("delete", {
    args: { scope: "string", key: "string" },
    async handler(ctx, args) {
      const row = await ctx.db
        .table("kv")
        .where("scope", "=", args.scope)
        .where("key", "=", args.key)
        .first<{ _id: string }>();
      if (row) await ctx.db.table("kv").delete(row._id);
    },
  });
}

let vex: Vex;

beforeEach(async () => {
  vex = await Vex.create({
    plugins: [kvPlugin],
    transactional: sqliteAdapter(":memory:"),
    analytical: sqliteAdapter(":memory:"),
  });
});

afterEach(async () => {
  await vex.close();
});

describe("engine", () => {
  test("lists plugins", () => {
    const plugins = vex.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins.map((p) => p.name)).toContain("kv");
  });

  test("lists queries and mutations", () => {
    expect(vex.listQueries()).toContain("kv.get");
    expect(vex.listMutations()).toContain("kv.set");
  });
});

describe("kv plugin", () => {
  test("set and get", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "count", value: 42 });
    const result = await vex.query("kv.get", { scope: "s1", key: "count" });
    expect(result).toBe(42);
  });

  test("get missing key returns null", async () => {
    const result = await vex.query("kv.get", { scope: "s1", key: "nope" });
    expect(result).toBeNull();
  });

  test("upsert overwrites", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: "a" });
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: "b" });
    expect(await vex.query("kv.get", { scope: "s1", key: "x" })).toBe("b");
  });

  test("getAll returns scoped entries", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "a", value: 1 });
    await vex.mutate("kv.set", { scope: "s1", key: "b", value: 2 });
    await vex.mutate("kv.set", { scope: "s2", key: "c", value: 3 });
    const all = await vex.query("kv.getAll", { scope: "s1" });
    expect(all).toEqual({ a: 1, b: 2 });
  });

  test("delete removes key", async () => {
    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    await vex.mutate("kv.delete", { scope: "s1", key: "x" });
    expect(await vex.query("kv.get", { scope: "s1", key: "x" })).toBeNull();
  });
});

describe("subscriptions", () => {
  test("subscribe fires on mutation", async () => {
    const results: any[] = [];
    const unsub = await vex.subscribe(
      "kv.get",
      { scope: "s1", key: "x" },
      (data) => {
        results.push(data);
      },
    );

    expect(results).toEqual([null]);

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 42 });
    expect(results).toEqual([null, 42]);

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 99 });
    expect(results).toEqual([null, 42, 99]);

    unsub();

    await vex.mutate("kv.set", { scope: "s1", key: "x", value: 0 });
    expect(results).toEqual([null, 42, 99]);
  });
});

describe("mutation context chaining", () => {
  test("where().where() chains correctly in mutations", async () => {
    const cvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("t");
          api.registerTable("items", {
            columns: {
              category: { type: "string" },
              status: { type: "string" },
              name: { type: "string" },
            },
          });
          api.registerMutation("add", {
            args: { category: "string", status: "string", name: "string" },
            async handler(ctx, args) {
              await ctx.db.table("items").insert({
                category: args.category,
                status: args.status,
                name: args.name,
              });
            },
          });
          api.registerMutation("findAndDelete", {
            args: { category: "string", status: "string" },
            async handler(ctx, args) {
              const row = await ctx.db
                .table("items")
                .where("category", "=", args.category)
                .where("status", "=", args.status)
                .first<{ _id: string; name: string }>();
              if (row) await ctx.db.table("items").delete(row._id);
              return row;
            },
          });
          api.registerQuery("list", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("items").all();
            },
          });
        },
      ],
    });

    await cvex.mutate("t.add", {
      category: "a",
      status: "active",
      name: "one",
    });
    await cvex.mutate("t.add", {
      category: "a",
      status: "inactive",
      name: "two",
    });
    await cvex.mutate("t.add", {
      category: "b",
      status: "active",
      name: "three",
    });

    const deleted = await cvex.mutate("t.findAndDelete", {
      category: "a",
      status: "inactive",
    });
    expect(deleted.name).toBe("two");

    const remaining = await cvex.query("t.list");
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r: any) => r.name).sort()).toEqual(["one", "three"]);

    await cvex.close();
  });
});

describe("custom plugin", () => {
  test("register and use inline plugin", async () => {
    const customVex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("todo");
          api.registerTable("todos", {
            columns: {
              text: { type: "string" },
              done: { type: "boolean" },
            },
          });
          api.registerMutation("add", {
            args: { text: "string" },
            async handler(ctx, args) {
              return ctx.db
                .table("todos")
                .insert({ text: args.text, done: false });
            },
          });
          api.registerQuery("list", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("todos").all();
            },
          });
        },
      ],
    });

    await customVex.mutate("todo.add", { text: "buy milk" });
    await customVex.mutate("todo.add", { text: "write code" });
    const todos = await customVex.query("todo.list");
    expect(todos).toHaveLength(2);
    expect(todos[0].text).toBe("buy milk");

    await customVex.close();
  });
});

describe("analytical storage", () => {
  test("tables with storage: analytical go to analytical adapter", async () => {
    const txAdapter = sqliteAdapter(":memory:");
    const anAdapter = sqliteAdapter(":memory:");

    const dualVex = await Vex.create({
      transactional: txAdapter,
      analytical: anAdapter,
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("analytics");
          api.registerTable("events", {
            storage: "analytical",
            columns: {
              timestamp: { type: "number" },
              type: { type: "string" },
              data: { type: "json", optional: true },
            },
          });
          api.registerMutation("track", {
            args: { type: "string", data: "any" },
            async handler(ctx, args) {
              await ctx.db.table("events").insert({
                timestamp: Date.now(),
                type: args.type,
                data: args.data ?? null,
              });
            },
          });
          api.registerQuery("count", {
            args: { type: "string" },
            async handler(ctx, args) {
              return ctx.db
                .table("events")
                .where("type", "=", args.type)
                .count();
            },
          });
          api.registerQuery("all", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("events").all();
            },
          });
        },
      ],
    });

    await dualVex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    expect(await dualVex.query("kv.get", { scope: "s1", key: "x" })).toBe(1);

    await dualVex.mutate("analytics.track", {
      type: "click",
      data: { page: "/home" },
    });
    await dualVex.mutate("analytics.track", {
      type: "click",
      data: { page: "/about" },
    });
    await dualVex.mutate("analytics.track", { type: "signup" });

    expect(await dualVex.query("analytics.count", { type: "click" })).toBe(2);
    expect((await dualVex.query("analytics.all")).length).toBe(3);

    const txTables = await txAdapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    expect(txTables.map((t) => t.name)).not.toContain("events");
    expect(txTables.map((t) => t.name)).toContain("kv");

    const anTables = await anAdapter.rawQuery<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    );
    expect(anTables.map((t) => t.name)).toContain("events");

    await dualVex.close();
  });

  test("raw SQL queries against both engines", async () => {
    const dualVex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("metrics");
          api.registerTable("metrics", {
            storage: "analytical",
            columns: {
              name: { type: "string" },
              value: { type: "number" },
            },
          });
          api.registerMutation("record", {
            args: { name: "string", value: "number" },
            async handler(ctx, args) {
              await ctx.db
                .table("metrics")
                .insert({ name: args.name, value: args.value });
            },
          });
        },
      ],
    });

    await dualVex.mutate("kv.set", { scope: "s1", key: "a", value: 1 });
    await dualVex.mutate("metrics.record", { name: "cpu", value: 45 });
    await dualVex.mutate("metrics.record", { name: "cpu", value: 60 });
    await dualVex.mutate("metrics.record", { name: "mem", value: 80 });

    const kvRows = await dualVex.unsafeSql("SELECT * FROM kv");
    expect(kvRows).toHaveLength(1);

    const avgCpu = await dualVex.unsafeAnalyticalSql<{ avg_val: number }>(
      "SELECT AVG(value) as avg_val FROM metrics WHERE name = ?",
      "cpu",
    );
    expect(avgCpu[0].avg_val).toBe(52.5);

    await dualVex.close();
  });

  test("bulk insert into analytical table", async () => {
    const dualVex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("data");
          api.registerTable("rows", {
            storage: "analytical",
            columns: {
              x: { type: "number" },
              y: { type: "number" },
            },
          });
          api.registerQuery("count", {
            args: {},
            async handler(ctx) {
              return ctx.db.table("rows").count();
            },
          });
        },
      ],
    });

    const rows = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i * 2 }));
    await dualVex.unsafeBulkInsert("rows", rows);

    expect(await dualVex.query("data.count")).toBe(1000);

    const sum = await dualVex.unsafeAnalyticalSql<{ total: number }>(
      "SELECT SUM(y) as total FROM rows",
    );
    expect(sum[0].total).toBe(999000);

    await dualVex.close();
  });
});

describe("webhooks", () => {
  test("route by path and method", async () => {
    const wvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("billing");
          api.registerTable("payments", {
            columns: { amount: { type: "number" }, status: { type: "string" } },
          });
          api.registerWebhook("stripePayment", {
            path: "/stripe",
            async handler(ctx, req) {
              await ctx.db.table("payments").insert({
                amount: req.body.amount,
                status: "paid",
              });
              return { received: true };
            },
          });
        },
      ],
    });

    const result = await wvex.handleWebhook({
      body: { amount: 99 },
      rawBody: '{"amount":99}',
      headers: {},
      method: "POST",
      path: "/stripe",
      query: {},
    });

    expect(result.status).toBe(200);
    expect(result.body.received).toBe(true);

    const payments = await wvex.unsafeSql("SELECT * FROM payments");
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(99);

    await wvex.close();
  });

  test("verify rejects invalid signature", async () => {
    const wvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("hooks");
          api.registerWebhook("secure", {
            path: "/secure",
            verify: (req) => req.headers["x-secret"] === "valid",
            handler(_ctx, _req) {
              return { ok: true };
            },
          });
        },
      ],
    });

    const rejected = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: { "x-secret": "wrong" },
      method: "POST",
      path: "/secure",
      query: {},
    });
    expect(rejected.status).toBe(401);

    const accepted = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: { "x-secret": "valid" },
      method: "POST",
      path: "/secure",
      query: {},
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.ok).toBe(true);

    await wvex.close();
  });

  test("404 for unknown path", async () => {
    const wvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [],
    });

    const result = await wvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: {},
      method: "POST",
      path: "/nope",
      query: {},
    });
    expect(result.status).toBe(404);

    await wvex.close();
  });
});

describe("middleware", () => {
  test("runs on queries and mutations", async () => {
    const log: string[] = [];

    const mvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("logger");
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              log.push(`${info.type}:${info.name}`);
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    await mvex.query("kv.get", { scope: "s1", key: "x" });

    expect(log).toEqual(["mutation:kv.set", "query:kv.get"]);

    await mvex.close();
  });

  test("can block operations", async () => {
    const mvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("guard");
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              if (info.type === "mutation" && info.name === "kv.delete") {
                throw new Error("Deletes are disabled");
              }
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    expect(async () =>
      mvex.mutate("kv.delete", { scope: "s1", key: "x" }),
    ).toThrow("Deletes are disabled");
    expect(await mvex.query("kv.get", { scope: "s1", key: "x" })).toBe(1);

    await mvex.close();
  });

  test("chains multiple middleware in order", async () => {
    const order: number[] = [];

    const mvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        kvPlugin,
        (api: VexPluginAPI) => {
          api.setName("m1");
          api.use(
            async (
              _ctx: MutationContext,
              _info: MiddlewareInfo,
              next: () => any,
            ) => {
              order.push(1);
              const result = await next();
              order.push(3);
              return result;
            },
          );
        },
        (api: VexPluginAPI) => {
          api.setName("m2");
          api.use(
            (_ctx: MutationContext, _info: MiddlewareInfo, next: () => any) => {
              order.push(2);
              return next();
            },
          );
        },
      ],
    });

    await mvex.mutate("kv.set", { scope: "s1", key: "x", value: 1 });
    expect(order).toEqual([1, 2, 3]);

    await mvex.close();
  });

  test("runs on webhooks", async () => {
    const log: string[] = [];

    const mvex = await Vex.create({
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("hooks");
          api.registerWebhook("ping", {
            path: "/ping",
            handler(_ctx, _req) {
              return { pong: true };
            },
          });
          api.use(
            (_ctx: MutationContext, info: MiddlewareInfo, next: () => any) => {
              log.push(info.type);
              return next();
            },
          );
        },
      ],
    });

    await mvex.handleWebhook({
      body: {},
      rawBody: "{}",
      headers: {},
      method: "POST",
      path: "/ping",
      query: {},
    });

    expect(log).toEqual(["webhook"]);

    await mvex.close();
  });

  test("middleware during query gets read-only context", async () => {
    let contextHasInsert = false;

    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("test");
          api.registerTable("items", { columns: { name: { type: "string" } } });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("items").all(),
          });
          api.use((ctx, info, next) => {
            contextHasInsert =
              typeof (ctx.db.table("items") as any).insert === "function";
            return next();
          });
        },
      ],
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
    });

    await mvex.query("test.list");
    expect(contextHasInsert).toBe(false);

    await mvex.close();
  });

  test("middleware during mutation gets write context", async () => {
    let contextHasInsert = false;

    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("test");
          api.registerTable("items", { columns: { name: { type: "string" } } });
          api.registerMutation("add", {
            args: { name: "string" },
            handler: async (ctx, args) =>
              ctx.db.table("items").insert({ name: args.name }),
          });
          api.use((ctx, info, next) => {
            contextHasInsert =
              typeof (ctx.db.table("items") as any).insert === "function";
            return next();
          });
        },
      ],
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
    });

    await mvex.mutate("test.add", { name: "x" });
    expect(contextHasInsert).toBe(true);

    await mvex.close();
  });
});

describe("plugin name collisions", () => {
  test("duplicate query name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerTable("items", {
              columns: { name: { type: "string" } },
            });
            api.registerQuery("list", {
              args: {},
              handler: async (ctx) => ctx.db.table("items").all(),
            });
          },
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerQuery("list", {
              args: {},
              handler: async (ctx) => ctx.db.table("items").all(),
            });
          },
        ],
        transactional: sqliteAdapter(":memory:"),
        analytical: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow("Duplicate query: items.list");
  });

  test("duplicate mutation name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerTable("items", {
              columns: { name: { type: "string" } },
            });
            api.registerMutation("add", {
              args: { name: "string" },
              handler: async (ctx, args) =>
                ctx.db.table("items").insert({ name: args.name }),
            });
          },
          (api: VexPluginAPI) => {
            api.setName("items");
            api.registerMutation("add", {
              args: { name: "string" },
              handler: async (ctx, args) =>
                ctx.db.table("items").insert({ name: args.name }),
            });
          },
        ],
        transactional: sqliteAdapter(":memory:"),
        analytical: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow("Duplicate mutation: items.add");
  });

  test("duplicate table name throws", async () => {
    expect(
      Vex.create({
        plugins: [
          (api: VexPluginAPI) => {
            api.setName("a");
            api.registerTable("runs", {
              columns: { name: { type: "string" } },
            });
          },
          (api: VexPluginAPI) => {
            api.setName("b");
            api.registerTable("runs", {
              columns: { other: { type: "string" } },
            });
          },
        ],
        transactional: sqliteAdapter(":memory:"),
        analytical: sqliteAdapter(":memory:"),
      }),
    ).rejects.toThrow('Duplicate table "runs"');
  });

  test("same name across different plugins is fine", async () => {
    const mvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("users");
          api.registerTable("users", { columns: { name: { type: "string" } } });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("users").all(),
          });
        },
        (api: VexPluginAPI) => {
          api.setName("posts");
          api.registerTable("posts", {
            columns: { title: { type: "string" } },
          });
          api.registerQuery("list", {
            args: {},
            handler: async (ctx) => ctx.db.table("posts").all(),
          });
        },
      ],
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
    });

    expect(mvex.listQueries()).toContain("users.list");
    expect(mvex.listQueries()).toContain("posts.list");

    await mvex.close();
  });
});

describe("_system.sql", () => {
  test("requires admin", async () => {
    await expect(
      vex.mutate("_system.sql", { sql: "SELECT 1" }),
    ).rejects.toThrow("admin privileges");
  });

  test("admin can run raw SELECT", async () => {
    await vex.mutate("kv.set", { scope: "s", key: "k", value: 7 });
    const rows = await vex.mutate(
      "_system.sql",
      { sql: "SELECT COUNT(*) as n FROM kv" },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    expect(rows[0].n).toBe(1);
  });

  test("admin can run DDL (DROP orphan table)", async () => {
    await vex.mutate(
      "_system.sql",
      { sql: "CREATE TABLE orphan (x INTEGER)" },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    const before = await vex.mutate(
      "_system.sql",
      { sql: "SELECT name FROM sqlite_master WHERE name='orphan'" },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    expect(before).toHaveLength(1);

    await vex.mutate(
      "_system.sql",
      { sql: "DROP TABLE orphan" },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    const after = await vex.mutate(
      "_system.sql",
      { sql: "SELECT name FROM sqlite_master WHERE name='orphan'" },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    expect(after).toHaveLength(0);
  });

  test("params are bound", async () => {
    await vex.mutate("kv.set", { scope: "s", key: "a", value: 1 });
    await vex.mutate("kv.set", { scope: "s", key: "b", value: 2 });
    const rows = await vex.mutate(
      "_system.sql",
      { sql: "SELECT key FROM kv WHERE value = ?", params: [2] },
      { user: { id: "admin", name: "Admin", isAdmin: true } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("b");
  });
});

describe("handler timeout", () => {
  test("query times out when handler exceeds limit", async () => {
    const tvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("slow");
          api.registerQuery("hang", {
            args: {},
            async handler() {
              await new Promise((r) => setTimeout(r, 500));
              return "done";
            },
          });
        },
      ],
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      handlerTimeoutMs: 50,
    });

    await expect(tvex.query("slow.hang")).rejects.toThrow(
      "Handler timed out after 50ms",
    );
    await tvex.close();
  });

  test("fast handler completes normally with timeout set", async () => {
    const tvex = await Vex.create({
      plugins: [
        (api: VexPluginAPI) => {
          api.setName("fast");
          api.registerQuery("quick", {
            args: {},
            async handler() {
              return "ok";
            },
          });
        },
      ],
      transactional: sqliteAdapter(":memory:"),
      analytical: sqliteAdapter(":memory:"),
      handlerTimeoutMs: 5000,
    });

    const result = await tvex.query("fast.quick");
    expect(result).toBe("ok");
    await tvex.close();
  });
});
