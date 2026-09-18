import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  CampusModel,
  InstitutionModel,
  LoginAttemptModel,
  OtpChallengeModel,
  SessionModel,
  UserModel,
} from "../../src/db/models/index.js";
import { AreaModel } from "../../src/db/models/index.js";

/**
 * Phase 2 gate.
 *
 * Weighted towards the attacks rather than the happy path: enumeration,
 * brute force, privilege escalation through the request body, and token
 * reuse. The happy path is easy to get right and easy to notice when wrong.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1/auth${url}`, payload });

const validRegistration = (email: string) => ({
  name: "Ayesha Khan",
  email,
  password: "a-long-enough-passphrase",
  phone: "0300 1234567",
  userType: "student" as const,
  institutionId,
  campusId,
  areaId,
});

beforeAll(async () => {
  await connectToDatabase();
  // Rate limiting off: these cases share one IP and would exhaust the auth
  // limits within a few tests. The limits get their own file.
  app = await buildApp({ rateLimit: false });
  await app.ready();

  const institution = await InstitutionModel.findOne({ name: "SZABIST University" });
  const campus = await CampusModel.findOne({ name: "Clifton Campus" });
  const area = await AreaModel.findOne({ name: "Gulshan-e-Iqbal" });
  institutionId = institution!._id.toString();
  campusId = campus!._id.toString();
  areaId = area!._id.toString();
}, 60_000);

afterAll(async () => {
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  // Only the accounts these tests create. Seed data is left alone.
  await UserModel.deleteMany({ email: /@szabist\.edu\.pk$/ });
  await OtpChallengeModel.deleteMany({});
  await SessionModel.deleteMany({});
  await LoginAttemptModel.deleteMany({});
});

describe("register", () => {
  it("creates an unverified account and returns the pending email", async () => {
    const email = "ayesha@szabist.edu.pk";
    const response = await post("/register", validRegistration(email));

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ pendingEmail: email });

    const user = await UserModel.findOne({ email });
    expect(user).toBeTruthy();
    // Unverified until the code is entered — that is the whole point of it.
    expect(user!.emailVerifiedAt).toBeNull();
  });

  it("rejects an email outside the institution's domains", async () => {
    const response = await post("/register", {
      ...validRegistration("ayesha@gmail.com"),
    });
    expect(response.statusCode).toBe(400);
    expect(await UserModel.countDocuments({ email: "ayesha@gmail.com" })).toBe(0);
  });

  it("rejects a campus belonging to a different institution", async () => {
    // Checked against the institution rather than on its own: otherwise an
    // account lands in the wrong community and is matched with the wrong people.
    const foreign = await CampusModel.create({
      institutionId: new AreaModel()._id,
      name: `Foreign Campus ${Date.now()}`,
    });
    try {
      const response = await post("/register", {
        ...validRegistration("ayesha@szabist.edu.pk"),
        campusId: foreign._id.toString(),
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await foreign.deleteOne();
    }
  });

  it("refuses to register into an inactive institution", async () => {
    const inactive = await InstitutionModel.create({
      name: `Inactive ${Date.now()}`,
      type: "university",
      city: "Karachi",
      brandColor: "#123456",
      emailDomains: ["inactive.edu.pk"],
      active: false,
    });
    try {
      const response = await post("/register", {
        ...validRegistration("someone@inactive.edu.pk"),
        institutionId: inactive._id.toString(),
      });
      expect(response.statusCode).toBe(422);
    } finally {
      await inactive.deleteOne();
    }
  });

  it("does not accept employee accounts yet", async () => {
    const response = await post("/register", {
      ...validRegistration("ayesha@szabist.edu.pk"),
      userType: "employee",
    });
    // Rejected by the schema before it reaches the service.
    expect(response.statusCode).toBe(400);
  });

  it("cannot be used to grant a role", async () => {
    const email = "escalate@szabist.edu.pk";
    const response = await post("/register", {
      ...validRegistration(email),
      role: "superAdmin",
    });

    // Strict schema: an unknown key is a rejection, not something ignored.
    expect(response.statusCode).toBe(400);
    expect(await UserModel.countDocuments({ email })).toBe(0);
  });

  it("does not reveal that an address already has an account", async () => {
    const email = "taken@szabist.edu.pk";
    await post("/register", validRegistration(email));
    const user = await UserModel.findOne({ email });
    user!.emailVerifiedAt = new Date();
    await user!.save();

    const second = await post("/register", validRegistration(email));

    // Identical to a fresh signup. Any difference turns the form into a tool
    // for discovering which addresses hold accounts.
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual({ pendingEmail: email });
  });

  it("does not overwrite a verified account's password", async () => {
    const email = "victim@szabist.edu.pk";
    await post("/register", validRegistration(email));
    const before = await UserModel.findOne({ email }).select("+passwordHash");
    before!.emailVerifiedAt = new Date();
    await before!.save();

    await post("/register", {
      ...validRegistration(email),
      password: "attacker-chosen-passphrase",
    });

    const after = await UserModel.findOne({ email }).select("+passwordHash");
    // Otherwise registration would be a password-reset endpoint with no proof
    // of ownership whatsoever.
    expect(after!.passwordHash).toBe(before!.passwordHash);
  });

  it("rejects a short password", async () => {
    const response = await post("/register", {
      ...validRegistration("short@szabist.edu.pk"),
      password: "short",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("verify", () => {
  const email = "verify@szabist.edu.pk";

  async function registerAndSetCode(code: string) {
    await post("/register", validRegistration(email));
    const { hashOtp } = await import("../../src/utils/crypto.js");
    await OtpChallengeModel.updateOne(
      { email, purpose: "verifyEmail" },
      { $set: { codeHash: await hashOtp(code), attempts: 0 } },
    );
  }

  it("verifies with the right code and returns a session", async () => {
    await registerAndSetCode("123456");
    const response = await post("/verify-otp", { email, code: "123456" });

    expect(response.statusCode).toBe(200);
    const session = response.json().data;
    expect(typeof session.token).toBe("string");
    expect(session.user.email).toBe(email);

    const user = await UserModel.findOne({ email });
    expect(user!.emailVerifiedAt).not.toBeNull();
  });

  it("never returns the password hash in the session user", async () => {
    await registerAndSetCode("123456");
    const response = await post("/verify-otp", { email, code: "123456" });

    const raw = response.body;
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("$argon2");
  });

  it("rejects a wrong code without saying why", async () => {
    await registerAndSetCode("123456");
    const response = await post("/verify-otp", { email, code: "999999" });

    expect(response.statusCode).toBe(400);
    const message = response.json().error.message.toLowerCase();
    // "wrong" and "expired" must look the same, or an attacker learns whether
    // to keep guessing.
    expect(message).toContain("not right, or it has expired");
  });

  it("burns the challenge after too many wrong guesses", async () => {
    await registerAndSetCode("123456");

    for (let i = 0; i < 5; i++) {
      await post("/verify-otp", { email, code: "000000" });
    }

    // Deleted rather than throttled: throttling lets an attacker simply wait.
    expect(
      await OtpChallengeModel.countDocuments({ email, purpose: "verifyEmail" }),
    ).toBe(0);

    // Even the correct code is now useless.
    const response = await post("/verify-otp", { email, code: "123456" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("consumes the code so it cannot be replayed", async () => {
    await registerAndSetCode("123456");
    await post("/verify-otp", { email, code: "123456" });

    const replay = await post("/verify-otp", { email, code: "123456" });
    expect(replay.statusCode).toBe(400);
  });

  it("rejects an expired code", async () => {
    await registerAndSetCode("123456");
    await OtpChallengeModel.updateOne(
      { email, purpose: "verifyEmail" },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const response = await post("/verify-otp", { email, code: "123456" });
    expect(response.statusCode).toBe(400);
  });
});

describe("login", () => {
  const email = "login@szabist.edu.pk";
  const password = "a-long-enough-passphrase";

  async function verifiedAccount() {
    await post("/register", validRegistration(email));
    await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
  }

  it("signs in a verified account", async () => {
    await verifiedAccount();
    const response = await post("/login", { email, password });

    expect(response.statusCode).toBe(200);
    expect(typeof response.json().data.token).toBe("string");
  });

  it("gives the same error for a wrong password and an unknown account", async () => {
    await verifiedAccount();

    const wrongPassword = await post("/login", { email, password: "not-the-password" });
    const unknown = await post("/login", {
      email: "nobody@szabist.edu.pk",
      password,
    });

    expect(wrongPassword.statusCode).toBe(unknown.statusCode);
    expect(wrongPassword.json().error.message).toBe(unknown.json().error.message);
  });

  it("refuses an unverified account with the same message", async () => {
    await post("/register", validRegistration(email));
    const response = await post("/login", { email, password });

    expect(response.statusCode).toBe(401);
    // Saying "verify your email first" would confirm both that the account
    // exists and that the password was right.
    expect(response.json().error.message).toBe("That email or password is not right.");
  });

  it("refuses a suspended account with the same message", async () => {
    await verifiedAccount();
    await UserModel.updateOne({ email }, { $set: { suspendedAt: new Date() } });

    const response = await post("/login", { email, password });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("That email or password is not right.");
  });

  it("locks out after repeated failures", async () => {
    await verifiedAccount();

    for (let i = 0; i < 10; i++) {
      await post("/login", { email, password: `wrong-${i}` });
    }

    // Even the correct password is refused while locked.
    const response = await post("/login", { email, password });
    expect(response.statusCode).toBe(429);
  });

  it("clears the failure count on a successful sign-in", async () => {
    await verifiedAccount();
    await post("/login", { email, password: "wrong" });
    await post("/login", { email, password });

    expect(await LoginAttemptModel.countDocuments({ key: email })).toBe(0);
  });
});

describe("sessions", () => {
  const email = "session@szabist.edu.pk";
  const password = "a-long-enough-passphrase";

  async function signIn(): Promise<string> {
    await post("/register", validRegistration(email));
    await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
    const response = await post("/login", { email, password });
    return response.json().data.token as string;
  }

  it("restores a live session", async () => {
    const token = await signIn();
    const response = await post("/restore", { token });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.user.email).toBe(email);
  });

  it("returns null rather than an error once signed out", async () => {
    const token = await signIn();
    await post("/logout", { token });

    const response = await post("/restore", { token });
    // To the app this is simply "signed out". An error would surface as a
    // failure screen on an entirely ordinary expiry.
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toBeNull();
  });

  it("exchanges a refresh token for a short-lived access token", async () => {
    const token = await signIn();
    const response = await post("/refresh", { token });

    expect(response.statusCode).toBe(200);
    expect(typeof response.json().data.accessToken).toBe("string");
    // Three segments: a real JWT, not an opaque string.
    expect(response.json().data.accessToken.split(".")).toHaveLength(3);
  });

  it("logging out is idempotent", async () => {
    const token = await signIn();
    expect((await post("/logout", { token })).statusCode).toBe(204);
    expect((await post("/logout", { token })).statusCode).toBe(204);
  });

  it("revokes every session when the password is reset", async () => {
    const token = await signIn();
    const { hashOtp } = await import("../../src/utils/crypto.js");

    await post("/password-reset/request", { email });
    await OtpChallengeModel.updateOne(
      { email, purpose: "passwordReset" },
      { $set: { codeHash: await hashOtp("654321"), attempts: 0 } },
    );

    const reset = await post("/password-reset", {
      email,
      code: "654321",
      password: "a-completely-new-passphrase",
    });
    expect(reset.statusCode).toBe(204);

    // If the reset happened because the account was compromised, leaving the
    // attacker signed in elsewhere would defeat the point of it.
    const restored = await post("/restore", { token });
    expect(restored.json().data).toBeNull();
  });
});

describe("password reset", () => {
  it("responds the same for a real and an unknown address", async () => {
    const real = "reset@szabist.edu.pk";
    await post("/register", validRegistration(real));
    await UserModel.updateOne({ email: real }, { $set: { emailVerifiedAt: new Date() } });

    const known = await post("/password-reset/request", { email: real });
    const unknown = await post("/password-reset/request", {
      email: "nobody-at-all@szabist.edu.pk",
    });

    expect(known.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(known.body).toBe(unknown.body);
  });
});

describe("token security", () => {
  it("rejects a forged access token", async () => {
    const { verifyAccessToken } = await import(
      "../../src/modules/auth/token.service.js"
    );
    // Signed with the right shape but the wrong secret.
    const forged =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdHRhY2tlciIsInNpZCI6IngiLCJ0eXAiOiJhY2Nlc3MifQ." +
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  it("stores refresh tokens hashed, never in the clear", async () => {
    const email = "hashed@szabist.edu.pk";
    await post("/register", validRegistration(email));
    await UserModel.updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
    const token = (await post("/login", { email, password: "a-long-enough-passphrase" }))
      .json().data.token as string;

    const session = await SessionModel.findOne({});
    expect(session).toBeTruthy();
    // A database leak must not hand over usable sessions.
    expect(session!.refreshTokenHash).not.toBe(token);
    expect(session!.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
