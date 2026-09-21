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

  /**
   * Sent when somebody tries to register an address that already has a
   * verified account.
   *
   * The registration response is deliberately identical to a fresh signup, so
   * the form cannot be used to discover accounts. This email is what stops
   * that silence from being unhelpful — and it reaches the real owner of the
   * address rather than whoever typed it in.
   */
  sendExistingAccountNotice(input: {
    to: string;
    name: string;
  }): Promise<EmailResult>;

  /**
   * An invitation to administer an institution.
   *
   * The link carries a single-use token. Whoever holds it can claim the role,
   * which is why it only ever goes to the invited address and expires.
   */
  sendAdminInvitation(input: {
    to: string;
    institutionName: string;
    role: "universityAdmin" | "superAdmin";
    acceptUrl: string;
    expiresInHours: number;
  }): Promise<EmailResult>;

  sendBadgeDecision(input: {
    to: string;
    name: string;
    approved: boolean;
    reason?: string;
  }): Promise<EmailResult>;
}
