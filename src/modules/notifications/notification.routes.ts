import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import * as notifications from "./notification.service.js";

/**
 * The in-app list, and the device tokens push delivery needs.
 *
 * Every route is scoped to the caller. There is no notification id that
 * belongs to somebody else, because the queries filter on `userId` rather than
 * checking it afterwards.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

/**
 * Expo's token format.
 *
 * Validated rather than accepted as any string: an unvalidated token is a
 * stored value we will later send to a third party on somebody's behalf.
 */
const pushToken = z
  .string()
  .trim()
  .min(10)
  .max(200)
  .regex(/^(ExponentPushToken\[.+\]|ExpoPushToken\[.+\])$/, "Not a push token");

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/notifications", async (request) => ({
    data: await notifications.listNotifications(requireUser(request).id),
  }));

  app.post("/notifications/:id/read", async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    await notifications.markRead(requireUser(request).id, id);
    // Idempotent: marking an already-read notification is a no-op rather than
    // an error, because it happens every time somebody taps twice.
    return reply.code(204).send();
  });

  app.post("/notifications/token", async (request, reply) => {
    const { token, platform } = z
      .object({ token: pushToken, platform: z.enum(["ios", "android"]) })
      .strict()
      .parse(request.body);

    await notifications.registerPushToken(
      requireUser(request).id,
      token,
      platform,
    );
    return reply.code(204).send();
  });

  app.delete("/notifications/token", async (request, reply) => {
    const { token } = z.object({ token: pushToken }).strict().parse(request.body);
    // Scoped to the caller: signing out must not let somebody unregister a
    // device that is not theirs.
    await notifications.unregisterPushToken(requireUser(request).id, token);
    return reply.code(204).send();
  });
}
