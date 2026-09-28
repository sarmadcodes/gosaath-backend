import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import * as commutes from "./commute.service.js";
import * as week from "./week.service.js";

/**
 * Commute template and week.
 *
 * Every route takes the caller from the session. Where the client passes a
 * commuteId — the contract does, for the week endpoints — the service checks
 * ownership or membership before touching anything.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

/**
 * One entry per day travelled.
 *
 * `arriveBy` and `leaveCampusAt` are CAMPUS times, not departure times — when
 * they must be on campus and when they are done. A day can carry only
 * `arriveBy`: plenty of people travel in and not back.
 */
const daySchedule = z
  .object({
    day: weekday,
    arriveBy: time.optional(),
    leaveCampusAt: time.optional(),
  })
  .strict()
  .refine((entry) => entry.arriveBy || entry.leaveCampusAt, {
    message: "A day needs at least one time",
  });

const schedule = z
  .array(daySchedule)
  .min(1, "Pick at least one day")
  .max(7)
  .refine(
    (entries) => new Set(entries.map((e) => e.day)).size === entries.length,
    // A duplicated weekday makes "does Monday match?" ambiguous, and the days
    // are implied by these entries — there is no separate array to reconcile.
    { message: "Each day can appear only once" },
  );

const commuteBody = z
  .object({
    intent: z.enum(["find", "offer", "both"]),
    // Accepted because the client has it to hand, and stripped below. The
    // service's own type has no institutionId at all, so "put me in another
    // institution" is not merely refused at runtime — it does not typecheck.
    institutionId: objectId.optional(),
    campusId: objectId,
    originAreaId: objectId,
    schedule,
    direction: z.enum(["going", "returning", "both"]),
    vehicleId: objectId.optional(),
    seatsOffered: z.number().int().min(0).max(8).optional(),
    /** Guidance, not a limit: a short hop and a run in from Malir both count. */
    contribution: z.number().int().min(0).max(100_000).optional(),
    womenOnly: z.boolean(),
  })
  .strict();

export async function commuteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  app.get("/commutes/mine", async (request) => ({
    // null when there is none. The client's setup card depends on the
    // difference between "no commute" and "could not load".
    data: await commutes.myCommute(requireUser(request).id),
  }));

  app.post("/commutes", async (request) => {
    const { institutionId: _ignored, ...body } = commuteBody.parse(request.body);
    return { data: await commutes.createCommute(requireUser(request).id, body) };
  });

  app.patch("/commutes/:id", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { institutionId: _ignored, ...body } = commuteBody
      .partial()
      .strict()
      .parse(request.body);
    return {
      data: await commutes.updateCommute(requireUser(request).id, id, body),
    };
  });

  app.delete("/commutes/:id", async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    await commutes.cancelCommute(requireUser(request).id, id);
    return reply.code(204).send();
  });

  // --- The week -----------------------------------------------------------

  app.get("/commutes/:id/week", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    return { data: await week.weekFor(requireUser(request).id, id) };
  });

  app.get("/commutes/:id/members", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    return { data: await week.membersFor(requireUser(request).id, id) };
  });

  app.post("/commutes/:id/skip", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { day } = z.object({ day: weekday }).strict().parse(request.body);
    return { data: await week.skipDay(requireUser(request).id, id, day) };
  });

  app.get("/commutes/:id/replacements", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { day } = z.object({ day: weekday }).strict().parse(request.query);
    return { data: await week.replacementsFor(requireUser(request).id, id, day) };
  });

  app.post("/commutes/:id/unavailable", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { days } = z
      .object({ days: z.array(weekday).min(1).max(7) })
      .strict()
      .parse(request.body);
    return { data: await week.setUnavailable(requireUser(request).id, id, days) };
  });
}
