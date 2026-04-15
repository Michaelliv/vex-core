import { Database } from "duckdb-async";
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

function wrapAsync(db: Database): DbExec {
  return {
    schemas: new Map(),
    async all(sql, params) {
      return params.length > 0
        ? await db.all(sql, ...params)
        : await db.all(sql);
    },
    async run(sql, params) {
      const result =
        params.length > 0 ? await db.run(sql, ...params) : await db.run(sql);
      return { changes: (result as any)?.changes ?? 0 };
    },
  };
}

export interface DuckDBAdapterExtras {
  attachSqlite(alias: string, path: string): Promise<void>;
  getDatabase(): Database;
}

export type DuckDBAdapter = StorageAdapter & DuckDBAdapterExtras;

export async function duckdbAdapter(
  path: string = ":memory:",
): Promise<DuckDBAdapter> {
  const db = await Database.create(path);
  const exec = wrapAsync(db);
  const changedTables = new Set<string>();
  let txDepth = 0;

  const adapter: DuckDBAdapter = {
    name: "duckdb",

    async ensureTable(name: string, schema: TableSchema) {
      exec.schemas.set(name, schema);
      const colDefs = ["_id VARCHAR PRIMARY KEY"];
      for (const [colName, colDef] of Object.entries(schema.columns)) {
        const duckType = toSqlType(colDef.type, "duckdb");
        colDefs.push(`"${colName}" ${duckType}`);
      }
      await db.run(
        `CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`,
      );
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      const id = row._id ?? generateId(12);
      const data: Record<string, any> = { ...row, _id: id };
      const keys = Object.keys(data);
      const values = keys.map((k) => serializeValue(data[k]));
      await db.run(buildInsertSql(table, keys), ...values);
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
        await db.run(sql, ...values, existing._id);
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
      await db.run(sql, ...values, id);
      changedTables.add(table);
    },

    async delete(table: string, id: string): Promise<boolean> {
      const rows = await db.all(
        `DELETE FROM "${table}" WHERE _id = ? RETURNING _id`,
        id,
      );
      changedTables.add(table);
      return rows.length > 0;
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
      await db.run("BEGIN TRANSACTION");
      try {
        const result = await fn();
        await db.run("COMMIT");
        return result;
      } catch (e) {
        await db.run("ROLLBACK");
        throw e;
      } finally {
        txDepth--;
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      return (
        params.length > 0 ? await db.all(sql, ...params) : await db.all(sql)
      ) as T[];
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      if (params.length > 0) {
        await db.run(sql, ...params);
      } else {
        await db.run(sql);
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

      await db.run("BEGIN TRANSACTION");
      try {
        for (const row of rows) {
          const data: Record<string, any> = {
            _id: row._id ?? generateId(12),
            ...row,
          };
          await db.run(sql, ...keys.map((k) => serializeValue(data[k])));
        }
        await db.run("COMMIT");
      } catch (e) {
        await db.run("ROLLBACK");
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
      await db.close();
    },

    getDatabase() {
      return db;
    },

    async attachSqlite(alias: string, sqlitePath: string) {
      await db.run("INSTALL sqlite");
      await db.run("LOAD sqlite");
      await db.run(
        `ATTACH '${sqlitePath}' AS "${alias}" (TYPE sqlite, READ_ONLY)`,
      );
    },
  };

  return adapter;
}
