import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Types } from "mongoose";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import { SessionModel, UserModel } from "../../src/db/models/index.js";
import {
  createSession,
  rotateSession,
} from "../../src/modules/auth/token.service.js";

/**
 * The protections the main auth suite has to switch off to run at all.
 *
 * Kept in their own file with rate limiting left ON, so turning it off there
 * cannot quietly mean nobody checks it.
 */

let app: FastifyInstance;

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: true });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disconnectFromDatabase();
});

describe("rate limits", () => {
  it("throttles repeated sign-in attempts from one address", async () => {
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "flood@szabist.edu.pk", password: "wrong-password" },
        // A distinct IP per test, since the limiter keys on it and the suite
        // would otherwise leak state between cases.
        remoteAddress: "203.0.113.10",
      });

    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      codes.push((await attempt()).statusCode);
    }

    // The limit is 10 in 5 minutes; everything past it is refused before the
    // password is ever checked, which is what keeps guessing expensive.
    expect(codes).toContain(429);
    expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0);
  });

  it("throttles registration, which sends email", async () => {
    // Without a limit this route is a free mail cannon aimed at any address.
    const attempt = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email: "not-even-valid" },
        remoteAddress: "203.0.113.11",
      });

    const codes: number[] = [];
    for (let i = 0; i < 9; i++) {
      codes.push((await attempt()).statusCode);
    }

    expect(codes).toContain(429);
  });

  it("never throttles health probes", async () => {
    // A rate-limited readiness probe reads as an outage and removes the
    // instance from the load balancer.
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        app.inject({
          method: "GET",
          url: "/health/live",
          remoteAddress: "203.0.113.12",
        }),
      ),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
  });
});

describe("refresh token rotation", () => {
  let userId: Types.ObjectId;

  beforeAll(async () => {
    const user = await UserModel.create({
      name: "Rotation Test",
      email: `rotation-${Date.now()}@szabist.edu.pk`,
      passwordHash: "x",
      phone: "0300 1111111",
      userType: "student",
      institutionId: new Types.ObjectId(),
      campusId: new Types.ObjectId(),
      areaId: new Types.ObjectId(),
      emailVerifiedAt: new Date(),
    });
    userId = user._id;
  });

  it("issues a new token and retires the old one", async () => {
    const first = await createSession({ userId });
    const { issued: second } = await rotateSession({
      refreshToken: first.refreshToken,
    });

    expect(second.refreshToken).not.toBe(first.refreshToken);

    const oldSession = await SessionModel.findById(first.sessionId);
    expect(oldSession!.revokedAt).not.toBeNull();
    expect(oldSession!.revokedReason).toBe("rotated");
    expect(oldSession!.replacedBySessionId?.toString()).toBe(second.sessionId);
  });

  it("revokes the whole chain when a retired token is presented again", async () => {
    const first = await createSession({ userId });
    const { issued: second } = await rotateSession({
      refreshToken: first.refreshToken,
    });

    // Replaying the old token means it was captured — the legitimate device
    // would be holding the newer one.
    await expect(
      rotateSession({ refreshToken: first.refreshToken }),
    ).rejects.toThrow();

    // We cannot tell the thief from the victim, so both are signed out.
    // Leaving it would hand the attacker a working session indefinitely.
    const live = await SessionModel.findById(second.sessionId);
    expect(live!.revokedAt).not.toBeNull();
    expect(live!.revokedReason).toBe("reuseDetected");
  });

  it("refuses an expired refresh token", async () => {
    const session = await createSession({ userId });
    await SessionModel.updateOne(
      { _id: session.sessionId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    await expect(
      rotateSession({ refreshToken: session.refreshToken }),
    ).rejects.toThrow();
  });

  it("refuses a token that was never issued", async () => {
    await expect(
      rotateSession({ refreshToken: "completely-made-up-token-value-here" }),
    ).rejects.toThrow();
  });
});
