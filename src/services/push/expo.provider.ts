import { logger } from "../../utils/logger.js";
import type { PushMessage, PushProvider, PushResult } from "./push.types.js";

/**
 * Expo's push service, over plain fetch.
 *
 * The app is built with Expo and registers Expo push tokens, so this is the
 * endpoint those tokens belong to. No SDK, for the same reason as the email
 * provider: it is one authenticated POST, and what matters is a hard timeout
 * that a client library does not expose.
 *
 * Nothing here blocks a request. The dispatcher calls it after the response
 * has gone out — a driver tapping Accept must not wait on a third party.
 */

const ENDPOINT = "https://exp.host/--/api/v2/push/send";

/** Expo's documented cap per request. */
const BATCH_SIZE = 100;

const TIMEOUT_MS = 10_000;

type ExpoTicket = {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
};

export class ExpoPushProvider implements PushProvider {
  readonly name = "expo" as const;

  async send(message: PushMessage): Promise<PushResult> {
    if (message.tokens.length === 0) return { sent: 0, invalidTokens: [] };

    let sent = 0;
    const invalidTokens: string[] = [];

    for (let i = 0; i < message.tokens.length; i += BATCH_SIZE) {
      const batch = message.tokens.slice(i, i + BATCH_SIZE);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(
            batch.map((token) => ({
              to: token,
              title: message.title,
              body: message.body,
              data: message.data,
              sound: "default",
              // Expo drops a notification the device never collected rather
              // than delivering yesterday's reminder tomorrow morning.
              ttl: 3600,
            })),
          ),
          signal: controller.signal,
        });

        if (!response.ok) {
          logger.warn(
            { provider: "expo", status: response.status },
            "push batch rejected",
          );
          continue;
        }

        const body = (await response.json().catch(() => ({}))) as {
          data?: ExpoTicket[];
        };

        body.data?.forEach((ticket, index) => {
          if (ticket.status === "ok") {
            sent++;
            return;
          }
          // The app was uninstalled, or the token was rotated. Keeping it
          // means retrying a dead address on every future notification.
          if (ticket.details?.error === "DeviceNotRegistered") {
            const token = batch[index];
            if (token) invalidTokens.push(token);
          }
          logger.warn(
            { provider: "expo", error: ticket.details?.error },
            "push ticket error",
          );
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        // Never rethrown: a failed notification must not fail the action that
        // triggered it. The seat is still accepted.
        logger.warn(
          { provider: "expo", aborted, err: error },
          aborted ? "push send timed out" : "push send errored",
        );
      } finally {
        clearTimeout(timer);
      }
    }

    return { sent, invalidTokens };
  }
}

/**
 * Development provider: logs instead of sending.
 *
 * Unlike email, this one is safe outside development — a missing push is an
 * inconvenience, where a swallowed verification email means nobody can sign
 * up at all. It is still not the default anywhere real.
 */
export class ConsolePushProvider implements PushProvider {
  readonly name = "console" as const;

  async send(message: PushMessage): Promise<PushResult> {
    logger.info(
      {
        provider: "console",
        devices: message.tokens.length,
        title: message.title,
        kind: message.data["kind"],
      },
      "push (not sent — console provider)",
    );
    return { sent: message.tokens.length, invalidTokens: [] };
  }
}
