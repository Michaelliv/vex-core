import type {
  AggDef,
  ColumnDef,
  Filter,
  GroupByBuilder,
  QueryBuilder,
  TableSchema,
} from "../core/types.js";

export function serializeValue(v: any): any {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function deserializeRow(
  row: Record<string, any>,
  schema: TableSchema | undefined,
): Record<string, any> {
  if (!schema) return row;
  for (const [col, def] of Object.entries(schema.columns)) {
    if (!(col in row) || row[col] === null) continue;
    const type = def.type;
    if (type === "json" || type === "any") {
      if (typeof row[col] === "string") {
        try {
          row[col] = JSON.parse(row[col]);
        } catch {}
      }
    } else if (type === "boolean") {
      row[col] = row[col] === 1 || row[col] === true;
    }
  }
  return row;
}

export function buildWhereClause(filters: Filter[]): {
  sql: string;
  params: any[];
} {
  if (filters.length === 0) return { sql: "", params: [] };
  const parts: string[] = [];
  const params: any[] = [];
  for (const f of filters) {
    if (f.operator === "IN") {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      parts.push(`"${f.column}" IN (${arr.map(() => "?").join(", ")})`);
      params.push(...arr);
    } else {
      parts.push(`"${f.column}" ${f.operator} ?`);
      params.push(f.value);
    }
  }
  return { sql: `WHERE ${parts.join(" AND ")}`, params };
}

export interface DbExec {
  all(sql: string, params: any[]): Promise<any[]>;
  run(sql: string, params: any[]): Promise<{ changes: number }>;
  schemas: Map<string, TableSchema>;
}

export function createQueryBuilder(exec: DbExec, table: string): QueryBuilder {
  const filters: Filter[] = [];
  let selectCols: string[] | null = null;
  let orderCol: string | null = null;
  let orderDir: "asc" | "desc" = "asc";
  let limitN: number | null = null;
  let offsetN: number | null = null;

  function buildSql(countOnly = false): { sql: string; params: any[] } {
    const { sql: where, params } = buildWhereClause(filters);
    const select = countOnly
      ? "COUNT(*) as c"
      : selectCols
        ? selectCols.map((c) => `"${c}"`).join(", ")
        : "*";
    let sql = `SELECT ${select} FROM "${table}" ${where}`;
    if (!countOnly && orderCol) sql += ` ORDER BY "${orderCol}" ${orderDir}`;
    if (!countOnly && limitN !== null) sql += ` LIMIT ${limitN}`;
    if (!countOnly && offsetN !== null) sql += ` OFFSET ${offsetN}`;
    return { sql, params };
  }

  const builder: QueryBuilder = {
    where(column, operator, value) {
      filters.push({ column, operator, value });
      return builder;
    },
    select(...columns: string[]) {
      selectCols = columns;
      return builder;
    },
    order(column, dir = "asc") {
      orderCol = column;
      orderDir = dir;
      return builder;
    },
    limit(n) {
      limitN = n;
      return builder;
    },
    offset(n) {
      offsetN = n;
      return builder;
    },
    async all<T>(): Promise<T[]> {
      const { sql, params } = buildSql();
      const rows = await exec.all(sql, params);
      const schema = exec.schemas.get(table);
      return rows.map((r) => deserializeRow(r, schema)) as T[];
    },
    async first<T>(): Promise<T | null> {
      const saved = limitN;
      limitN = 1;
      const { sql, params } = buildSql();
      limitN = saved;
      const rows = await exec.all(sql, params);
      if (!rows[0]) return null;
      return deserializeRow(rows[0], exec.schemas.get(table)) as T;
    },
    async distinct(column: string): Promise<any[]> {
      const { sql: where, params } = buildWhereClause(filters);
      let sql = `SELECT DISTINCT "${column}" FROM "${table}" ${where}`;
      if (orderCol) sql += ` ORDER BY "${orderCol}" ${orderDir}`;
      if (limitN !== null) sql += ` LIMIT ${limitN}`;
      const rows = await exec.all(sql, params);
      return rows.map((r) => r[column]);
    },
    async count(): Promise<number> {
      const { sql, params } = buildSql(true);
      const rows = await exec.all(sql, params);
      return Number((rows[0] as any)?.c ?? 0);
    },
    async countDistinct(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT COUNT(DISTINCT "${column}") as v FROM "${table}" ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async sum(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT SUM("${column}") as v FROM "${table}" ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async avg(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT AVG("${column}") as v FROM "${table}" ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async min(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT MIN("${column}") as v FROM "${table}" ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    async max(column: string): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const rows = await exec.all(
        `SELECT MAX("${column}") as v FROM "${table}" ${where}`,
        params,
      );
      return Number((rows[0] as any)?.v ?? 0);
    },
    groupBy(columns, aggs) {
      return createGroupByBuilder(exec, table, filters, columns, aggs);
    },
    async delete(): Promise<number> {
      const { sql: where, params } = buildWhereClause(filters);
      const result = await exec.run(`DELETE FROM "${table}" ${where}`, params);
      return result.changes;
    },
  };
  return builder;
}

function buildAggSelect(aggs: Record<string, AggDef>): string[] {
  const selects: string[] = [];
  for (const [alias, def] of Object.entries(aggs)) {
    if (def === "count") {
      selects.push(`COUNT(*) as "${alias}"`);
    } else {
      const [fn, col] = def;
      if (fn === "countDistinct") {
        selects.push(`COUNT(DISTINCT "${col}") as "${alias}"`);
      } else {
        selects.push(`${fn.toUpperCase()}("${col}") as "${alias}"`);
      }
    }
  }
  return selects;
}

function createGroupByBuilder(
  exec: DbExec,
  table: string,
  filters: Filter[],
  columns: string | string[],
  aggs: Record<string, AggDef>,
): GroupByBuilder {
  const cols = Array.isArray(columns) ? columns : [columns];
  const havingFilters: Filter[] = [];
  let orderCol: string | null = null;
  let orderDir: "asc" | "desc" = "asc";
  let limitN: number | null = null;

  function execute(): Promise<Record<string, any>[]> {
    const { sql: where, params } = buildWhereClause(filters);
    const groupCols = cols.map((c) => `"${c}"`).join(", ");
    const selects = [...cols.map((c) => `"${c}"`), ...buildAggSelect(aggs)];
    let sql = `SELECT ${selects.join(", ")} FROM "${table}" ${where} GROUP BY ${groupCols}`;
    if (havingFilters.length > 0) {
      const parts: string[] = [];
      for (const f of havingFilters) {
        parts.push(`"${f.column}" ${f.operator} ?`);
        params.push(f.value);
      }
      sql += ` HAVING ${parts.join(" AND ")}`;
    }
    if (orderCol) sql += ` ORDER BY "${orderCol}" ${orderDir}`;
    if (limitN !== null) sql += ` LIMIT ${limitN}`;
    return exec.all(sql, params);
  }

  const builder: GroupByBuilder = {
    having(column: string, operator: Filter["operator"], value: any) {
      havingFilters.push({ column, operator, value });
      return builder;
    },
    order(column: string, dir: "asc" | "desc" = "asc") {
      orderCol = column;
      orderDir = dir;
      return builder;
    },
    limit(n: number) {
      limitN = n;
      return builder;
    },
    // biome-ignore lint/suspicious/noThenProperty: intentional — makes GroupByBuilder awaitable
    then(resolve: any, reject: any) {
      return execute().then(resolve, reject);
    },
    catch(reject: any) {
      return execute().catch(reject);
    },
    finally(fn: any) {
      return execute().finally(fn);
    },
    [Symbol.toStringTag]: "GroupByBuilder",
  } as any;

  return builder;
}

export function buildInsertSql(table: string, keys: string[]): string {
  const cols = keys.map((k) => `"${k}"`).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return `INSERT INTO "${table}" (${cols}) VALUES (${placeholders})`;
}

export function buildUpdateSql(
  table: string,
  data: Record<string, any>,
): { sql: string; values: any[] } {
  const setClauses = Object.keys(data)
    .map((k) => `"${k}" = ?`)
    .join(", ");
  const values = Object.values(data).map(serializeValue);
  return {
    sql: `UPDATE "${table}" SET ${setClauses} WHERE _id = ?`,
    values,
  };
}

export function toSqlType(
  type: ColumnDef["type"],
  dialect: "sqlite" | "duckdb",
): string {
  switch (type) {
    case "number":
      return dialect === "sqlite" ? "REAL" : "DOUBLE";
    case "boolean":
      return dialect === "sqlite" ? "INTEGER" : "BOOLEAN";
    case "json":
    case "any":
      return dialect === "sqlite" ? "TEXT" : "VARCHAR";
    default:
      return dialect === "sqlite" ? "TEXT" : "VARCHAR";
  }
}
