import { describe, test, expect } from "bun:test";
import { matchPermission, routePermission, sessionCookie, parseCookie, RateLimiter, parseJson } from "../src/core/auth.js";

describe("matchPermission", () => {
  test("wildcard * matches everything", () => {
    expect(matchPermission("query:my-app:todos.list", ["*"])).toBe(true);
    expect(matchPermission("apps:create", ["*"])).toBe(true);
  });

  test("exact match", () => {
    expect(matchPermission("query:my-app:todos.list", ["query:my-app:todos.list"])).toBe(true);
    expect(matchPermission("query:my-app:todos.list", ["query:my-app:todos.add"])).toBe(false);
  });

  test("wildcard at scope level", () => {
    expect(matchPermission("query:my-app:todos.list", ["query:*"])).toBe(true);
    expect(matchPermission("query:other-app:todos.list", ["query:*"])).toBe(true);
    expect(matchPermission("mutate:my-app:todos.add", ["query:*"])).toBe(false);
  });

  test("wildcard at target level", () => {
    expect(matchPermission("query:my-app:todos.list", ["query:my-app:*"])).toBe(true);
    expect(matchPermission("query:my-app:todos.add", ["query:my-app:*"])).toBe(true);
    expect(matchPermission("query:other-app:todos.list", ["query:my-app:*"])).toBe(false);
  });

  test("multiple permissions", () => {
    const perms = ["query:my-app:todos.list", "mutate:my-app:todos.add"];
    expect(matchPermission("query:my-app:todos.list", perms)).toBe(true);
    expect(matchPermission("mutate:my-app:todos.add", perms)).toBe(true);
    expect(matchPermission("mutate:my-app:todos.delete", perms)).toBe(false);
  });

  test("deploy permission", () => {
    expect(matchPermission("deploy:my-app", ["deploy:my-app"])).toBe(true);
    expect(matchPermission("deploy:my-app", ["deploy:*"])).toBe(true);
    expect(matchPermission("deploy:other", ["deploy:my-app"])).toBe(false);
  });

  test("no permissions matches nothing", () => {
    expect(matchPermission("query:my-app:todos.list", [])).toBe(false);
  });
});

describe("routePermission", () => {
  test("public routes return empty", () => {
    expect(routePermission("GET", "/")).toBe("");
    expect(routePermission("OPTIONS", "/anything")).toBe("");
    expect(routePermission("POST", "/auth")).toBe("");
  });

  test("app management", () => {
    expect(routePermission("POST", "/api/apps")).toBe("apps:create");
    expect(routePermission("GET", "/api/apps")).toBe("apps:list");
    expect(routePermission("DELETE", "/a/my-app/")).toBe("apps:delete");
  });

  test("deploy routes", () => {
    expect(routePermission("POST", "/a/my-app/files/bulk")).toBe("deploy:my-app");
    expect(routePermission("POST", "/a/my-app/boot")).toBe("deploy:my-app");
  });

  test("query/mutate with operation name", () => {
    expect(routePermission("POST", "/a/my-app/query", { name: "todos.list" })).toBe("query:my-app:todos.list");
    expect(routePermission("POST", "/a/my-app/mutate", { name: "todos.add" })).toBe("mutate:my-app:todos.add");
  });

  test("query/mutate without body defaults to *", () => {
    expect(routePermission("POST", "/a/my-app/query")).toBe("query:my-app:*");
    expect(routePermission("POST", "/a/my-app/mutate")).toBe("mutate:my-app:*");
  });

  test("sql", () => {
    expect(routePermission("POST", "/a/my-app/sql")).toBe("sql:my-app");
  });

  test("introspection", () => {
    expect(routePermission("GET", "/a/my-app/info")).toBe("query:my-app:_info");
    expect(routePermission("GET", "/a/my-app/tables")).toBe("query:my-app:_tables");
  });

  test("unknown routes require auth", () => {
    expect(routePermission("GET", "/random")).toBe("_unknown");
    expect(routePermission("POST", "/a/my-app/unknown")).toBe("_unknown");
  });
});

describe("cookie helpers", () => {
  test("sessionCookie produces deterministic value", () => {
    const a = sessionCookie("my-root-key");
    const b = sessionCookie("my-root-key");
    expect(a).toBe(b);
    expect(a.length).toBe(32);
  });

  test("different keys produce different cookies", () => {
    expect(sessionCookie("key-a")).not.toBe(sessionCookie("key-b"));
  });

  test("parseCookie extracts value", () => {
    expect(parseCookie("vex_session=abc123; other=xyz", "vex_session")).toBe("abc123");
    expect(parseCookie("other=xyz; vex_session=abc123", "vex_session")).toBe("abc123");
    expect(parseCookie("other=xyz", "vex_session")).toBeNull();
  });
});

describe("parseJson", () => {
  test("parses JSON strings", () => {
    expect(parseJson('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJson('{"x":1}')).toEqual({ x: 1 });
  });

  test("passes through non-strings", () => {
    expect(parseJson(["a", "b"])).toEqual(["a", "b"]);
    expect(parseJson(null)).toBeNull();
    expect(parseJson(42)).toBe(42);
  });

  test("returns original on invalid JSON string", () => {
    expect(parseJson("not json")).toBe("not json");
  });
});

describe("RateLimiter", () => {
  test("allows requests within limit", () => {
    const rl = new RateLimiter();
    const limit = { requests: 3, window: 60 };
    expect(rl.check("key1", limit).allowed).toBe(true);
    expect(rl.check("key1", limit).allowed).toBe(true);
    expect(rl.check("key1", limit).allowed).toBe(true);
  });

  test("blocks requests over limit", () => {
    const rl = new RateLimiter();
    const limit = { requests: 2, window: 60 };
    expect(rl.check("key1", limit).allowed).toBe(true);
    expect(rl.check("key1", limit).allowed).toBe(true);
    const result = rl.check("key1", limit);
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  test("different keys have separate buckets", () => {
    const rl = new RateLimiter();
    const limit = { requests: 1, window: 60 };
    expect(rl.check("key1", limit).allowed).toBe(true);
    expect(rl.check("key2", limit).allowed).toBe(true);
    expect(rl.check("key1", limit).allowed).toBe(false);
    expect(rl.check("key2", limit).allowed).toBe(false);
  });

  test("prune removes expired buckets", () => {
    const rl = new RateLimiter();
    const limit = { requests: 1, window: 0 };
    rl.check("key1", limit);
    rl.prune();
    expect(rl.check("key1", limit).allowed).toBe(true);
  });
});
