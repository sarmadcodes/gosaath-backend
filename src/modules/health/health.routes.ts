import type { FastifyInstance } from "fastify";
import { databaseStatus, pingDatabase } from "../../db/mongodb.js";
import { env } from "../../config/env.js";

/**
 * Health endpoints.
 *
 * Three, because orchestrators ask three different questions and answering
 * them all with one endpoint causes the wrong thing to happen:
 *
 *   /health/live   is the process alive? — a false here restarts the pod
 *   /health/ready  can it serve traffic? — a false here removes it from the
 *                  load balancer without restarting it
 *   /health        a human-readable summary
 *
 * Conflating them means a brief database blip restarts every instance at once.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const startedAt = Date.now();

  // Liveness is deliberately dependency-free: if this handler runs at all,
  // the event loop is turning, which is the only thing it claims.
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const db = databaseStatus();
    const reachable = db === "connected" ? await pingDatabase() : false;
    const ready = reachable;

    // 503 while not ready, so a load balancer takes this instance out rather
    // than sending it requests that are going to fail.
    reply.code(ready ? 200 : 503);
    return {
      status: ready ? "ready" : "not_ready",
      checks: {
        // Status only. The driver's message carries the host and port, and
        // this endpoint is unauthenticated so a probe could be used to map
        // internal infrastructure. The detail is logged, not served.
        database: { status: db, reachable },
      },
    };
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "gosaath-backend",
    environment: env.NODE_ENV,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timezone: env.TZ,
    database: databaseStatus(),
  }));
}
