/**
 * What the rest of the backend is allowed to know about email.
 *
 * Business logic asks for "send a verification code", never "POST to Resend".
 * Swapping provider is then one file, and — more importantly — no domain
 * service ends up holding an API key or knowing a provider's error shape.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  /** Both parts always. A text-only client showing raw HTML looks broken. */
  html: string;
  text: string;
  /** Groups deliveries in the provider dashboard. Never user content. */
  tag?: string;
};

export type EmailResult = {
  /** Provider's id, for tracing a complaint back to a delivery. */
  id: string | null;
  provider: "resend" | "console";
};

export interface EmailProvider {
  readonly name: "resend" | "console";
  send(message: EmailMessage): Promise<EmailResult>;
}

/**
 * The interface domain code depends on.
 *
 * Deliberately not a generic `send(html)`: every message the product sends is
 * enumerated here. That keeps templates in one place and makes it impossible
 * for a route to compose arbitrary email out of user input.
 */
export interface EmailService {
  sendVerificationCode(input: {
    to: string;
    name: string;
    code: string;
    /** Minutes until the code expires, so the copy stays truthful. */
    expiresInMinutes: number;
  }): Promise<EmailResult>;

  sendPasswordReset(input: {
    to: string;
    name: string;
    code: string;
    expiresInMinutes: number;
  }): Promise<EmailResult>;

  sendBadgeDecision(input: {
    to: string;
    name: string;
    approved: boolean;
    reason?: string;
  }): Promise<EmailResult>;
}
