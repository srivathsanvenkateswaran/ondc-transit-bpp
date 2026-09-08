import type { IncomingMessage, ServerResponse } from "node:http";

import { ack, nack } from "../protocol/ack.js";
import { dispatchCallback } from "../protocol/dispatch.js";
import { unavailableSeatsTag } from "./catalog.js";
import {
  RESERVED_DOMAIN,
  RESERVED_INTERNAL_ERROR,
  RESERVED_VERSION,
} from "./domain.js";
import { ReservedLifecycleError } from "./errors.js";
import type { ReservedOrderService } from "./order.js";
import type { ReservedValidator } from "./schema.js";

/**
 * The seven endpoints the reserved category answers on, and the callback each
 * one posts back.
 *
 * The shape is the one the two existing categories already use, deliberately:
 * an immediate acknowledgement on the open connection and the answer as a
 * separate post, one endpoint per action plus one inbound endpoint that
 * dispatches on the action in the payload. The inbound endpoint exists because
 * the pinned protocol server exposes one webhook per seller rather than one
 * per action.
 *
 * A deployment with no gateway in front of reserved can turn
 * `dependencies.syncResponses` on and get the same answer back on the open
 * connection instead - see `answerActionSync` below and
 * `AppConfig.reservedSyncResponses` in `src/config.ts` for why that is safe
 * for this category specifically.
 *
 * A domain refusal arrives as an `error` on the callback with no
 * `message.order`. Two refusals carry a payload beside them, and neither of
 * them puts it on an order: a seat somebody else took comes back with the
 * current seat map, and a refund quote that moved comes back with the new
 * figure. An order would say the action half succeeded.
 */

const RESERVED_ACTIONS = [
  "search",
  "select",
  "init",
  "confirm",
  "status",
  "cancel",
] as const;

export type ReservedAction = (typeof RESERVED_ACTIONS)[number];
type ReservedCallbackAction = `on_${ReservedAction}`;

export const RESERVED_ROUTE =
  /^\/(ksrtc)\/(inbound|search|select|init|confirm|status|cancel)$/;

export interface ReservedRuntimeConfig {
  subscriberId: string;
  subscriberUri: string;
  callbackUrl: string;
  callbackDelayMs: number;
}

/**
 * How long a synchronous answer is allowed to take before this provider stops
 * waiting for its own database and says so.
 *
 * With `syncResponses` on, the whole chain of database round trips for an
 * action sits directly on the open connection, and nothing in this process
 * bounded it. The only backstop was whatever router or proxy is in front -
 * on the deployment this ships to, Heroku's, that is a hard 30 seconds ending
 * in an H12 and a closed connection with no body at all. That is the worst
 * answer available: the client learns nothing, cannot tell a slow provider
 * from a dead one, and has no code to branch on.
 *
 * Eight seconds is chosen to sit well inside any such router clock while
 * staying far above what a healthy request costs (single-digit milliseconds
 * locally, low seconds even with a database on another continent), so it
 * fires on a provider that is genuinely stuck rather than on one that is
 * merely far away.
 */
export const RESERVED_SYNC_TIMEOUT_MS = 8_000;

/** Thrown by {@link withDeadline}, and nothing else throws it. */
class ReservedDeadlineExceeded extends Error {
  constructor(readonly milliseconds: number) {
    super(`Provider did not finish within ${milliseconds}ms`);
    this.name = "ReservedDeadlineExceeded";
  }
}

/**
 * `work`, or a `ReservedDeadlineExceeded` once `milliseconds` have passed.
 *
 * The abandoned work is not cancelled - there is nothing in a libSQL
 * statement to cancel - it is only stopped being waited on. Its eventual
 * settlement, success or failure, is already handled here, so a rejection
 * that arrives after the deadline is absorbed rather than surfacing as an
 * unhandled rejection that would take the process down.
 */
function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return work;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ReservedDeadlineExceeded(milliseconds)),
      milliseconds,
    );
    // The deadline must never be the reason a process stays alive.
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface ReservedHandlerDependencies {
  orders: ReservedOrderService;
  validator: ReservedValidator;
  runtime: ReservedRuntimeConfig;
  contextTtl: string;
  callbackTimeoutMs: number;
  logEvent: (fields: Record<string, unknown>) => void;
  now?: () => Date;
  /**
   * Return the built `on_<action>` payload as the HTTP response to the action
   * itself, instead of acking the request and posting the payload to
   * `runtime.callbackUrl` afterwards. See `AppConfig.reservedSyncResponses`
   * for why this exists and when it is safe to turn on.
   */
  syncResponses?: boolean;
  /**
   * The deadline `answerActionSync` answers by, in milliseconds. Defaults to
   * {@link RESERVED_SYNC_TIMEOUT_MS}; zero or a negative number means no
   * deadline at all, which is what this handler did before it had one.
   * Ignored entirely when `syncResponses` is off, because the ack has already
   * gone out on that path and there is no connection left to answer late on.
   */
  syncTimeoutMs?: number;
}

interface RequestContext {
  domain: string;
  version: string;
  action: string;
  transaction_id: string;
  message_id: string;
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  [key: string]: unknown;
}

interface ReservedProtocolRequest {
  context: RequestContext;
  message: Record<string, unknown>;
}

function isReservedAction(value: unknown): value is ReservedAction {
  return RESERVED_ACTIONS.includes(value as ReservedAction);
}

function callbackUrlFor(base: string, action: ReservedCallbackAction): string {
  const url = new URL(base);
  if (/\/on_[^/]+$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/on_[^/]+$/, `/${action}`);
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${action}`;
  }
  return url.toString();
}

function requestValidation(
  validator: ReservedValidator,
  action: ReservedAction,
  body: unknown,
) {
  const validators = {
    search: validator.search,
    select: validator.select,
    init: validator.init,
    confirm: validator.confirm,
    status: validator.status,
    cancel: validator.cancel,
  } as const;
  return validators[action](body);
}

function callbackValidation(
  validator: ReservedValidator,
  action: ReservedCallbackAction,
  body: unknown,
) {
  const validators = {
    on_search: validator.onSearch,
    on_select: validator.onSelect,
    on_init: validator.onInit,
    on_confirm: validator.onConfirm,
    on_status: validator.onStatus,
    on_cancel: validator.onCancel,
  } as const;
  return validators[action](body);
}

/**
 * What rides beside a refusal, where anything does.
 *
 * Never an order: a refused action produced none, and inventing one would tell
 * a client the action half succeeded.
 *
 * Exported because the golden lifecycle needs the same translation, and it
 * used to carry its own copy. A copy is worse than useless here: the golden
 * refusal payload is checked into the repository as a record of what this
 * provider sends, and a second implementation of the translation meant it was
 * a record of what a test file sends. The seat ids were computed into the
 * attachment and dropped by both, so a `SEAT-UNAVAILABLE` named the seats only
 * inside its English sentence, and a client that promised the rider a current
 * map could not say which seats had moved without parsing prose for seat ids.
 * They travel as a tag rather than on the error object, because this domain's
 * error object carries a code and a sentence and nothing else.
 */
export function refusalMessage(
  error: ReservedLifecycleError,
): Record<string, unknown> {
  const attachment = error.attachment ?? {};
  const message: Record<string, unknown> = {};
  const tags = [
    ...(Array.isArray(attachment.unavailableSeatIds) &&
    attachment.unavailableSeatIds.length > 0
      ? [unavailableSeatsTag(attachment.unavailableSeatIds as string[])]
      : []),
    ...(attachment.seatMap ? [attachment.seatMap] : []),
    ...(attachment.seatMapLayout ? [attachment.seatMapLayout] : []),
  ];
  if (tags.length > 0) message.tags = tags;
  if (attachment.tags) message.tags = attachment.tags;
  if (attachment.refund) message.refund = attachment.refund;
  return message;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createReservedHandler(dependencies: ReservedHandlerDependencies) {
  const now = dependencies.now ?? (() => new Date());

  function callbackContext(
    request: ReservedProtocolRequest,
    action: ReservedCallbackAction,
  ) {
    return {
      ...request.context,
      action,
      domain: RESERVED_DOMAIN,
      version: RESERVED_VERSION,
      bpp_id: dependencies.runtime.subscriberId,
      bpp_uri: dependencies.runtime.subscriberUri,
      timestamp: now().toISOString(),
      ttl: dependencies.contextTtl,
    };
  }

  async function buildCallback(
    action: ReservedAction,
    request: ReservedProtocolRequest,
  ): Promise<Record<string, unknown>> {
    const context = callbackContext(request, `on_${action}`);
    try {
      const message = await runAction(action, request);
      return { context, message };
    } catch (error) {
      if (!(error instanceof ReservedLifecycleError)) {
        dependencies.logEvent({
          transaction_id: request.context.transaction_id,
          message_id: request.context.message_id,
          action: `on_${action}`,
          subscriber_id: dependencies.runtime.subscriberId,
          operator: "ksrtc",
          outcome: "BUILD_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          context,
          message: {},
          error: {
            code: RESERVED_INTERNAL_ERROR,
            message: "Provider could not process the request",
          },
        };
      }
      return {
        context,
        message: refusalMessage(error),
        error: { code: error.code, message: error.message },
      };
    }
  }

  async function runAction(
    action: ReservedAction,
    request: ReservedProtocolRequest,
  ): Promise<Record<string, unknown>> {
    switch (action) {
      case "search":
        return dependencies.orders.search(request);
      case "select":
        return dependencies.orders.select(request);
      case "init":
        return dependencies.orders.init(request);
      case "confirm":
        return dependencies.orders.confirm(request);
      case "status":
        return dependencies.orders.status(request);
      case "cancel":
        return dependencies.orders.cancel(request);
    }
  }

  /**
   * The answer of last resort, for when this provider cannot express its own.
   *
   * Nothing but the context and an error, so it validates against every
   * callback schema in the tree by their `error` branch, whatever went wrong
   * upstream. The message is deliberately not a reassurance: a callback that
   * failed its own schema may have been built from an action that already
   * changed state - the whole-booking cancellation this replaced had committed
   * the cancellation and then found it could not say so - and a client told
   * "nothing happened" would be told something this provider does not know.
   */
  function lastResort(
    request: ReservedProtocolRequest,
    onAction: ReservedCallbackAction,
  ): Record<string, unknown> {
    return {
      context: callbackContext(request, onAction),
      message: {},
      error: {
        code: RESERVED_INTERNAL_ERROR,
        message:
          "This provider could not express an answer to this request within its own published shapes; the outcome is not known from this message and a status read is the way to find it",
      },
    };
  }

  /**
   * Build the `on_<action>` payload and make sure it is one this provider is
   * willing to publish, falling back to `lastResort` if it is not.
   *
   * Shared by the ack-then-callback path and the synchronous-response path:
   * both need exactly this, and differ only in what they do with the result -
   * post it to `runtime.callbackUrl` after a delay, or hand it straight back
   * as the HTTP response.
   */
  async function resolveCallback(
    action: ReservedAction,
    request: ReservedProtocolRequest,
  ): Promise<{ onAction: ReservedCallbackAction; callback: Record<string, unknown> }> {
    const onAction = `on_${action}` as ReservedCallbackAction;
    let callback = await buildCallback(action, request);
    const validation = callbackValidation(
      dependencies.validator,
      onAction,
      callback,
    );
    if (!validation.valid) {
      // This used to throw, which meant the callback was never sent and the
      // client waited out its own timeout against silence. A provider that
      // cannot say what happened must still say that much: an unanswerable
      // request is answered with the code for it, and the schema failure is
      // logged beside it rather than instead of it.
      //
      // The refusal itself is validated too. If even that will not pass, the
      // caller's own catch logs and nothing is sent, which is the one case
      // where silence is the only thing left.
      dependencies.logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: dependencies.runtime.subscriberId,
        operator: "ksrtc",
        outcome: "SCHEMA_ERROR",
        error: `Generated ${onAction} failed schema validation: ${JSON.stringify(
          validation.errors,
        )}`,
      });
      callback = lastResort(request, onAction);
      const fallbackValidation = callbackValidation(
        dependencies.validator,
        onAction,
        callback,
      );
      if (!fallbackValidation.valid) {
        throw new Error(
          `Generated ${onAction} and its refusal both failed schema validation: ${JSON.stringify(
            fallbackValidation.errors,
          )}`,
        );
      }
    }
    return { onAction, callback };
  }

  function logResolution(
    request: ReservedProtocolRequest,
    onAction: ReservedCallbackAction,
    callback: Record<string, unknown>,
  ): void {
    const error = (callback as { error?: { code: string } }).error;
    const orderId = (
      callback as { message?: { order?: { id?: string } } }
    ).message?.order?.id;
    dependencies.logEvent({
      transaction_id: request.context.transaction_id,
      message_id: request.context.message_id,
      action: onAction,
      subscriber_id: dependencies.runtime.subscriberId,
      operator: "ksrtc",
      outcome: error ? "ERROR" : "ACK",
      ...(orderId ? { order_id: orderId } : {}),
      ...(error ? { error } : {}),
    });
  }

  async function answerAction(
    action: ReservedAction,
    request: ReservedProtocolRequest,
  ): Promise<void> {
    const onAction = `on_${action}` as ReservedCallbackAction;
    try {
      const resolved = await resolveCallback(action, request);
      await sleep(dependencies.runtime.callbackDelayMs);
      await dispatchCallback(
        callbackUrlFor(dependencies.runtime.callbackUrl, onAction),
        resolved.callback,
        dependencies.callbackTimeoutMs,
      );
      logResolution(request, resolved.onAction, resolved.callback);
    } catch (error) {
      dependencies.logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: dependencies.runtime.subscriberId,
        operator: "ksrtc",
        outcome: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The synchronous twin of `answerAction`: same resolution, handed back on
   * the open connection instead of posted to a callback URL.
   *
   * There is no ack-then-timeout window here, so the internal-error case that
   * `answerAction` can leave to silence (both the real callback and its own
   * refusal fail schema validation) has to answer something: the rider's
   * request is this connection, and closing it with nothing is the exact
   * defect this whole feature exists to remove.
   */
  async function answerActionSync(
    action: ReservedAction,
    request: ReservedProtocolRequest,
    respond: (status: number, payload: unknown) => void,
  ): Promise<void> {
    const onAction = `on_${action}` as ReservedCallbackAction;
    const deadlineMs = dependencies.syncTimeoutMs ?? RESERVED_SYNC_TIMEOUT_MS;
    try {
      const resolved = await withDeadline(
        resolveCallback(action, request),
        deadlineMs,
      );
      logResolution(request, resolved.onAction, resolved.callback);
      respond(200, resolved.callback);
    } catch (error) {
      const timedOut = error instanceof ReservedDeadlineExceeded;
      dependencies.logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: dependencies.runtime.subscriberId,
        operator: "ksrtc",
        outcome: timedOut ? "TIMEOUT" : "ERROR",
        ...(timedOut ? { timeout_ms: deadlineMs } : {}),
        error: error instanceof Error ? error.message : String(error),
      });
      // A timeout answers 504 rather than 500 and says which it was, because
      // the two are different things for whoever is holding the connection:
      // a 500 is this provider having decided something, and a 504 is it
      // having run out of the time it gave itself. Both carry the same
      // domain error object, so a client that only reads the envelope is
      // unaffected, and both are an answer - which is the point. Left
      // unbounded, this path returned nothing at all and the router closed
      // the connection at 30 seconds with no body for a client to branch on.
      respond(timedOut ? 504 : 500, {
        context: callbackContext(request, onAction),
        message: {},
        error: {
          code: RESERVED_INTERNAL_ERROR,
          message: timedOut
            ? `Provider did not finish this request within ${deadlineMs}ms and stopped waiting; the request may be retried`
            : "Provider could not process the request",
        },
      });
    }
  }

  return {
    /** The endpoint list the index page prints. */
    endpoints: RESERVED_ACTIONS.map((action) => `POST /ksrtc/${action}`).concat(
      "POST /ksrtc/inbound",
    ),

    async handle(
      pathAction: string,
      body: unknown,
      _request: IncomingMessage,
      respond: (status: number, payload: unknown) => void,
    ): Promise<void> {
      const action = (body as { context?: { action?: unknown } }).context?.action;
      if (!isReservedAction(action) || (pathAction !== "inbound" && pathAction !== action)) {
        respond(
          400,
          nack(`Request action ${String(action)} does not match path ${pathAction}`),
        );
        return;
      }
      const validation = requestValidation(dependencies.validator, action, body);
      if (!validation.valid) {
        respond(
          400,
          nack(
            `${action} payload failed reserved intercity validation`,
            validation.errors,
          ),
        );
        return;
      }
      const request = body as ReservedProtocolRequest;
      if (dependencies.syncResponses) {
        await answerActionSync(action, request, respond);
        return;
      }
      respond(202, ack);
      dependencies.logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action,
        subscriber_id: dependencies.runtime.subscriberId,
        operator: "ksrtc",
        outcome: "ACK",
      });
      void answerAction(action, request);
    },
  };
}

export type ReservedHandler = ReturnType<typeof createReservedHandler>;

/** Only so the http layer can answer with the same json helper it already has. */
export type Responder = (
  response: ServerResponse,
  status: number,
  body: unknown,
) => void;
