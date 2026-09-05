import type { ReservedErrorCode } from "./domain.js";

/**
 * A domain refusal on the reserved path.
 *
 * It travels the same road every refusal on the two existing paths already
 * takes: it arrives as an `error` on the callback with no `message.order`,
 * which is this stack's equivalent of a negative acknowledgement for a domain
 * error rather than a malformed payload.
 *
 * `attachment` is the one thing this path needs that the existing one does
 * not. Two refusals are only useful with a payload beside them: a seat taken
 * by somebody else is worth answering with the current seat map, so the client
 * can re-render without a second round trip, and a cancellation quote that has
 * moved is worth answering with the new figure, so the rider sees the real
 * number before committing again. Neither rides on `message.order`, because a
 * refused action produced no order and inventing one would tell a client the
 * action half succeeded.
 */
export class ReservedLifecycleError extends Error {
  readonly type = "DOMAIN-ERROR";

  constructor(
    readonly code: ReservedErrorCode,
    message: string,
    readonly attachment?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReservedLifecycleError";
  }
}
