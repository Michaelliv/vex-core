import type { QueryBuilder, TableSchema } from "./types.js";

export interface StorageAdapter {
  readonly name: string;
  ensureTable(name: string, schema: TableSchema): Promise<void> | void;
  insert(table: string, row: Record<string, any>): Promise<string>;
  upsert(
    table: string,
    keys: Record<string, any>,
    data: Record<string, any>,
  ): Promise<void>;
  update(table: string, id: string, data: Record<string, any>): Promise<void>;
  delete(table: string, id: string): Promise<boolean>;
  query(table: string): QueryBuilder;
  transaction<T>(fn: () => Promise<T> | T): Promise<T>;
  rawQuery<T = Record<string, any>>(
    sql: string,
    ...params: any[]
  ): Promise<T[]>;
  rawExec(sql: string, ...params: any[]): Promise<void>;
  bulkInsert(table: string, rows: Record<string, any>[]): Promise<void>;
  getChangedTables(): string[];
  getSchema(table: string): TableSchema | null;
  close(): Promise<void> | void;
}
