/**
 * What the rest of the backend knows about push delivery.
 *
 * Domain code asks for "tell this person their seat was accepted". It does not
 * know Expo exists, does not hold a token, and does not wait for a network
 * call — the same shape as the email service, and for the same reasons.
 */

export type PushMessage = {
  /** Expo push tokens for one person's devices. */
  tokens: string[];
  title: string;
  body: string;
  /**
   * Deep-link payload. Ids and a notification kind only — never user content,
   * because this travels through a third party's servers.
   */
  data: Record<string, string>;
};

export type PushResult = {
  sent: number;
  /** Tokens the provider reported as dead, to be retired. */
  invalidTokens: string[];
};

export interface PushProvider {
  readonly name: "expo" | "console";
  send(message: PushMessage): Promise<PushResult>;
}
