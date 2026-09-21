import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import * as matching from "./matching.service.js";
import * as rides from "../rides/ride.service.js";
import * as seatRequests from "../rides/seat-request.service.js";
import * as location from "../location/location.service.js";

/**
 * Matches, ride listings and location lookups.
 *
 * Notice what none of these routes accept: an institution or a campus that
 * actually gets used. Both are constraints read from the caller's own account,
 * so there is nothing here for a tampered client to widen.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");
const weekday = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

export async function matchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Matches ------------------------------------------------------------

  app.get("/matches/summary", async (request) => ({
    // Five-way state, computed here. The client cannot tell "nobody on your
    // days" from "nobody here yet" by looking at a count.
    data: await matching.matchSummary(requireUser(request).id),
  }));

  app.get("/matches", async (request) => ({
    data: await matching.listMatches(requireUser(request).id),
  }));

  app.post("/matches/:id/area", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { status } = z
      .object({ status: z.enum(["accepted", "rejected"]) })
      .strict()
      .parse(request.body);

    return {
      data: await matching.setAreaMatch(requireUser(request).id, id, status),
    };
  });

  // --- Rides --------------------------------------------------------------

  app.get("/rides", async (request) => {
    const params = z
      .object({
        // Accepted because the client type carries them; a value that differs
        // from the caller's own is rejected by the service rather than
        // silently ignored.
        institutionId: objectId.optional(),
        campusId: objectId.optional(),
        day: weekday.optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        vehicleType: z.enum(["car", "bike"]).optional(),
        womenOnly: z.coerce.boolean().optional(),
      })
      .strict()
      .parse(request.query);

    return { data: await rides.searchRides(requireUser(request).id, params) };
  });

  app.get("/rides/nearby", async (request) => {
    const params = z
      .object({ day: weekday.optional() })
      .strict()
      .parse(request.query);

    return { data: await rides.nearbyRides(requireUser(request).id, params) };
  });

  app.get("/rides/:id", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    // null rather than 404: the client treats a missing listing as "gone",
    // which is an ordinary outcome when a ride fills up.
    return { data: await rides.getRide(requireUser(request).id, id) };
  });

  // --- Seat requests ------------------------------------------------------
  //
  // Two directions, deliberately two endpoints. One is a to-do list with
  // Accept and Decline on it; the other is a waiting list. Merging them makes
  // both useless.

  app.get("/requests/incoming", async (request) => ({
    data: await seatRequests.incomingRequests(requireUser(request).id),
  }));

  app.get("/requests/sent", async (request) => ({
    data: await seatRequests.sentRequests(requireUser(request).id),
  }));

  app.post("/rides/:id/request", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { seats } = z
      .object({ seats: z.number().int().min(1).max(4).default(1) })
      .strict()
      .parse(request.body ?? {});

    return {
      data: await seatRequests.requestSeat(requireUser(request).id, id, seats),
    };
  });

  app.post("/requests/:id/respond", async (request) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    const { action } = z
      .object({ action: z.enum(["accept", "decline"]) })
      .strict()
      .parse(request.body);

    return {
      data: await seatRequests.respondToRequest(
        requireUser(request).id,
        id,
        action,
      ),
    };
  });

  // --- Location -----------------------------------------------------------

  app.get("/location/search", async (request) => {
    const { q } = z
      .object({ q: z.string().trim().max(120).optional() })
      .parse(request.query);
    return { data: await location.searchAreas(q ?? "") };
  });

  app.get("/location/recent", async (request) => ({
    data: await location.recentAreas(requireUser(request).id),
  }));

  app.get("/location/proximity", async (request) => {
    const { from, to } = z
      .object({ from: objectId, to: objectId })
      .strict()
      .parse(request.query);
    return { data: await location.proximity(from, to) };
  });

  app.get("/location/route", async (request) => {
    const { originAreaId, campusId } = z
      .object({ originAreaId: objectId, campusId: objectId })
      .strict()
      .parse(request.query);
    return { data: await location.routePreview(originAreaId, campusId) };
  });
}
