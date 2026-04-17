import { describe, expect, test } from "bun:test";
import { sqliteAdapter } from "../../src/adapters/sqlite.js";
import { createRouter, sessions } from "../../src/http/index.js";

function extractSetCookie(res: Response): string | null {
  return res.headers.get("set-cookie");
}

function extractCookieValue(setCookie: string | null, name: string): string | null {
  if (!setCookie) return null;
  const m = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

describe("sessions", () => {
  test("no write when session untouched", async () => {
    const storage = sqliteAdapter(":memory:");
    const app = createRouter()
      .use(sessions({ storage }))
      .get("/", () => new Response("ok"));

    const res = await app.handle(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(extractSetCookie(res)).toBeNull();
    const count = await storage.query("vex_sessions").count();
    expect(count).toBe(0);
  });

  test("setting data creates a row + cookie", async () => {
    const storage = sqliteAdapter(":memory:");
    const app = createRouter()
      .use(sessions({ storage }))
      .get("/set", (ctx) => {
        ctx.session?.set("user", "alice");
        return new Response("ok");
      });

    const res = await app.handle(new Request("http://x/set"));
    const setCookie = extractSetCookie(res);
    expect(setCookie).toContain("vex_session=");
    const sid = extractCookieValue(setCookie, "vex_session");
    expect(sid).toBeTruthy();

    const row = (await storage
      .query("vex_sessions")
      .where("id", "=", sid!)
      .first()) as any;
    expect(row).not.toBeNull();
    // The sqlite adapter auto-parses `json` columns; older adapters
    // may return a string. Accept either to keep this test portable.
    const data =
      typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    expect(data).toEqual({ user: "alice" });
  });

  test("reading existing session returns data", async () => {
    const storage = sqliteAdapter(":memory:");
    const app = createRouter()
      .use(sessions({ storage }))
      .get("/set", (ctx) => {
        ctx.session?.set("count", 1);
        return new Response("ok");
      })
      .get("/read", (ctx) =>
        Response.json({ count: ctx.session?.get("count") ?? null }),
      );

    const setRes = await app.handle(new Request("http://x/set"));
    const sid = extractCookieValue(extractSetCookie(setRes), "vex_session");
    const readRes = await app.handle(
      new Request("http://x/read", {
        headers: { cookie: `vex_session=${sid}` },
      }),
    );
    expect(await readRes.json()).toEqual({ count: 1 });
  });

  test("destroy deletes the row and clears the cookie", async () => {
    const storage = sqliteAdapter(":memory:");
    const app = createRouter()
      .use(sessions({ storage }))
      .get("/set", (ctx) => {
        ctx.session?.set("a", 1);
        return new Response("ok");
      })
      .get("/bye", async (ctx) => {
        await ctx.session?.destroy();
        return new Response("ok");
      });

    const setRes = await app.handle(new Request("http://x/set"));
    const sid = extractCookieValue(extractSetCookie(setRes), "vex_session");

    const byeRes = await app.handle(
      new Request("http://x/bye", {
        headers: { cookie: `vex_session=${sid}` },
      }),
    );
    const byeCookie = extractSetCookie(byeRes);
    expect(byeCookie).toContain("Max-Age=0");

    const row = await storage
      .query("vex_sessions")
      .where("id", "=", sid!)
      .first();
    expect(row).toBeNull();
  });

  test("expired session cookie is treated as absent", async () => {
    const storage = sqliteAdapter(":memory:");
    const app = createRouter()
      .use(sessions({ storage, maxAge: 1 }))
      .get("/set", (ctx) => {
        ctx.session?.set("k", "v");
        return new Response("ok");
      })
      .get("/read", (ctx) =>
        Response.json({ k: ctx.session?.get("k") ?? null }),
      );

    const setRes = await app.handle(new Request("http://x/set"));
    const sid = extractCookieValue(extractSetCookie(setRes), "vex_session");

    // Artificially age the row past maxAge.
    const row = (await storage
      .query("vex_sessions")
      .where("id", "=", sid!)
      .first()) as any;
    await storage.update("vex_sessions", row._id, {
      expiresAt: Date.now() - 10_000,
    });

    const readRes = await app.handle(
      new Request("http://x/read", {
        headers: { cookie: `vex_session=${sid}` },
      }),
    );
    expect(await readRes.json()).toEqual({ k: null });
    // And the row should now be gone.
    const again = await storage
      .query("vex_sessions")
      .where("id", "=", sid!)
      .first();
    expect(again).toBeNull();
  });
});
