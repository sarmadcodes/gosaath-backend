import { logger } from "../../utils/logger.js";
import type { EmailMessage, EmailProvider, EmailResult } from "./email.types.js";

/**
 * Development provider: writes the message to the log instead of sending it.
 *
 * This is what makes the whole OTP flow exercisable with no provider account
 * and no real inbox — and it is rejected outside development by config
 * validation, because a production deployment that silently swallows every
 * verification email is indistinguishable from one where nobody can sign up.
 *
 * The code is printed deliberately. It is a development-only convenience and
 * the reason the flow is testable at all; the same value reaching a production
 * log would be a credential leak, which is precisely why this provider cannot
 * run there.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console" as const;

  async send(message: EmailMessage): Promise<EmailResult> {
    const divider = "─".repeat(60);
    logger.info(
      { provider: "console", to: message.to, tag: message.tag },
      "email (not sent — console provider)",
    );
    // Written straight out rather than through the logger: pino's redaction
    // would strip the code, and a development inbox that prints "[redacted]"
    // helps nobody.
    process.stdout.write(
      [
        "",
        divider,
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        divider,
        message.text.replace(/^/gm, "  "),
        divider,
        "",
      ].join("\n"),
    );
    return { id: null, provider: "console" };
  }
}
