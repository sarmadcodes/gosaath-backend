import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app/app.js";
import { connectToDatabase, disconnectFromDatabase } from "../../src/db/mongodb.js";
import {
  AreaModel,
  AuditLogModel,
  CampusModel,
  InstitutionModel,
  OtpChallengeModel,
  UserModel,
} from "../../src/db/models/index.js";
import { setEmailProvider } from "../../src/services/email/index.js";
import type {
  EmailMessage,
  EmailProvider,
  EmailResult,
} from "../../src/services/email/email.types.js";

/**
 * Administrator sign-in, by emailed code.
 *
 * This is the front door to an account that can read every member of an
 * institution, so most of this file is about what the endpoint refuses to say.
 * An attacker's first job is finding out which three addresses are worth
 * phishing, and an endpoint that answers differently for an administrator than
 * for a stranger hands them that list.
 */

let app: FastifyInstance;
let institutionId: string;
let campusId: string;
let areaId: string;

/** Captures what would have been sent, so the code can be read back. */
class CapturingEmail implements EmailProvider {
  readonly name = "console" as const;
  sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return { id: `test-${this.sent.length}`, provider: this.name };
  }

  /**
   * Only the sign-in codes.
   *
   * Registering a user sends a verification email too, so counting everything
   * this provider captured would count that one as well.
   */
  signInCodesTo(email: string): EmailMessage[] {
    return this.sent.filter(
      (entry) => entry.to === email && entry.tag === "admin-signin",
    );
  }

  /** The six-digit code from the most recent sign-in email to this address. */
  codeFor(email: string): string {
    const message = [...this.signInCodesTo(email)].reverse()[0];
    if (!message) throw new Error(`no sign-in code sent to ${email}`);
    const match = /\b(\d{6})\b/.exec(message.text ?? "");
    if (!match) throw new Error(`no code in the email to ${email}`);
    return match[1]!;
  }
}

let mail: CapturingEmail;

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/api/v1${url}`, payload });

async function makeUser(
  email: string,
  role: "member" | "universityAdmin" | "superAdmin",
): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      name: `${email.split("@")[0]} Person`,
      email,
      password: "a-long-enough-passphrase",
      phone: "0300 1234567",
      userType: "student",
      institutionId,
      campusId,
      areaId,
    },
  });
  await UserModel.updateOne(
    { email },
    { $set: { emailVerifiedAt: new Date(), ...(role === "member" ? {} : { role }) } },
  );
  const user = await UserModel.findOne({ email });
  return user!._id.toString();
}

beforeAll(async () => {
  await connectToDatabase();
  app = await buildApp({ rateLimit: false });
  await app.ready();

  institutionId = (await InstitutionModel.findOne({ name: "SZABIST University" }))!._id.toString();
  campusId = (await CampusModel.findOne({ name: "Clifton Campus" }))!._id.toString();
  areaId = (await AreaModel.findOne({ name: "Gulshan-e-Iqbal" }))!._id.toString();
}, 60_000);

afterAll(async () => {
  setEmailProvider(null);
  await app.close();
  await disconnectFromDatabase();
});

beforeEach(async () => {
  mail = new CapturingEmail();
  setEmailProvider(mail);
  await OtpChallengeModel.deleteMany({ purpose: "adminSignIn" });
});

describe("asking for a code", () => {
  it("sends one to an administrator", async () => {
    const email = `aa-admin-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");

    const response = await post("/admin/auth/code", { email });

    expect(response.statusCode).toBe(202);
    expect(mail.signInCodesTo(email)).toHaveLength(1);
    expect(mail.codeFor(email)).toMatch(/^\d{6}$/);
  });

  it("answers an ordinary member identically, and sends nothing", async () => {
    const email = `aa-member-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "member");

    const response = await post("/admin/auth/code", { email });

    // Same status, same body. A member must not be able to discover that they
    // are not an administrator by the shape of this answer.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ data: { sent: true, expiresInMinutes: 10 } });
    expect(mail.signInCodesTo(email)).toHaveLength(0);
  });

  it("answers an address that has never existed identically", async () => {
    const response = await post("/admin/auth/code", {
      email: `aa-nobody-${Date.now()}@szabist.edu.pk`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ data: { sent: true, expiresInMinutes: 10 } });
    expect(mail.sent.filter((entry) => entry.tag === "admin-signin")).toHaveLength(0);
  });

  it("answers a suspended administrator identically, and sends nothing", async () => {
    const email = `aa-suspended-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await UserModel.updateOne({ email }, { $set: { suspendedAt: new Date() } });

    const response = await post("/admin/auth/code", { email });

    expect(response.statusCode).toBe(202);
    expect(mail.signInCodesTo(email)).toHaveLength(0);
  });

  it("stays silent inside the resend cooldown rather than rate-limiting visibly", async () => {
    const email = `aa-cooldown-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");

    const first = await post("/admin/auth/code", { email });
    const second = await post("/admin/auth/code", { email });

    // A 429 here for an admin, while a stranger gets 202, would be an oracle
    // for "this address is an administrator". Both answer the same.
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(mail.signInCodesTo(email)).toHaveLength(1);
  });

  it("never puts the code in the response", async () => {
    const email = `aa-nocode-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");

    const response = await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);

    expect(response.body).not.toContain(code);
  });

  it("stores the code hashed, never in plain text", async () => {
    const email = `aa-hash-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });

    const code = mail.codeFor(email);
    const challenge = await OtpChallengeModel.findOne({
      email,
      purpose: "adminSignIn",
    }).select("+codeHash");

    expect(challenge).not.toBeNull();
    expect(challenge!.codeHash).not.toContain(code);
    expect(challenge!.codeHash.startsWith("$argon2")).toBe(true);
  });
});

describe("spending a code", () => {
  it("issues a session to an administrator with the right code", async () => {
    const email = `aa-ok-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });

    const response = await post("/admin/auth/verify", {
      email,
      code: mail.codeFor(email),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.role).toBe("universityAdmin");
    expect(typeof response.json().data.token).toBe("string");
  });

  it("gives a session that actually opens the admin console", async () => {
    const email = `aa-console-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });

    const { token } = (
      await post("/admin/auth/verify", { email, code: mail.codeFor(email) })
    ).json().data;

    // The refresh token is the whole session, so it has to work with the
    // ordinary access-token path rather than a special one for admins.
    const refreshed = await post("/auth/refresh", { token });
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/admin/me",
      headers: { authorization: `Bearer ${refreshed.json().data.accessToken}` },
    });

    expect(me.statusCode).toBe(200);
    expect(me.json().data.role).toBe("universityAdmin");
    expect(me.json().data.scope.kind).toBe("institution");
  });

  it("refuses a wrong code", async () => {
    const email = `aa-wrong-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });

    const response = await post("/admin/auth/verify", { email, code: "000000" });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain("token");
  });

  it("lets a code be spent only once", async () => {
    const email = `aa-once-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);

    const first = await post("/admin/auth/verify", { email, code });
    const second = await post("/admin/auth/verify", { email, code });

    expect(first.statusCode).toBe(200);
    // A replayed code is a code somebody else has read, out of an inbox or a
    // shoulder. It must be worth nothing the second time.
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("burns the challenge after too many wrong guesses", async () => {
    const email = `aa-brute-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await post("/admin/auth/verify", { email, code: "000001" });
    }

    // Even the correct code is now worthless: the challenge is gone rather
    // than merely throttled, so waiting does not help.
    const withRealCode = await post("/admin/auth/verify", { email, code });
    expect(withRealCode.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      await OtpChallengeModel.countDocuments({ email, purpose: "adminSignIn" }),
    ).toBe(0);
  });

  it("refuses a code issued before the admin role was revoked", async () => {
    const email = `aa-revoked-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);

    // Revoked inside the ten minutes the code is alive — which is exactly when
    // revoking somebody's access matters most.
    await UserModel.updateOne({ email }, { $set: { role: "member" } });

    const response = await post("/admin/auth/verify", { email, code });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a code issued before the account was suspended", async () => {
    const email = `aa-susp2-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);

    await UserModel.updateOne({ email }, { $set: { suspendedAt: new Date() } });

    expect((await post("/admin/auth/verify", { email, code })).statusCode).toBe(401);
  });

  it("refuses a code shaped like anything other than six digits", async () => {
    const email = `aa-shape-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });

    for (const code of ["12345", "1234567", "abcdef", "", "12 34 56"]) {
      const response = await post("/admin/auth/verify", { email, code });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }

    // Refused by validation, so none of those spent an attempt: the real code
    // still works.
    const real = await post("/admin/auth/verify", { email, code: mail.codeFor(email) });
    expect(real.statusCode).toBe(200);
  });

  it("cannot be used to sign in as a member who is not an admin", async () => {
    const email = `aa-notadmin-${Date.now()}@szabist.edu.pk`;
    await makeUser(email, "member");
    await post("/admin/auth/code", { email });

    // No code was ever sent, so there is nothing to spend. Any guess fails.
    const response = await post("/admin/auth/verify", { email, code: "123456" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("the audit trail", () => {
  it("records the sign-in", async () => {
    const email = `aa-audit-${Date.now()}@szabist.edu.pk`;
    const userId = await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    await post("/admin/auth/verify", { email, code: mail.codeFor(email) });

    const entries = await AuditLogModel.find({
      actorUserId: userId,
      action: { $in: ["admin.signInRequested", "admin.signedIn"] },
    }).lean();

    expect(entries.map((entry) => entry.action).sort()).toEqual([
      "admin.signInRequested",
      "admin.signedIn",
    ]);
  });

  it("never writes the code to the audit log", async () => {
    const email = `aa-auditcode-${Date.now()}@szabist.edu.pk`;
    const userId = await makeUser(email, "universityAdmin");
    await post("/admin/auth/code", { email });
    const code = mail.codeFor(email);
    await post("/admin/auth/verify", { email, code });

    const entries = await AuditLogModel.find({ actorUserId: userId }).lean();
    expect(JSON.stringify(entries)).not.toContain(code);
  });
});
