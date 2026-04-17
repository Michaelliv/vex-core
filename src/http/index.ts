// Core
export { compose } from "./compose.js";
export { HttpError, isHttpError } from "./error.js";
export { createRouter, Router } from "./router.js";
export type { RouterOptions } from "./router.js";
export type {
  ErrorHandler,
  Handler,
  Middleware,
  RequestCtx,
  Session,
} from "./types.js";

// Vex dispatcher (Router you can mount anywhere)
export { vexHandler } from "./vex-handler.js";
export type { VexHandlerOptions } from "./vex-handler.js";

// Batteries
export { accessLog } from "./middleware/access-log.js";
export type { AccessLogOptions, AccessLogMeta } from "./middleware/access-log.js";

export { bearerAuth } from "./middleware/bearer-auth.js";
export type { BearerAuthOptions } from "./middleware/bearer-auth.js";

export { bodyParser } from "./middleware/body-parser.js";
export type { BodyParserOptions } from "./middleware/body-parser.js";

export { cors } from "./middleware/cors.js";
export type { CorsOptions } from "./middleware/cors.js";

export { errorBoundary } from "./middleware/error-boundary.js";
export type { ErrorBoundaryOptions } from "./middleware/error-boundary.js";

export { rateLimit } from "./middleware/rate-limit.js";
export type { RateLimitOptions } from "./middleware/rate-limit.js";

export { requestId } from "./middleware/request-id.js";
export type { RequestIdOptions } from "./middleware/request-id.js";

export { sessions } from "./middleware/sessions.js";
export type { SessionOptions } from "./middleware/sessions.js";

export { staticFiles } from "./middleware/static-files.js";
export type { StaticFilesOptions } from "./middleware/static-files.js";
