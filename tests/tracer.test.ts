import { describe, expect, test } from "bun:test";
import { createRootSpan, type Span } from "../src/core/tracer.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("tracer", () => {
  test("records start time at span creation and duration in milliseconds", async () => {
    const spans: Span[] = [];
    const before = Date.now();
    const root = createRootSpan({ onSpan: (span) => spans.push(span) }, "app", "agent", "run");

    await sleep(20);
    root.span.end("ok");
    const after = Date.now();

    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span.startTime).toBeGreaterThanOrEqual(before);
    expect(span.startTime).toBeLessThanOrEqual(after - 10);
    expect(span.duration).toBeGreaterThanOrEqual(10);
    expect(span.duration).toBeLessThan(1000);
  });
});
