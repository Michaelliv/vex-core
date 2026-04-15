import type {
  MiddlewareFn,
  MutationContext,
  QueryContext,
  TableSchema,
  WebhookRequest,
  WebhookResponse,
} from "../core/types.js";

const KIND = Symbol.for("vex.kind");

export interface VexTable extends TableSchema {
  [KIND]: "table";
}

export interface VexQuery {
  [KIND]: "query";
  args: Record<string, string>;
  handler: (ctx: QueryContext, args: Record<string, any>) => Promise<any> | any;
}

export interface VexMutation {
  [KIND]: "mutation";
  args: Record<string, string>;
  handler: (
    ctx: MutationContext,
    args: Record<string, any>,
  ) => Promise<any> | any;
}

export interface VexWebhook {
  [KIND]: "webhook";
  path: string;
  method?: "POST" | "GET" | "PUT" | "DELETE";
  verify?: (req: WebhookRequest) => boolean;
  handler: (
    ctx: MutationContext,
    req: WebhookRequest,
  ) => Promise<WebhookResponse | any> | WebhookResponse | any;
}

export interface VexJob {
  [KIND]: "job";
  schedule: string;
  handler: (ctx: MutationContext) => Promise<void> | void;
  description?: string;
  enabled?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export function table(
  columns: Record<
    string,
    string | { type: string; index?: boolean; optional?: boolean }
  >,
): VexTable;
export function table(
  storage: "analytical",
  columns: Record<
    string,
    string | { type: string; index?: boolean; optional?: boolean }
  >,
): VexTable;
export function table(first: any, second?: any): VexTable {
  const storage = typeof first === "string" ? first : "transactional";
  const rawColumns = typeof first === "string" ? second : first;

  const columns: TableSchema["columns"] = {};
  for (const [name, def] of Object.entries(rawColumns)) {
    if (typeof def === "string") {
      columns[name] = { type: def as any };
    } else {
      columns[name] = def as any;
    }
  }

  return { [KIND]: "table", columns, storage } as VexTable;
}

export function query(
  args: Record<string, string>,
  handler: VexQuery["handler"],
): VexQuery {
  return { [KIND]: "query", args, handler };
}

export function mutation(
  args: Record<string, string>,
  handler: VexMutation["handler"],
): VexMutation {
  return { [KIND]: "mutation", args, handler };
}

export function webhook(
  path: string,
  handler: VexWebhook["handler"],
): VexWebhook;
export function webhook(
  path: string,
  options: { method?: VexWebhook["method"]; verify?: VexWebhook["verify"] },
  handler: VexWebhook["handler"],
): VexWebhook;
export function webhook(path: string, second: any, third?: any): VexWebhook {
  if (typeof second === "function") {
    return { [KIND]: "webhook", path, handler: second };
  }
  return { [KIND]: "webhook", path, ...second, handler: third };
}

export function job(schedule: string, handler: VexJob["handler"]): VexJob;
export function job(
  schedule: string,
  options: {
    description?: string;
    enabled?: boolean;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  },
  handler: VexJob["handler"],
): VexJob;
export function job(schedule: string, second: any, third?: any): VexJob {
  if (typeof second === "function") {
    return { [KIND]: "job", schedule, handler: second };
  }
  return { [KIND]: "job", schedule, ...second, handler: third };
}

export function middleware(
  fn: MiddlewareFn,
): MiddlewareFn & { [KIND]: "middleware" } {
  return Object.assign(fn, { [KIND]: "middleware" as const });
}

export function isTable(v: any): v is VexTable {
  return v?.[KIND] === "table";
}
export function isQuery(v: any): v is VexQuery {
  return v?.[KIND] === "query";
}
export function isMutation(v: any): v is VexMutation {
  return v?.[KIND] === "mutation";
}
export function isWebhook(v: any): v is VexWebhook {
  return v?.[KIND] === "webhook";
}
export function isJob(v: any): v is VexJob {
  return v?.[KIND] === "job";
}
export function isMiddleware(
  v: any,
): v is MiddlewareFn & { [KIND]: "middleware" } {
  return v?.[KIND] === "middleware";
}
