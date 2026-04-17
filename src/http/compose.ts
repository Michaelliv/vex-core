/**
 * Onion-style middleware composition. Each middleware receives `next`,
 * which when awaited returns the Response produced by the rest of the
 * chain. next() may only be called once per invocation — calling it
 * twice throws, which catches the classic "double-await next()" bug.
 *
 * The terminal function is what happens when the last middleware calls
 * next() — typically a route handler dispatch. The returned function
 * has the same shape as any other middleware (takes ctx, returns
 * Response), so compositions can nest.
 */

import type { Middleware, RequestCtx } from "./types.js";

/**
 * Compose a chain of middleware into a single function. When all
 * middleware call next(), `terminal(ctx)` is invoked to produce the
 * final Response. Middleware that short-circuits (returns without
 * calling next) prevents terminal from being reached.
 */
export function compose(
  middlewares: Middleware[],
  terminal: (ctx: RequestCtx) => Response | Promise<Response>,
): (ctx: RequestCtx) => Promise<Response> {
  return async function composed(ctx: RequestCtx): Promise<Response> {
    let index = -1;
    const dispatch = async (i: number): Promise<Response> => {
      if (i <= index) {
        throw new Error("next() called multiple times in the same middleware");
      }
      index = i;
      if (i >= middlewares.length) {
        return await terminal(ctx);
      }
      const mw = middlewares[i];
      return await mw(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}
