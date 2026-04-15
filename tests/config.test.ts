import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// parseDuration is not exported, so we test it through the config module indirectly.
// We'll also test the .env loading behavior.

describe("config", () => {
  const saved: Record<string, string | undefined> = {};

  function setEnv(key: string, val: string | undefined) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }

  afterEach(() => {
    for (const [key, val] of Object.entries(saved)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  test("key reads VEX_KEY", async () => {
    setEnv("VEX_KEY", "test-key-123");
    // Re-import to pick up env
    const { config } = await import("../src/core/config.js");
    expect(config.key).toBe("test-key-123");
    setEnv("VEX_KEY", undefined);
  });

  test("spanRetention defaults to 7d", async () => {
    setEnv("VEX_SPAN_RETENTION", undefined);
    const { config } = await import("../src/core/config.js");
    expect(config.spanRetention).toBe("7d");
    expect(config.spanRetentionMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("spanRetention parses custom value", async () => {
    setEnv("VEX_SPAN_RETENTION", "3d");
    const { config } = await import("../src/core/config.js");
    expect(config.spanRetention).toBe("3d");
    expect(config.spanRetentionMs).toBe(3 * 24 * 60 * 60 * 1000);
    setEnv("VEX_SPAN_RETENTION", undefined);
  });

  test("handlerTimeout parses seconds", async () => {
    setEnv("VEX_HANDLER_TIMEOUT", "10s");
    const { config } = await import("../src/core/config.js");
    expect(config.handlerTimeoutMs).toBe(10_000);
    setEnv("VEX_HANDLER_TIMEOUT", undefined);
  });

  test("handlerTimeout parses minutes", async () => {
    setEnv("VEX_HANDLER_TIMEOUT", "5m");
    const { config } = await import("../src/core/config.js");
    expect(config.handlerTimeoutMs).toBe(300_000);
    setEnv("VEX_HANDLER_TIMEOUT", undefined);
  });

  test("handlerTimeout parses hours", async () => {
    setEnv("VEX_HANDLER_TIMEOUT", "1h");
    const { config } = await import("../src/core/config.js");
    expect(config.handlerTimeoutMs).toBe(3_600_000);
    setEnv("VEX_HANDLER_TIMEOUT", undefined);
  });

  test("invalid duration throws", async () => {
    setEnv("VEX_SPAN_RETENTION", "abc");
    const { config } = await import("../src/core/config.js");
    expect(() => config.spanRetentionMs).toThrow("Invalid duration");
    setEnv("VEX_SPAN_RETENTION", undefined);
  });

  test("traceSampleRate defaults to 1.0", async () => {
    setEnv("VEX_TRACE_SAMPLE_RATE", undefined);
    const { config } = await import("../src/core/config.js");
    expect(config.traceSampleRate).toBe(1.0);
  });

  test("traceSampleRate reads custom value", async () => {
    setEnv("VEX_TRACE_SAMPLE_RATE", "0.5");
    const { config } = await import("../src/core/config.js");
    expect(config.traceSampleRate).toBe(0.5);
    setEnv("VEX_TRACE_SAMPLE_RATE", undefined);
  });

  test("idleTimeout defaults to 255", async () => {
    setEnv("VEX_IDLE_TIMEOUT", undefined);
    const { config } = await import("../src/core/config.js");
    expect(config.idleTimeout).toBe(255);
  });

  test("corsOrigin is undefined by default", async () => {
    setEnv("VEX_CORS_ORIGIN", undefined);
    const { config } = await import("../src/core/config.js");
    expect(config.corsOrigin).toBeUndefined();
  });

  test("corsOrigin reads custom value", async () => {
    setEnv("VEX_CORS_ORIGIN", "https://example.com");
    const { config } = await import("../src/core/config.js");
    expect(config.corsOrigin).toBe("https://example.com");
    setEnv("VEX_CORS_ORIGIN", undefined);
  });
});
