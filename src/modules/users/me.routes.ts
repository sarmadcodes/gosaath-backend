import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import * as me from "./me.service.js";
import * as areas from "../areas/area.service.js";
import * as institutions from "../institutions/institution.service.js";
import * as preferences from "../preferences/preferences.service.js";
import * as vehicles from "../vehicles/vehicle.service.js";
import {
  institutionIdSchema,
  requestBadgeSchema,
  setPhotoSchema,
  updateMeSchema,
} from "./me.schemas.js";

/**
 * Everything a signed-in member does with their own account.
 *
 * `authenticate` runs as a preHandler for the whole plugin rather than per
 * route, so adding a route here cannot accidentally ship unauthenticated.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");

const vehicleSchema = z
  .object({
    id: objectId.optional(),
    type: z.enum(["car", "bike"]),
    model: z.string().trim().min(1).max(120),
    plate: z.string().trim().min(2).max(24),
    colour: z.string().trim().min(2).max(40),
    imageUri: z.string().url().max(2000).nullish(),
  })
  .strict();

const preferencesSchema = z
  .object({
    womenOnly: z.boolean().optional(),
    verifiedOnly: z.boolean().optional(),
    carsOnly: z.boolean().optional(),
    sameCampusOnly: z.boolean().optional(),
    autoAcceptVerified: z.boolean().optional(),
    pickupRadius: z.string().max(60).optional(),
    timeWindow: z.string().max(60).optional(),
  })
  .strict();

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Account ------------------------------------------------------------

  app.get("/me", async (request) => ({
    data: await me.getMe(requireUser(request).id),
  }));

  app.patch("/me", async (request) => {
    const patch = updateMeSchema.parse(request.body);
    return { data: await me.updateMe(requireUser(request).id, patch) };
  });

  app.put("/me/photo", async (request) => {
    const { uri } = setPhotoSchema.parse(request.body);
    return { data: await me.setPhoto(requireUser(request).id, uri) };
  });

  app.post("/me/badge", async (request) => {
    const { documentUri } = requestBadgeSchema.parse(request.body);
    return { data: await me.requestBadge(requireUser(request).id, documentUri) };
  });

  app.post("/me/institutions", async (request) => {
    const { institutionId } = institutionIdSchema.parse(request.body);
    return { data: await me.addInstitution(requireUser(request).id, institutionId) };
  });

  app.delete("/me/institutions/:institutionId", async (request) => {
    const { institutionId } = institutionIdSchema.parse(request.params);
    return {
      data: await me.removeInstitution(requireUser(request).id, institutionId),
    };
  });

  // --- Vehicles -----------------------------------------------------------

  app.get("/vehicles", async (request) => ({
    data: await vehicles.listVehicles(requireUser(request).id),
  }));

  app.put("/vehicles", async (request) => {
    const input = vehicleSchema.parse(request.body);
    return { data: await vehicles.saveVehicle(requireUser(request).id, input) };
  });

  app.delete("/vehicles/:id", async (request, reply) => {
    const { id } = z.object({ id: objectId }).parse(request.params);
    await vehicles.removeVehicle(requireUser(request).id, id);
    return reply.code(204).send();
  });

  // --- Preferences --------------------------------------------------------

  app.get("/preferences", async (request) => ({
    data: await preferences.getPreferences(requireUser(request).id),
  }));

  app.patch("/preferences", async (request) => {
    const patch = preferencesSchema.parse(request.body);
    return {
      data: await preferences.updatePreferences(requireUser(request).id, patch),
    };
  });

  // --- Reference data -----------------------------------------------------
  //
  // Authenticated even though none of it is personal: these are only needed by
  // somebody using the app, and leaving them open invites scraping of the
  // institution list.

  app.get("/areas", async (request) => {
    const { city } = z
      .object({ city: z.string().trim().max(80).optional() })
      .parse(request.query);
    return { data: await areas.listAreas(city) };
  });

  // Campuses are NOT declared here. Registration needs them before anybody is
  // signed in, so they live with the public institution routes — one
  // declaration, not two that can drift apart.
}

/**
 * Institution search and requests, which have to work before sign-in.
 *
 * Registration needs the picker, so these are the one part of Phase 3 that is
 * public. They expose only active institutions and create nothing but a
 * pending review row.
 */
export async function publicInstitutionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/institutions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { q, type } = z
        .object({
          q: z.string().trim().max(120).optional(),
          type: z
            .enum(["university", "college", "school", "organisation"])
            .optional(),
        })
        .parse(request.query);
      return { data: await institutions.searchInstitutions(q ?? "", type) };
    },
  );

  app.get(
    "/institutions/:institutionId/campuses",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const { institutionId } = institutionIdSchema.parse(request.params);
      return { data: await institutions.campusesFor(institutionId) };
    },
  );

  app.post(
    "/institution-requests",
    // Low: this writes a row an admin has to read. Without a limit it is a
    // queue-flooding endpoint.
    { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } },
    async (request) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(200),
          type: z.enum(["university", "college", "school", "organisation"]),
          website: z.string().url().max(300).optional(),
          campusName: z.string().trim().max(160).optional(),
          requestedByEmail: z.string().trim().toLowerCase().email().max(254),
        })
        .strict()
        .parse(request.body);

      return { data: await institutions.requestInstitution(body) };
    },
  );
}
