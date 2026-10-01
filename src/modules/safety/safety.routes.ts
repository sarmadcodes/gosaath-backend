import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import * as safety from "./safety.service.js";
import * as alerts from "./alert.service.js";
import * as shares from "./trip-share.service.js";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.post(
    "/safety/reports",
    // Writes a row a moderator has to read. Generous enough for a real
    // incident, low enough that the queue cannot be flooded.
    { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const body = z
        .object({
          reportedUserId: objectId.optional(),
          category: z.enum(safety.REPORT_CATEGORIES),
          detail: z.string().trim().max(4000).optional(),
        })
        .strict()
        .parse(request.body);

      await safety.fileReport(requireUser(request).id, body);
      return reply.code(204).send();
    },
  );

  app.post("/safety/blocks", async (request, reply) => {
    const { userId } = z.object({ userId: objectId }).strict().parse(request.body);
    await safety.block(requireUser(request).id, userId);
    return reply.code(204).send();
  });

  app.delete("/safety/blocks/:userId", async (request, reply) => {
    const { userId } = z.object({ userId: objectId }).parse(request.params);
    await safety.unblock(requireUser(request).id, userId);
    return reply.code(204).send();
  });

  app.get("/safety/blocks", async (request) => ({
    data: await safety.blockedBy(requireUser(request).id),
  }));

  // --- The help button ----------------------------------------------------

  /**
   * Raises a safety alert.
   *
   * Rate limited generously rather than tightly: somebody pressing this twice
   * because they are frightened and not sure it worked must not be refused.
   * The limit is there to stop a script, not a person.
   */
  app.post(
    "/safety/alerts",
    { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request) => {
      const body = z
        .object({
          kind: z.enum(["sos", "feelingUnsafe"]),
          rideInstanceId: objectId.optional(),
          note: z.string().trim().max(2000).optional(),
        })
        .strict()
        .parse(request.body);

      return { data: await alerts.raiseAlert(requireUser(request).id, body) };
    },
  );

  /** The emergency numbers, so a wrong one is not frozen into a binary. */
  app.get("/safety/emergency-contacts", async () => ({
    data: alerts.EMERGENCY_CONTACTS,
  }));

  app.get("/safety/alerts", async (request) => ({
    data: await alerts.myAlerts(requireUser(request).id),
  }));

  // --- Trip sharing -------------------------------------------------------

  app.post("/rides/:id/share", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    // The token is in this response and in no other. Read access to the
    // account later must not hand somebody the link itself.
    return { data: await shares.shareTrip(requireUser(request).id, id) };
  });

  app.get("/rides/:id/share", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    return { data: await shares.myTripShare(requireUser(request).id, id) };
  });

  app.delete("/rides/:id/share", async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    await shares.revokeTripShare(requireUser(request).id, id);
    return reply.code(204).send();
  });

  app.post(
    "/support",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const body = z
        .object({
          category: z.enum(safety.SUPPORT_CATEGORIES),
          message: z.string().trim().min(10).max(8000),
          // The contract sends it; the reply address comes from the account.
          email: z.string().optional(),
        })
        .strict()
        .parse(request.body);

      return {
        data: await safety.submitSupport(requireUser(request).id, {
          category: body.category,
          message: body.message,
        }),
      };
    },
  );
}
