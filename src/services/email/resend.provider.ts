import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { DependencyError } from "../../utils/errors.js";
import type { EmailMessage, EmailProvider, EmailResult } from "./email.types.js";

/**
 * Resend, over plain fetch.
 *
 * No SDK on purpose. Sending is a single authenticated POST, and the official
 * client does not expose a per-request timeout — which is the one control that
 * actually matters here, because a hung provider would otherwise hold a
 * registration request open until the server's own 20s ceiling.
 *
 * AbortController gives an exact bound, and dropping the dependency removes a
 * package that would sit in the path of every account created.
 */

const ENDPOINT = "https://api.resend.com/emails";

/** Retried: transient by definition. Anything else is a bug or a bad key. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

type ResendResponse = { id?: string; message?: string; name?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly replyTo: string | undefined,
    private readonly timeoutMs: number,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            // Resend deduplicates on this, so a retry after a timeout cannot
            // deliver the message twice. Without it, a response lost on the
            // wire means the user receives two codes and the second one wins.
            "Idempotency-Key": idempotencyKey(message),
          },
          body: JSON.stringify({
            from: this.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(this.replyTo ? { reply_to: this.replyTo } : {}),
            ...(message.tag ? { tags: [{ name: "type", value: message.tag }] } : {}),
          }),
          signal: controller.signal,
        });

        const body = (await response.json().catch(() => ({}))) as ResendResponse;

        if (response.ok) {
          logger.info(
            { provider: "resend", tag: message.tag, messageId: body.id, attempt },
            "email sent",
          );
          return { id: body.id ?? null, provider: "resend" };
        }

        lastStatus = response.status;

        // 4xx other than 408/429 will fail identically on every retry: a bad
        // key, an unverified sender, a malformed address. Retrying wastes the
        // user's time and buries the real cause.
        if (!RETRYABLE_STATUSES.has(response.status)) {
          logger.error(
            {
              provider: "resend",
              status: response.status,
              // The provider's own message, never the recipient or the body.
              providerMessage: body.message ?? body.name,
              tag: message.tag,
            },
            "email rejected",
          );
          throw new DependencyError("We could not send that email.");
        }

        logger.warn(
          { provider: "resend", status: response.status, attempt, tag: message.tag },
          "email send failed, retrying",
        );
      } catch (error) {
        if (error instanceof DependencyError) throw error;

        const aborted = error instanceof Error && error.name === "AbortError";
        logger.warn(
          { provider: "resend", attempt, aborted, err: error, tag: message.tag },
          aborted ? "email send timed out" : "email send errored",
        );
      } finally {
        clearTimeout(timer);
      }

      // Back off before trying again, but never on the final attempt — that
      // would just delay the error the caller is already waiting for.
      if (attempt < MAX_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
    }

    logger.error(
      { provider: "resend", lastStatus, tag: message.tag },
      "email send exhausted retries",
    );
    throw new DependencyError("We could not send that email. Try again shortly.");
  }
}

/**
 * Stable across retries of the same message, different across sends.
 *
 * Derived from the recipient and the body so a genuinely new code is a new
 * key, while a retry of the same payload is deduplicated by the provider.
 */
function idempotencyKey(message: EmailMessage): string {
  let hash = 0;
  const source = `${message.to}:${message.subject}:${message.text}`;
  for (let i = 0; i < source.length; i++) {
    hash = (hash * 31 + source.charCodeAt(i)) | 0;
  }
  return `gosaath-${Math.abs(hash).toString(36)}`;
}

export function createResendProvider(): ResendEmailProvider {
  // Validated at boot, so this is unreachable in a running process.
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY missing");
  }
  return new ResendEmailProvider(
    env.RESEND_API_KEY,
    env.EMAIL_FROM,
    env.EMAIL_REPLY_TO,
    env.EMAIL_TIMEOUT_MS,
  );
}
