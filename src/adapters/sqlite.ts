import { Database } from "bun:sqlite";
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

function wrapSync(db: Database): DbExec {
  return {
    schemas: new Map(),
    async all(sql, params) {
      return params.length > 0
        ? db.prepare(sql).all(...params)
        : db.prepare(sql).all();
    },
    async run(sql, params) {
      const result = params.length > 0 ? db.run(sql, ...params) : db.run(sql);
      return { changes: result.changes };
    },
  };
}

export interface SqliteOptions {
  busyTimeout?: number;
  cacheSize?: number;
}

export function sqliteAdapter(
  path: string = ":memory:",
  opts?: SqliteOptions,
): StorageAdapter {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`PRAGMA busy_timeout = ${opts?.busyTimeout ?? 5000}`);
  if (opts?.cacheSize) db.exec(`PRAGMA cache_size = ${opts.cacheSize}`);

  const exec = wrapSync(db);
  const changedTables = new Set<string>();
  let txDepth = 0;

  return {
    name: "sqlite",

    ensureTable(name: string, schema: TableSchema) {
      exec.schemas.set(name, schema);
      const colDefs = ["_id TEXT PRIMARY KEY"];
      for (const [colName, colDef] of Object.entries(schema.columns)) {
        const sqlType = toSqlType(colDef.type, "sqlite");
        const nullable = colDef.optional ? "" : " NOT NULL";
        const defaultVal =
          colDef.default !== undefined
            ? ` DEFAULT ${JSON.stringify(colDef.default)}`
            : "";
        colDefs.push(`"${colName}" ${sqlType}${nullable}${defaultVal}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${colDefs.join(", ")})`);

      // Migrate: add missing columns
      const existing = db.prepare(`PRAGMA table_info("${name}")`).all() as {
        name: string;
      }[];
      const existingNames = new Set(existing.map((c) => c.name));
      for (const [colName, colDef] of Object.entries(schema.columns)) {
        if (!existingNames.has(colName)) {
          db.exec(
            `ALTER TABLE "${name}" ADD COLUMN "${colName}" ${toSqlType(colDef.type, "sqlite")}`,
          );
        }
      }

      for (const [colName, colDef] of Object.entries(schema.columns)) {
        if (colDef.index) {
          db.exec(
            `CREATE INDEX IF NOT EXISTS "idx_${name}_${colName}" ON "${name}" ("${colName}")`,
          );
        }
      }
      for (const [idxName, idxCols] of schema.indexes ?? []) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS "${idxName}" ON "${name}" (${idxCols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
      for (const uniqueCols of schema.unique ?? []) {
        const idxName = `uq_${name}_${uniqueCols.join("_")}`;
        db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS "${idxName}" ON "${name}" (${uniqueCols.map((c) => `"${c}"`).join(", ")})`,
        );
      }
    },

    async insert(table: string, row: Record<string, any>): Promise<string> {
      const id = row._id ?? generateId(12);
      const data: Record<string, any> = { ...row, _id: id };
      const keys = Object.keys(data);
      const values = keys.map((k) => serializeValue(data[k]));
      db.prepare(buildInsertSql(table, keys)).run(...values);
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
      const row = await qb.first<{ _id: string }>();

      if (row) {
        const { sql, values } = buildUpdateSql(table, data);
        db.prepare(sql).run(...values, row._id);
      } else {
        await this.insert(table, { ...keys, ...data });
      }
      changedTables.add(table);
    },

    async update(
      table: string,
      id: string,
      data: Record<string, any>,
    ): Promise<void> {
      const { sql, values } = buildUpdateSql(table, data);
      db.prepare(sql).run(...values, id);
      changedTables.add(table);
    },

    async delete(table: string, id: string): Promise<boolean> {
      const result = db.prepare(`DELETE FROM "${table}" WHERE _id = ?`).run(id);
      changedTables.add(table);
      return result.changes > 0;
    },

    query(table: string) {
      return createQueryBuilder(exec, table);
    },

    async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
      if (txDepth > 0) {
        txDepth++;
        try {
          return await fn();
        } finally {
          txDepth--;
        }
      }
      txDepth++;
      db.exec("BEGIN");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        txDepth--;
      }
    },

    async rawQuery<T = Record<string, any>>(
      sql: string,
      ...params: any[]
    ): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },

    async rawExec(sql: string, ...params: any[]): Promise<void> {
      if (params.length > 0) {
        db.prepare(sql).run(...params);
      } else {
        db.exec(sql);
      }
    },

    async bulkInsert(
      table: string,
      rows: Record<string, any>[],
    ): Promise<void> {
      if (rows.length === 0) return;
      const firstRow = { _id: generateId(12), ...rows[0] };
      const keys = Object.keys(firstRow);
      const stmt = db.prepare(buildInsertSql(table, keys));

      const insertMany = db.transaction((items: Record<string, any>[]) => {
        for (const row of items) {
          const data: Record<string, any> = {
            _id: row._id ?? generateId(12),
            ...row,
          };
          stmt.run(...keys.map((k) => serializeValue(data[k])));
        }
      });

      insertMany(rows);
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

    close() {
      db.close();
    },
  };
}
