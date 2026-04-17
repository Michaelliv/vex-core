/**
 * DuckDB storage adapter, built on `@duckdb/node-api`.
 *
 * We left the legacy `duckdb-async` package behind for three reasons:
 *   1. `duckdb-async` pulls in the classic `duckdb` binding, whose
 *      postinstall fetches a native `.node` via node-pre-gyp. Bun's
 *      `bun install -g` doesn't run install scripts by default — the
 *      binary never lands and the import throws at runtime. The new
 *      `@duckdb/node-api` ships prebuilds through standard bundling,
 *      no postinstall dance.
 *   2. `duckdb-async` has a history of segfaulting on Bun atexit.
 *   3. `@duckdb/node-api` is the officially maintained binding.
 *
 * Surface changes worth knowing
 *   - The new binding returns native `bigint` for BIGINT columns; the
 *     legacy binding coerced small values to `number`. Callers that do
 *     arithmetic on the result of COUNT/SUM over big integer columns
 *     may need a Number(...) cast. `deserializeRow` in shared.ts
 *     preserves whatever the driver returns.
 *   - `db.run()` no longer surfaces an `affectedRows` count. We use
 *     a DELETE ... RETURNING roundtrip for the query-builder `delete`
 *     path to keep the `{ changes }` contract in `DbExec`.
 *   - Multi-statement DDL (`INSTALL sqlite; LOAD sqlite;`) is split on
 *     top-level `;` before dispatch, matching the convention dripline
 *     established in its own wrapper.
 */

import {
  type DuckDBConnection,
  DuckDBInstance,
  type DuckDBValue,
} from "@duckdb/node-api";
import { id as generateId } from "../core/id.js";
import type { StorageAdapter } from "../core/storage.js";
import type { TableSchema } from "../core/types.js";
import {
  buildInsertSql,
  buildUpdateSql,
  createQueryBuilder,
  type DbExec,
  serializeValue,
  toSqlType,
} from "./shared.js";

/**
 * Split a SQL string on top-level `;` boundaries. Ignores `;`
 * appearing inside single-quoted string literals. Good enough for the
 * DDL strings this adapter actually emits.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== "\\") inSingle = !inSingle;
    if (ch === ";" && !inSingle) {
      const s = buf.trim();
      if (s.length > 0) out.push(s);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
}

/**
 * Normalize a JS value for the binding's positional bind. The binding
 * is strict; everything non-primitive is JSON-stringified so it lands
 * in a VARCHAR column cleanly.
 */
function toBindValue(v: unknown): DuckDBValue {
  if (v == null) return null as unknown as DuckDBValue;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return v as DuckDBValue;
  if (typeof v === "bigint") return v as DuckDBValue;
  return JSON.stringify(v) as DuckDBValue;
}

/**
 * DbExec wrapper over a DuckDBConnection. Same shape as the sqlite
 * adapter's wrapSync; `run()` synthesizes a `{ changes }` result
 * because the new binding doesn't surface one natively.
 */
function wrapAsync(conn: DuckDBConnection): DbExec {
  return {
    schemas: new Map(),
    async all(sql, params) {
      const reader =
        params.length > 0
          ? await conn.runAndReadAll(sql, params.map(toBindValue))
          : await conn.runAndReadAll(sql);
      return reader.getRowObjectsJS() as Record<string, unknown>[];
    },
    async run(sql, params) {
      // The query builder's `delete()` path goes through run() and
      // expects a changes count. DuckDB supports RETURNING for
      // DELETE/UPDATE/INSERT, so we rewrite unterminated DELETE
      // statements to include RETURNING _id and count the result set.
      // For everything else (DDL, INSERT without RETURNING, etc.) we
      // report 0 — callers only read changes on DELETE right now.
      const trimmed = sql.trim();
      const isDelete =
        /^delete\s/i.test(trimmed) && !/\breturning\b/i.test(trimmed);
      if (isDelete) {
        const rewritten = `${trimmed.replace(/;?$/, "")} RETURNING _id`;
        const reader =
          params.length > 0
            ? await conn.runAndReadAll(rewritten, params.map(toBindValue))
            : await conn.runAndReadAll(rewritten);
        return { changes: reader.getRowObjectsJS().length };
      }
      if (params.length > 0) {
        await conn.run(sql, params.map(toBindValue));
      } else {
        await conn.run(sql);
      }
      return { changes: 0 };
    },
  };
}

export interface DuckDBAdapterExtras {
  /** Attach a SQLite database file as a readable schema under `alias`. */
  attachSqlite(alias: string, path: string): Promise<void>;
  /** Escape hatch — the underlying DuckDB connection. */
  getConnection(): DuckDBConnection;
}

export type DuckDBAdapter = StorageAdapter & DuckDBAdapterExtras;

export async function duckdbAdapter(
  path: string = ":memory:",
): Promise<DuckDBAdapter> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  const exec = wrapAsync(conn);
  const changedTables = new Set<string>();
  let txDepth = 0;
  let closed = false;

  const adapter: DuckDBAdapter = {
    name: "duckdb",

    async ensureTable(name: string, schema: TableSchema) {
      exec.schemas.set(name, schema);
      const colDefs = ["_id VARCHAR PRIMARY KEY"];
      for (const [colName, colDef] of Object.entries(schema.columns)) {
        const duckType = toSqlType(colDef.type, "duckdb");
        colDefs.push(`"${colName}" ${duckType}`);
      }
      await conn.run(
        `CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`,
      );
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      const id = row._id ?? generateId(12);
      const data: Record<string, any> = { ...row, _id: id };
      const keys = Object.keys(data);
      const values = keys.map((k) => serializeValue(data[k]));
      await conn.run(buildInsertSql(table, keys), values.map(toBindValue));
      changedTables.add(table);
      return id;
    },

    async upsert(
      table: string,
      keys: Record<string, any>,
      data: Record<string, any>,
    ): Promise<void> {
      const qb = createQueryBuilder(exec, table);
      for (const [col, val] of Object.entries(keys)) qb.where(col, "=", val);
      const existing = await qb.first<{ _id: string }>();

      if (existing) {
        const { sql, values } = buildUpdateSql(table, data);
        await conn.run(sql, [...values, existing._id].map(toBindValue));
      } else {
        await adapter.insert(table, { ...keys, ...data });
      }
      changedTables.add(table);
    },

    async update(
      table: string,
      id: string,
      data: Record<string, any>,
    ): Promise<void> {
      const { sql, values } = buildUpdateSql(table, data);
      await conn.run(sql, [...values, id].map(toBindValue));
      changedTables.add(table);
    },

    async delete(table: string, id: string): Promise<boolean> {
      const reader = await conn.runAndReadAll(
        `DELETE FROM "${table}" WHERE _id = ? RETURNING _id`,
        [id as DuckDBValue],
      );
      changedTables.add(table);
      return reader.getRowObjectsJS().length > 0;
    },

    query(table: string) {
      return createQueryBuilder(exec, table);
    },

    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      if (txDepth > 0) {
        // Already inside a transaction — join it instead of nesting.
        txDepth++;
        try {
          return await fn();
        } finally {
          txDepth--;
        }
      }
      txDepth++;
      await conn.run("BEGIN TRANSACTION");
      try {
        const result = await fn();
        await conn.run("COMMIT");
        return result;
      } catch (e) {
        await conn.run("ROLLBACK");
        throw e;
      } finally {
        txDepth--;
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      const reader =
        params.length > 0
          ? await conn.runAndReadAll(sql, params.map(toBindValue))
          : await conn.runAndReadAll(sql);
      return reader.getRowObjectsJS() as T[];
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      if (params.length > 0) {
        await conn.run(sql, params.map(toBindValue));
        return;
      }
      // No params — allow multi-statement DDL strings.
      for (const stmt of splitStatements(sql)) {
        await conn.run(stmt);
      }
    },

    async bulkInsert(
      table: string,
      rows: Record<string, any>[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const firstRow = { _id: generateId(12), ...rows[0] };
      const keys = Object.keys(firstRow);
      const sql = buildInsertSql(table, keys);

      await conn.run("BEGIN TRANSACTION");
      try {
        for (const row of rows) {
          const data: Record<string, any> = {
            _id: row._id ?? generateId(12),
            ...row,
          };
          await conn.run(
            sql,
            keys.map((k) => toBindValue(serializeValue(data[k]))),
          );
        }
        await conn.run("COMMIT");
      } catch (e) {
        await conn.run("ROLLBACK");
        throw e;
      }
      changedTables.add(table);
    },

    getChangedTables(): string[] {
      const tables = [...changedTables];
      changedTables.clear();
      return tables;
    },

    getSchema(table: string) {
      return exec.schemas.get(table) ?? null;
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        conn.closeSync();
      } catch {}
      try {
        instance.closeSync();
      } catch {}
    },

    getConnection() {
      return conn;
    },

    async attachSqlite(alias: string, sqlitePath: string) {
      await conn.run("INSTALL sqlite");
      await conn.run("LOAD sqlite");
      await conn.run(
        `ATTACH '${sqlitePath}' AS "${alias}" (TYPE sqlite, READ_ONLY)`,
      );
    },
  };

  return adapter;
}
