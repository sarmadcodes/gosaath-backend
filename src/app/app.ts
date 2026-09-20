import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { healthRoutes } from "../modules/health/health.routes.js";
import { authRoutes } from "../modules/auth/auth.routes.js";
import {
  meRoutes,
  publicInstitutionRoutes,
} from "../modules/users/me.routes.js";
import { commuteRoutes } from "../modules/commutes/commute.routes.js";
import { matchRoutes } from "../modules/matching/match.routes.js";

/**
 * Builds the application without listening.
 *
 * Kept separate from `server.ts` so tests can drive it through `app.inject()`
 * without binding a port — which is what makes the integration suite able to
 * run in parallel later.
 */
export type BuildOptions = {
  /**
   * Rate limiting, on by default.
   *
   * Most integration tests share one IP and would exhaust the auth limits
   * within a few cases, so they turn it off. The limits themselves are still
   * covered — by tests that build an app with this left on and assert the
   * throttling actually happens.
   */
  rateLimit?: boolean;
};

export async function buildApp(
  options: BuildOptions = {},
): Promise<FastifyInstance> {
  const rateLimitEnabled = options.rateLimit ?? true;
  const app = Fastify({
    // Narrowed to the interface Fastify documents. Passing the concrete pino
    // type re-parameterises every FastifyInstance generic downstream, so each
    // route module would have to restate them.
    loggerInstance: logger as FastifyBaseLogger,
    // Trust the proxy only where one actually terminates TLS. Trusting it
    // everywhere lets a client forge X-Forwarded-For and defeat rate limits.
    trustProxy: env.isProduction || env.NODE_ENV === "staging",
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestTimeout: env.REQUEST_TIMEOUT_MS,
    // Correlation id on every request, echoed in errors and logs. Accepts an
    // upstream one so a trace survives the proxy hop.
    genReqId: (req) => {
      const upstream = req.headers["x-request-id"];
      if (typeof upstream === "string" && upstream.length <= 128) {
        return upstream;
      }
      return `req_${randomUUID()}`;
    },
  });

  await app.register(helmet, {
    // This API serves JSON to a native app and two dashboards; it never
    // renders HTML, so the browser-document directives are not the point —
    // the transport and sniffing protections are.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: env.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
  });

  await app.register(cors, {
    // The mobile app sends no Origin, so requests without one are allowed.
    // Browser callers must be on the explicit list — never "*" for an
    // authenticated API.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (env.isDevelopment) return callback(null, true);
      if (env.corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    maxAge: 86_400,
  });

  // A global floor only. Auth and other sensitive routes get their own,
  // much stricter limits where they are defined.
  await app.register(rateLimit, {
    global: rateLimitEnabled,
    max: 300,
    timeWindow: "1 minute",
    // Per account once sessions exist; per IP until then.
    keyGenerator: (request) => request.ip,
    // Health checks must never be throttled: a rate-limited readiness probe
    // reads as an outage and takes the instance out.
    allowList: (request) =>
      !rateLimitEnabled || request.url.startsWith("/health"),
  });

  registerErrorHandler(app);

  await app.register(healthRoutes);

  // Everything else is versioned. Health is not: probes should not have to
  // follow a version bump.
  await app.register(
    async (api) => {
      api.get("/", async () => ({
        data: { service: "gosaath-backend", version: "v1" },
      }));
      await api.register(authRoutes, { prefix: "/auth" });
      // Public: registration needs the institution picker before sign-in.
      await api.register(publicInstitutionRoutes);
      await api.register(meRoutes);
      await api.register(commuteRoutes);
      await api.register(matchRoutes);
    },
    { prefix: "/api/v1" },
  );

  return app;
}
