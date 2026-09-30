/**
 * Where a realtime event is sent.
 *
 * The event shapes themselves live in the contract, vendored from the mobile
 * app like every other shared type — a channel is a server concern and the app
 * has no business knowing one exists.
 */
import type { RealtimeEvent, RealtimeEventType } from "../../contract/events.js";

export type { RealtimeEvent, RealtimeEventType };

/**
 * Where an event is sent.
 *
 * `user` is one person, on every device they are signed in on. `institution`
 * is every administrator scoped to that institution. `platform` is every
 * platform administrator. Nothing is ever broadcast to everyone.
 */
export type Channel =
  | { kind: "user"; userId: string }
  | { kind: "institution"; institutionId: string }
  | { kind: "platform" };

export function channelKey(channel: Channel): string {
  switch (channel.kind) {
    case "user":
      return `user:${channel.userId}`;
    case "institution":
      return `institution:${channel.institutionId}`;
    case "platform":
      return "platform";
  }
}
