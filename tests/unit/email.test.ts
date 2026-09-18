import { afterEach, describe, expect, it, vi } from "vitest";
import {
  badgeDecisionEmail,
  passwordResetEmail,
  verificationCodeEmail,
} from "../../src/services/email/templates.js";
import { createEmailService } from "../../src/services/email/index.js";
import { ResendEmailProvider } from "../../src/services/email/resend.provider.js";
import { DependencyError } from "../../src/utils/errors.js";
import type {
  EmailMessage,
  EmailProvider,
  EmailResult,
} from "../../src/services/email/email.types.js";

class RecordingProvider implements EmailProvider {
  readonly name = "console" as const;
  sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return { id: "rec_1", provider: "console" };
  }
}

describe("templates", () => {
  const code = "482913";

  it("keeps the code out of the subject line", () => {
    // Subjects render on a lock screen. A code readable without unlocking the
    // phone defeats the point of sending one.
    for (const message of [
      verificationCodeEmail({ name: "Ayesha Khan", code, expiresInMinutes: 10 }),
      passwordResetEmail({ name: "Ayesha Khan", code, expiresInMinutes: 10 }),
    ]) {
      expect(message.subject).not.toContain(code);
    }
  });

  it("puts the code in both the html and the text part", () => {
    const message = verificationCodeEmail({
      name: "Ayesha",
      code,
      expiresInMinutes: 10,
    });
    expect(message.html).toContain(code);
    expect(message.text).toContain(code);
  });

  it("addresses people by first name only", () => {
    const message = verificationCodeEmail({
      name: "Ayesha Khan",
      code,
      expiresInMinutes: 10,
    });
    expect(message.text).toContain("Hi Ayesha,");
    // Matching the rest of the product: full names are not used.
    expect(message.text).not.toContain("Khan");
  });

  it("falls back gracefully on an empty name", () => {
    const message = verificationCodeEmail({ name: "   ", code, expiresInMinutes: 10 });
    expect(message.text).toContain("Hi there,");
  });

  it("escapes a name so it cannot inject markup", () => {
    const message = verificationCodeEmail({
      name: '<script>alert(1)</script>',
      code,
      expiresInMinutes: 10,
    });
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain("&lt;script&gt;");
  });

  it("escapes an admin-written rejection reason", () => {
    const message = badgeDecisionEmail({
      name: "Ayesha",
      approved: false,
      reason: '<img src=x onerror="steal()">',
    });
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
  });

  it("states the real expiry so the copy cannot go stale", () => {
    const message = passwordResetEmail({ name: "A", code, expiresInMinutes: 7 });
    expect(message.text).toContain("7 minutes");
  });

  it("tells a password-reset recipient nothing has changed", () => {
    // The person who did NOT request this is the one who most needs reassuring.
    const message = passwordResetEmail({ name: "A", code, expiresInMinutes: 10 });
    expect(message.text.toLowerCase()).toContain("your password has not changed");
  });

  it("does not claim an account exists before the code is entered", () => {
    const message = verificationCodeEmail({ name: "A", code, expiresInMinutes: 10 });
    expect(message.text.toLowerCase()).toContain("no account is created");
  });
});

describe("EmailService", () => {
  it("routes each message type through the provider", async () => {
    const provider = new RecordingProvider();
    const service = createEmailService(provider);

    await service.sendVerificationCode({
      to: "a@szabist.edu.pk",
      name: "Ayesha",
      code: "111111",
      expiresInMinutes: 10,
    });
    await service.sendPasswordReset({
      to: "a@szabist.edu.pk",
      name: "Ayesha",
      code: "222222",
      expiresInMinutes: 10,
    });
    await service.sendBadgeDecision({
      to: "a@szabist.edu.pk",
      name: "Ayesha",
      approved: true,
    });

    expect(provider.sent.map((m) => m.tag)).toEqual([
      "verification",
      "password-reset",
      "badge",
    ]);
    expect(provider.sent.every((m) => m.to === "a@szabist.edu.pk")).toBe(true);
    // Both parts, always: a text-only client rendering raw HTML looks broken.
    expect(provider.sent.every((m) => m.html.length > 0 && m.text.length > 0)).toBe(true);
  });
});

describe("ResendEmailProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const message: EmailMessage = {
    to: "a@szabist.edu.pk",
    subject: "Confirm your GoSaath account",
    html: "<p>hi</p>",
    text: "hi",
    tag: "verification",
  };

  const provider = () =>
    new ResendEmailProvider("re_test_key", "GoSaath <no-reply@test>", undefined, 500);

  it("returns the provider message id on success", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().send(message);
    expect(result).toEqual({ id: "msg_123", provider: "resend" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends an idempotency key so a retry cannot deliver twice", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider().send(message);

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Idempotency-Key"]).toMatch(/^gosaath-/);
  });

  it("does NOT retry a bad API key", async () => {
    // 401 fails identically every time. Retrying wastes the user's time and
    // buries the real cause.
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().send(message)).rejects.toBeInstanceOf(DependencyError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and succeeds", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return call === 1
        ? new Response("{}", { status: 429 })
        : new Response(JSON.stringify({ id: "msg_after_retry" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await provider().send(message);
    expect(result.id).toBe("msg_after_retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts and raises a dependency error", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().send(message)).rejects.toBeInstanceOf(DependencyError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts a hung request rather than holding the caller open", async () => {
    // Without the timeout, a stalled provider would hold a registration
    // request open until the server's own 20s ceiling.
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().send(message)).rejects.toBeInstanceOf(DependencyError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it("never puts the recipient or the body in an error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "Invalid API key" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await provider()
      .send(message)
      .catch((error: Error) => {
        expect(error.message).not.toContain("szabist");
        expect(error.message).not.toContain("re_test_key");
      });
  });
});
