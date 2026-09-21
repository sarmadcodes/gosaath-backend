import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate, requireUser } from "../../middleware/authenticate.js";
import { requireAdminContext, requireSuperAdmin } from "../../middleware/admin.js";
import * as sup from "./super.service.js";

/**
 * The Super Admin API, and the two invitation routes that sit outside it.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Not a valid id");
const idParam = z.object({ id: objectId });
const password = z.string().min(1).max(200);

const ctx = (request: FastifyRequest) => ({ admin: requireAdminContext(request), request });

export async function superAdminRoutes(app: FastifyInstance): Promise<void> {
  app.register(async (platform) => {
    platform.addHook("preHandler", requireSuperAdmin);

    platform.get("/admin/platform/overview", async () => ({
      data: await sup.platformOverview(),
    }));

    // --- Institutions -------------------------------------------------------

    platform.get("/admin/institutions", async (request) => {
      const filters = z
        .object({
          status: z.enum(["active", "inactive"]).optional(),
          q: z.string().trim().max(120).optional(),
        })
        .strict()
        .parse(request.query);
      return { data: await sup.listInstitutions(filters) };
    });

    platform.get("/admin/institutions/:id", async (request) => {
      const { id } = idParam.parse(request.params);
      return { data: await sup.getInstitution(id) };
    });

    platform.post("/admin/institutions", async (request) => {
      const body = z
        .object({
          name: z.string().trim().min(2).max(200),
          shortName: z.string().trim().min(1).max(40).optional(),
          type: z.enum(["university", "college", "school", "organisation"]),
          city: z.string().trim().min(2).max(80),
          emailDomains: z
            .array(z.string().trim().toLowerCase().regex(/^@?[a-z0-9.-]+\.[a-z]{2,}$/, "Not a domain"))
            .min(1)
            .max(10),
          brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #0C4DA1"),
          // `active` is deliberately absent. Institutions are created inactive,
          // and going live is its own action with its own checklist.
        })
        .strict()
        .parse(request.body);
      return { data: await sup.createInstitution(ctx(request), body) };
    });

    platform.patch("/admin/institutions/:id/checklist", async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          contacted: z.boolean().optional(),
          campusesConfirmed: z.boolean().optional(),
          emailDomainsConfirmed: z.boolean().optional(),
          brandColorConfirmed: z.boolean().optional(),
          // Derived items (logos, admin, interest) are not accepted: they are
          // read from the database, not claimed.
        })
        .strict()
        .parse(request.body);
      return { data: await sup.updateChecklist(ctx(request), id, body) };
    });

    platform.post("/admin/institutions/:id/activate", async (request) => {
      const { id } = idParam.parse(request.params);
      return { data: await sup.activateInstitution(ctx(request), id) };
    });

    platform.post("/admin/institutions/:id/deactivate", async (request) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ password, reason: z.string().trim().min(5).max(500) })
        .strict()
        .parse(request.body);
      return { data: await sup.deactivateInstitution(ctx(request), id, body.password, body.reason) };
    });

    // --- Institution requests -----------------------------------------------

    platform.get("/admin/institution-requests", async (request) => {
      const { status } = z
        .object({ status: z.enum(["pending", "approved", "rejected"]).optional() })
        .strict()
        .parse(request.query);
      return { data: await sup.listInstitutionRequests(status) };
    });

    platform.post("/admin/institution-requests/decision", async (request) => {
      const body = z
        .object({ name: z.string().trim().min(2).max(200), approve: z.boolean() })
        .strict()
        .parse(request.body);
      return { data: await sup.decideInstitutionRequests(ctx(request), body.name, body.approve) };
    });

    // --- Administrators -----------------------------------------------------

    platform.get("/admin/admins", async () => ({ data: await sup.listAdmins() }));

    platform.post(
      "/admin/admins",
      { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
      async (request) => {
        const body = z
          .object({
            email: z.string().trim().toLowerCase().email().max(254),
            institutionId: objectId,
            role: z.enum(["universityAdmin", "superAdmin"]),
          })
          .strict()
          .parse(request.body);
        return { data: await sup.inviteAdmin(ctx(request), body) };
      },
    );

    platform.delete("/admin/invitations/:id", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await sup.revokeInvitation(ctx(request), id);
      return reply.code(204).send();
    });

    platform.post("/admin/admins/:id/remove", async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ password }).strict().parse(request.body);
      await sup.removeAdmin(ctx(request), id, body.password);
      return reply.code(204).send();
    });
  });

  // --- Accepting an invitation ----------------------------------------------
  //
  // Outside the super-admin guard: the person accepting is, by definition, not
  // an admin yet.

  app.post(
    "/admin/invitations/accept",
    { preHandler: authenticate, config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { token } = z.object({ token: z.string().min(20).max(200) }).strict().parse(request.body);
      return { data: await sup.acceptInvitation(requireUser(request).id, token) };
    },
  );

  app.post(
    "/auth/register-invited",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = z
        .object({
          token: z.string().min(20).max(200),
          name: z.string().trim().min(2).max(120),
          password: z.string().min(12, "Use at least 12 characters").max(200),
          phone: z
            .string()
            .trim()
            .regex(/^(\+?92|0)?[\s-]?3\d{2}[\s-]?\d{7}$/, "Enter a valid mobile number"),
          campusId: objectId,
          areaId: objectId,
          userType: z.enum(["student", "teacher"]),
        })
        .strict()
        .parse(request.body);

      const userAgent = request.headers["user-agent"];
      return {
        data: await sup.registerFromInvitation(body, {
          userAgent: typeof userAgent === "string" ? userAgent.slice(0, 300) : undefined,
          ip: request.ip,
        }),
      };
    },
  );
}
