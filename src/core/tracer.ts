import { id } from "./id.js";

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  app: string;
  type: string;
  name: string;
  startTime: number;
  duration: number;
  status: "ok" | "error";
  error: string | null;
  meta: string | null;
}

export interface Tracer {
  onSpan(span: Span): void;
}

export interface SpanHandle {
  spanId: string;
  end(
    status?: "ok" | "error",
    opts?: { error?: string; meta?: Record<string, any> },
  ): void;
  child(type: string, name: string): SpanHandle;
}

export interface ExecContext {
  traceId: string;
  span: SpanHandle;
}

const noopSpan: SpanHandle = {
  spanId: "",
  end() {},
  child() {
    return noopSpan;
  },
};

export const noopExecCtx: ExecContext = { traceId: "", span: noopSpan };

export function createRootSpan(
  tracer: Tracer | null,
  app: string,
  type: string,
  name: string,
  traceId?: string,
): ExecContext {
  if (!tracer) return noopExecCtx;
  const tid = traceId ?? id(8);
  const span = makeSpan(tracer, tid, null, app, type, name);
  return { traceId: tid, span };
}

function makeSpan(
  tracer: Tracer,
  traceId: string,
  parentSpanId: string | null,
  app: string,
  type: string,
  name: string,
): SpanHandle {
  const spanId = id(8);
  const start = performance.now();
  let ended = false;
  return {
    spanId,
    end(status: "ok" | "error" = "ok", opts?) {
      if (ended) return;
      ended = true;
      tracer.onSpan({
        traceId,
        spanId,
        parentSpanId,
        app,
        type,
        name,
        startTime: Date.now(),
        duration: Math.round((performance.now() - start) * 1000),
        status,
        error: opts?.error ?? null,
        meta: opts?.meta ? JSON.stringify(opts.meta) : null,
      });
    },
    child(childType: string, childName: string): SpanHandle {
      return makeSpan(tracer, traceId, spanId, app, childType, childName);
    },
  };
}
