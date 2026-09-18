import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import { ConsoleEmailProvider } from "./console.provider.js";
import { createResendProvider } from "./resend.provider.js";
import {
  badgeDecisionEmail,
  passwordResetEmail,
  verificationCodeEmail,
} from "./templates.js";
import type { EmailProvider, EmailResult, EmailService } from "./email.types.js";

export type { EmailProvider, EmailResult, EmailService } from "./email.types.js";

/**
 * Binds templates to whichever provider is configured.
 *
 * Domain code depends on this, never on a provider. That is what keeps an API
 * key out of every service that happens to need to send something, and what
 * makes changing provider a single edit here.
 */
class TemplatedEmailService implements EmailService {
  constructor(private readonly provider: EmailProvider) {}

  async sendVerificationCode(input: {
    to: string;
    name: string;
    code: string;
    expiresInMinutes: number;
  }): Promise<EmailResult> {
    return this.provider.send({
      to: input.to,
      ...verificationCodeEmail(input),
    });
  }

  async sendPasswordReset(input: {
    to: string;
    name: string;
    code: string;
    expiresInMinutes: number;
  }): Promise<EmailResult> {
    return this.provider.send({
      to: input.to,
      ...passwordResetEmail(input),
    });
  }

  async sendBadgeDecision(input: {
    to: string;
    name: string;
    approved: boolean;
    reason?: string;
  }): Promise<EmailResult> {
    return this.provider.send({
      to: input.to,
      ...badgeDecisionEmail(input),
    });
  }
}

let instance: EmailService | null = null;

export function createEmailProvider(): EmailProvider {
  return env.EMAIL_PROVIDER === "resend"
    ? createResendProvider()
    : new ConsoleEmailProvider();
}

/**
 * The process-wide service.
 *
 * Built once and reused: there is no per-request state, and constructing it
 * per call would re-read config on every send.
 */
export function emailService(): EmailService {
  if (!instance) {
    const provider = createEmailProvider();
    logger.info({ provider: provider.name }, "email service ready");
    instance = new TemplatedEmailService(provider);
  }
  return instance;
}

/** Lets a test substitute a provider without touching the environment. */
export function createEmailService(provider: EmailProvider): EmailService {
  return new TemplatedEmailService(provider);
}
