# vex-core

Local-first reactive backend engine. Plugin architecture, SQLite for transactions, DuckDB for analytics, real-time subscriptions via SSE.

```
npm install vex-core
```

Peer: `react` ^19 (only if you use `vex-core/client`).

## Quick start

```ts
import { Vex, sqliteAdapter } from "vex-core";

const vex = await Vex.create({
  transactional: sqliteAdapter(".vex/data.db"),
  analytical: sqliteAdapter(".vex/analytics.db"),
  plugins: [
    (api) => {
      api.setName("counter");
      api.registerTable("counters", {
        columns: { key: { type: "string" }, value: { type: "number" } },
      });
      api.registerMutation("set", {
        args: { key: "string", value: "number" },
        async handler(ctx, args) {
          return ctx.db.table("counters").insert(args);
        },
      });
      api.registerQuery("list", {
        args: {},
        async handler(ctx) {
          return ctx.db.table("counters").all();
        },
      });
    },
  ],
});

await vex.mutate("counter.set", { key: "hits", value: 1 });
await vex.query("counter.list");

const unsub = await vex.subscribe("counter.list", {}, (rows) => {
  console.log("changed:", rows);
});
```

## Query builder

Reads, filters, aggregations — pushed down to SQL.

```ts
ctx.db.table("orders").where("region", "=", "US").all();
ctx.db.table("orders").where("amount", ">", 100).select("id", "amount").first();

ctx.db.table("orders").count();
ctx.db.table("orders").sum("amount");
ctx.db.table("orders").avg("amount");

ctx.db.table("orders")
  .groupBy(["region", "product"], {
    revenue: ["sum", "amount"],
    count: "count",
  })
  .having("count", ">=", 10)
  .order("revenue", "desc")
  .limit(20);
```

## Analytical tables

Tables with `storage: "analytical"` route to the analytical adapter (SQLite or DuckDB).

```ts
api.registerTable("events", {
  storage: "analytical",
  columns: {
    timestamp: { type: "number" },
    type: { type: "string" },
    data: { type: "json" },
  },
});
```

Use `duckdbAdapter` from `vex-core/adapters/duckdb` when you want columnar scans.

## File-based conventions

Flat files, no config. Use `scanDirectory` to turn a folder into plugins.

```ts
// schema.ts
import { table } from "vex-core/framework";
export const todos = table({ text: "string", done: "boolean" });

// todos.ts
import { query, mutation } from "vex-core/framework";
export const list = query({}, async (ctx) => ctx.db.table("todos").all());
export const add = mutation({ text: "string" }, async (ctx, args) =>
  ctx.db.table("todos").insert({ text: args.text, done: false }),
);
```

```ts
import { scanDirectory } from "vex-core/framework";
import { Vex, sqliteAdapter } from "vex-core";

const { plugins } = await scanDirectory("./app");
const vex = await Vex.create({
  transactional: sqliteAdapter(".vex/data.db"),
  analytical: sqliteAdapter(".vex/analytics.db"),
  plugins,
});
```

Also supported in files: `webhook(path, handler)`, `job(schedule, handler)`, `middleware(fn)`.

## HTTP handler

Mount a minimal HTTP handler for queries, mutations, webhooks, and SSE subscriptions.

```ts
import { createHandler } from "vex-core/server";

const { handle } = createHandler("/vex", vex, { corsOrigin: "*" });

Bun.serve({
  port: 3000,
  fetch: (req) => handle(req),
});
```

Routes:

```
POST /vex/query            { name, args }
POST /vex/mutate           { name, args }
GET  /vex/subscribe        ?name=...&args=... (SSE)
*    /vex/webhook/:path    user-defined webhooks
```

## React client

```tsx
import { VexProvider, useQuery, useMutation } from "vex-core/client";

function App() {
  return (
    <VexProvider basePath="/vex">
      <Todos />
    </VexProvider>
  );
}

function Todos() {
  const { data: todos, isLoading } = useQuery("todos.list");
  const { mutate: addTodo } = useMutation("todos.add");
  // ...
}
```

SSE-backed — data updates automatically on mutations that touch the underlying tables.

## Observability

Every engine operation is a span. Pass a `tracer` to `Vex.create` to capture queries, mutations, handler timings, tables touched, invalidated subscriptions, and errors. See `src/core/tracer.ts` for the `Tracer` and `Span` interfaces.

## Exports

| Entry | Contents |
|-------|----------|
| `vex-core` | `Vex`, `sqliteAdapter`, `duckdbAdapter`, `id`, core types, tracer, auth helpers |
| `vex-core/framework` | `table`, `query`, `mutation`, `webhook`, `job`, `middleware`, `scanDirectory` |
| `vex-core/server` | `createHandler` |
| `vex-core/client` | `VexProvider`, `useQuery`, `useMutation` |
| `vex-core/adapters/sqlite` | `sqliteAdapter` |
| `vex-core/adapters/duckdb` | `duckdbAdapter` |

## License

MIT
