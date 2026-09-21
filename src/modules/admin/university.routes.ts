import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin, requireAdminContext } from "../../middleware/admin.js";
import * as uni from "./university.service.js";

/**
 * The University Admin API.
 *
 * Every route runs `requireAdmin`, so both university admins (their own
 * institution) and super admins (any institution) use it. The service does
 * the scoping; nothing here reads an institution id without it being checked.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");
const idParam = z.object({ id: objectId });

const ctx = (request: FastifyRequest) => ({
  admin: requireAdminContext(request),
  request,
});

export async function universityAdminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAdmin);

  app.get("/admin/overview", async (request) => {
    const { institutionId } = z
      .object({ institutionId: objectId.optional() })
      .strict()
      .parse(request.query);
    return { data: await uni.overview(ctx(request), institutionId) };
  });

  // --- Members --------------------------------------------------------------

  const memberFilters = z
    .object({
      institutionId: objectId.optional(),
      campusId: objectId.optional(),
      userType: z.enum(["student", "teacher"]).optional(),
      badgeStatus: z.enum(["none", "pending", "approved", "rejected"]).optional(),
      suspended: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
      q: z.string().trim().max(120).optional(),
    })
    .strict();

  app.get("/admin/members", async (request) => {
    const filters = memberFilters
      .extend({
        before: objectId.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(request.query);

    const page = await uni.listMembers(ctx(request), filters);
    return { data: page.members, meta: { nextCursor: page.nextCursor } };
  });

  app.get("/admin/members/export.csv", async (request, reply) => {
    const filters = memberFilters.parse(request.query);
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="members.csv"')
      // An export is a snapshot of people's details; nothing between here and
      // the admin should keep a copy.
      .header("Cache-Control", "no-store");
    return reply.send(Readable.from(uni.exportMembersCsv(ctx(request), filters)));
  });

  app.get("/admin/members/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    return { data: await uni.getMember(ctx(request), id) };
  });

  app.post("/admin/members/:id/suspend", async (request) => {
    const { id } = idParam.parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().min(5).max(500) })
      .strict()
      .parse(request.body);
    return { data: await uni.suspendMember(ctx(request), id, reason) };
  });

  app.post("/admin/members/:id/restore", async (request) => {
    const { id } = idParam.parse(request.params);
    return { data: await uni.restoreMember(ctx(request), id) };
  });

  app.post(
    "/admin/members/:id/reveal-phone",
    // Deliberately slow to use in bulk: revealing numbers one by one with a
    // reason each time is the point.
    { config: { rateLimit: { max: 30, timeWindow: "1 hour" } } },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z
        .object({ reason: z.string().trim().min(5).max(300) })
        .strict()
        .parse(request.body);
      return { data: await uni.revealPhone(ctx(request), id, reason) };
    },
  );

  // --- Verification ---------------------------------------------------------

  app.get("/admin/verifications", async (request) => {
    const { institutionId } = z
      .object({ institutionId: objectId.optional() })
      .strict()
      .parse(request.query);
    return { data: await uni.verificationQueue(ctx(request), institutionId) };
  });

  app.post("/admin/verifications/:id/decision", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        approve: z.boolean(),
        reason: z.enum(uni.REJECTION_REASONS).optional(),
        note: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(request.body);
    return { data: await uni.decideVerification(ctx(request), id, body) };
  });

  // --- Campuses -------------------------------------------------------------

  app.get("/admin/campuses", async (request) => {
    const { institutionId } = z
      .object({ institutionId: objectId.optional() })
      .strict()
      .parse(request.query);
    return { data: await uni.listCampuses(ctx(request), institutionId) };
  });

  app.post("/admin/campuses", async (request) => {
    const body = z
      .object({
        name: z.string().trim().min(2).max(160),
        areaId: objectId.optional(),
        institutionId: objectId.optional(),
      })
      .strict()
      .parse(request.body);
    return { data: await uni.createCampus(ctx(request), body) };
  });

  app.patch("/admin/campuses/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(2).max(160).optional(),
        areaId: objectId.nullable().optional(),
        active: z.boolean().optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return { data: await uni.updateCampus(ctx(request), id, body) };
  });

  // --- Institution profile --------------------------------------------------

  app.patch("/admin/institutions/:id", async (request) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        shortName: z.string().trim().min(1).max(40).optional(),
        // The whole app accent for this institution's members, so validated
        // rather than trusted.
        brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #0C4DA1").optional(),
        logoMarkUrl: z.string().url().max(2000).nullable().optional(),
        logoWideUrl: z.string().url().max(2000).nullable().optional(),
        emailDomains: z
          .array(z.string().trim().toLowerCase().regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/, "Not a domain"))
          .min(1)
          .max(10)
          .optional(),
        confirm: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return { data: await uni.updateInstitutionProfile(ctx(request), id, body) };
  });

  // --- Reports --------------------------------------------------------------

  app.get("/admin/reports", async (request) => {
    const filters = z
      .object({
        status: z.enum(["open", "dismissed", "warned", "suspended", "escalated"]).optional(),
        institutionId: objectId.optional(),
        before: objectId.optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .strict()
      .parse(request.query);
    const page = await uni.listReports(ctx(request), filters);
    return { data: page.reports, meta: { nextCursor: page.nextCursor } };
  });

  app.post("/admin/reports/:id/action", async (request) => {
    const { id } = idParam.parse(request.params);
    const { action, note } = z
      .object({
        action: z.enum(["dismiss", "warn", "suspend", "escalate"]),
        note: z.string().trim().max(1000).optional(),
      })
      .strict()
      .parse(request.body);
    return { data: await uni.actOnReport(ctx(request), id, action, note) };
  });
}
