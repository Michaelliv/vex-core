# vex

Local-first reactive backend. SQLite for transactions, DuckDB for analytics. Plugin architecture. Platform server with dashboard and distributed tracing.

```
npm install @miclivs/vex
```

## Quick start

```ts
import { Vex } from "@miclivs/vex";
import { sqliteAdapter } from "@miclivs/vex/adapters/sqlite";
import kv from "@miclivs/vex/plugins/kv";

const vex = await Vex.create({
  transactional: sqliteAdapter(".vex/data.db"),
  analytical: sqliteAdapter(".vex/analytics.db"),
  plugins: [kv],
});

await vex.mutate("kv.set", { scope: "app", key: "count", value: 42 });
await vex.query("kv.get", { scope: "app", key: "count" }); // 42

const unsub = await vex.subscribe("kv.get", { scope: "app", key: "count" }, (value) => {
  console.log("changed:", value);
});
```

## Write a plugin

```ts
function todos(api) {
  api.setName("todo");

  api.registerTable("todos", {
    columns: { text: { type: "string" }, done: { type: "boolean" } },
  });

  api.registerQuery("list", {
    args: {},
    async handler(ctx) {
      return ctx.db.table("todos").order("_id", "desc").all();
    },
  });

  api.registerMutation("add", {
    args: { text: "string" },
    async handler(ctx, args) {
      return ctx.db.table("todos").insert({ text: args.text, done: false });
    },
  });
}
```

## Query builder

Reads, filters, aggregations — all pushed to SQL.

```ts
// Filters
ctx.db.table("orders").where("region", "=", "US").all()
ctx.db.table("orders").where("amount", ">", 100).select("id", "amount").first()

// Aggregates
ctx.db.table("orders").count()
ctx.db.table("orders").sum("amount")
ctx.db.table("orders").avg("amount")

// Group by
ctx.db.table("orders")
  .groupBy(["region", "product"], {
    revenue: ["sum", "amount"],
    count: "count",
  })
  .having("count", ">=", 10)
  .order("revenue", "desc")
  .limit(20)
```

## Analytical tables

Tables with `storage: "analytical"` route to the analytical adapter.

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

## File-based conventions

Flat files, no config. For agents and rapid prototyping.

```ts
// schema.ts
import { table } from "@miclivs/vex/framework";
export const todos = table({ text: "string", done: "boolean" });

// todos.ts
import { query, mutation } from "@miclivs/vex/framework";
export const list = query({}, async (ctx) => ctx.db.table("todos").all());
export const add = mutation({ text: "string" }, async (ctx, args) =>
  ctx.db.table("todos").insert({ text: args.text, done: false }));
```

## Platform server

Host multiple full-stack apps. Dashboard with reactive tables, traces, and analytics.

```bash
VEX_KEY=my-secret vex serve    # start platform on :3456
vex deploy                     # push current directory as an app
```

Configure via `.env` file or env vars (see `.env.example`):

```
VEX_KEY=my-secret
VEX_SPAN_RETENTION=7d
VEX_HANDLER_TIMEOUT=30s
VEX_TRACE_SAMPLE_RATE=1.0
VEX_CORS_ORIGIN=*
```

### Dashboard

The platform serves a reactive dashboard at `/`. Fully SSE-powered — no polling.

- **App list** — reactive via subscription to `platform.apps`
- **Overview** — tables with schemas, queries/mutations with args, platform stats
- **Tables** — live row browser with pagination (subscribes to `_system.rows`)
- **Query runner** — execute queries/mutations with args, history panel
- **Logs** — HTTP traces streaming in real-time

### HTTP API

```
POST   /api/apps              Create app
GET    /api/apps              List apps
POST   /a/:id/files/bulk      Push files
POST   /a/:id/boot            Start backend
POST   /a/:id/query           { name, args }
POST   /a/:id/mutate          { name, args }
GET    /a/:id/subscribe       SSE
POST   /a/:id/sql             { sql, storage? }
GET    /a/:id/info            Full introspection
GET    /a/:id/tables/:table   Paginated rows
DELETE /a/:id                 Delete app
```

## Auth

`VEX_KEY` is required to start the platform. Supports root key and scoped keys with granular permissions.

```bash
vex login http://localhost:3456    # authenticate CLI
vex keys create --name agent --permissions 'query:*:*,mutate:*:*'
vex keys list
```

Scoped key permissions: `query:app:operation`, `mutate:app:operation`, `deploy:app`, `*` for everything. Rate limiting and body size limits per key.

## CLI

```bash
vex serve [dir]              # Start platform server
vex deploy                   # Deploy current directory
vex apps                     # List apps
vex info <app>               # App introspection
vex query <app> <name>       # Run a query
vex mutate <app> <name>      # Run a mutation
vex rows <app> <table>       # Browse table rows
vex sql <app> <query>        # Raw SQL (-a for analytical)
vex trace <traceId>          # Compact tree
vex trace <traceId> -d       # + tables, tokens, cost, errors
vex trace <traceId> -e       # + full args and content
vex login <url>              # Save credentials
vex logout <url>             # Remove credentials
vex keys list/create/delete  # Manage scoped keys
```

All commands support `--to <url>` for remote servers and `--json` for machine output.

### Trace drill-down

```bash
# Compact tree
$ vex trace abc123de
OK  http         POST /a/demo-todo/mutate 9.0ms 200 todos.add
└─ OK  mutation     todos.add 3.2ms plugin:todos
   ├─ OK  handler      todos.add 343μs
   └─ OK  invalidation subscriptions 2.1ms subs:1 re-ran:[todos.list]

# Full detail — args, stack traces, invalidated subscriptions
$ vex trace abc123de --detail
OK  http         POST /a/demo-todo/mutate 9.0ms 200 todos.add
   args: {"text": "hello world"}
└─ OK  mutation     todos.add 3.2ms plugin:todos
      args: {"text": "hello world"}
   ├─ OK  handler      todos.add 343μs
   └─ OK  invalidation subscriptions 2.1ms
         changed: todos
         re-evaluated: todos.list

# Raw SQL over traces
$ vex sql _platform "SELECT type, avg(duration) FROM spans GROUP BY type" -a
```

## Observability

Built-in distributed tracing. Every engine operation is a span. HTTP requests are the root span.

```
http POST /a/demo-todo/mutate (7ms)
  └─ mutation todos.add (3ms)
       ├─ middleware todos.add (if registered)
       │   └─ handler todos.add
       └─ invalidation subscriptions
```

Spans store: full args, tables touched, plugin name, result row counts, error stack traces, invalidated subscription names.

The platform stores all spans in `_platform`'s `spans` table (analytical). Query with SQL:

```bash
vex sql _platform "SELECT * FROM spans WHERE status='error'" -a
vex sql _platform "SELECT app, type, count(*), avg(duration) FROM spans GROUP BY app, type" -a
```

## React client

```tsx
import { useQuery, useMutation } from "@miclivs/vex/client";

const { data: todos } = useQuery("todos.list");
const { mutate: addTodo } = useMutation("todos.add");
```

SSE subscriptions — data updates automatically on mutations.

## Built-in plugins

| Plugin | Purpose |
|--------|---------|
| `kv` | Key-value store (scoped) |
| `files` | File storage (scoped) |
| `sessions` | Session management |
| `auth` | Users + auth sessions |
| `logs` | Events, metrics (analytical) |

## Performance

Apple M1 Pro, single process, `bun:sqlite`:

| Operation | Throughput |
|-----------|-----------|
| Point lookup | ~130K ops/s |
| Single insert | ~55K ops/s |
| Bulk insert 1M rows | ~535K rows/s |
| Write + 60 subs invalidation | ~2.4K ops/s |
| AVG on 100K rows | ~265 ops/s |

## Examples

| Example | What it shows |
|---------|---------------|
| `examples/arena/` | Multiplayer game — canvas, SSE, 3 files |
| `examples/chat-app/` | Multi-room chat, framework conventions |
| `examples/todo.ts` | Single-file programmatic API |
| `examples/analytics-dashboard.ts` | Dual storage, multiple plugins |
| `examples/etl-pipeline.ts` | Bulk loads + analytical queries |
| `examples/pi-runtime/` | Pi coding agent running on Vex |

## License

MIT
