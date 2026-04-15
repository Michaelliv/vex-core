import { createHmac } from "node:crypto";

// Permission pattern: "resource:scope:target"
// Examples:
//   query:*              → all queries on all apps
//   query:my-app:*       → all queries on my-app
//   query:my-app:todos.list → specific query on specific app
//   mutate:my-app:todos.add
//   deploy:my-app
//   traces:*
//   sql:my-app
//   apps:create
//   apps:delete
//   keys:*
//   *                    → everything (root)

export interface RateLimit {
  requests: number;
  window: number; // seconds
}

export interface Key {
  id: string;
  name: string;
  key: string;
  permissions: string[];
  rateLimit: RateLimit | null;
  createdAt: number;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateBucket>();

  check(
    identity: string,
    limit: RateLimit,
  ): { allowed: boolean; retryAfter: number } {
    const now = Date.now();
    const bucket = this.buckets.get(identity);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(identity, {
        count: 1,
        resetAt: now + limit.window * 1000,
      });
      return { allowed: true, retryAfter: 0 };
    }

    bucket.count++;
    if (bucket.count > limit.requests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }

    return { allowed: true, retryAfter: 0 };
  }

  // Periodic cleanup of expired buckets
  prune() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key);
    }
  }
}

export function parseJson(val: any): any {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

export function matchPermission(required: string, granted: string[]): boolean {
  for (const perm of granted) {
    if (perm === "*") return true;
    if (perm === required) return true;

    // Pattern matching with wildcards
    const reqParts = required.split(":");
    const permParts = perm.split(":");

    let match = true;
    for (let i = 0; i < reqParts.length; i++) {
      if (i >= permParts.length) {
        match = false;
        break;
      }
      if (permParts[i] === "*") break; // wildcard matches rest
      if (permParts[i] !== reqParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// Map HTTP routes to permission strings
export function routePermission(
  method: string,
  path: string,
  body?: any,
): string {
  // POST /auth — always allowed (it's the login endpoint)
  if (method === "POST" && path === "/auth") return "";

  // GET / — dashboard HTML, always allowed
  if (method === "GET" && (path === "/" || path === "")) return "";

  // OPTIONS — always allowed
  if (method === "OPTIONS") return "";

  // POST /api/apps — create app
  if (method === "POST" && path === "/api/apps") return "apps:create";

  // GET /api/apps — list apps
  if (method === "GET" && path === "/api/apps") return "apps:list";

  // App-scoped routes
  const appMatch = path.match(/^\/a\/([^/]+)(\/.*)?$/);
  if (!appMatch) return "_unknown";

  const app = appMatch[1];
  const sub = appMatch[2] ?? "/";

  if (method === "DELETE" && (sub === "/" || sub === "")) return `apps:delete`;
  if (method === "POST" && sub === "/files/bulk") return `deploy:${app}`;
  if (method === "POST" && sub === "/files") return `deploy:${app}`;
  if (method === "POST" && sub === "/boot") return `deploy:${app}`;
  if (method === "GET" && sub === "/files") return `deploy:${app}`;
  if (method === "GET" && sub === "/file") return `deploy:${app}`;
  if (method === "POST" && sub === "/sql") return `sql:${app}`;
  if (method === "GET" && sub === "/info") return `query:${app}:_info`;
  if (method === "GET" && sub === "/tables") return `query:${app}:_tables`;
  if (sub.match(/^\/tables\//)) return `query:${app}:_tables`;

  if (method === "POST" && sub === "/query") {
    const name = body?.name ?? "*";
    return `query:${app}:${name}`;
  }
  if (method === "POST" && sub === "/mutate") {
    const name = body?.name ?? "*";
    return `mutate:${app}:${name}`;
  }
  if (method === "GET" && sub === "/subscribe") {
    return `query:${app}:*`; // name is in query params, checked at request level
  }

  if (sub.startsWith("/webhook/")) return `mutate:${app}:_webhook`;

  return "_unknown";
}

export function sessionCookie(rootKey: string): string {
  return createHmac("sha256", rootKey)
    .update("vex_session")
    .digest("hex")
    .slice(0, 32);
}

export function parseCookie(header: string, name: string): string | null {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}
