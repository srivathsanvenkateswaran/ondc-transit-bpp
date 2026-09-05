import type { IncomingMessage, ServerResponse } from "node:http";

import { ack, nack } from "../protocol/ack.js";
import { dispatchCallback } from "../protocol/dispatch.js";
import { RESERVED_DOMAIN, RESERVED_VERSION } from "./domain.js";
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

export interface ReservedHandlerDependencies {
  orders: ReservedOrderService;
  validator: ReservedValidator;
  runtime: ReservedRuntimeConfig;
  contextTtl: string;
  callbackTimeoutMs: number;
  logEvent: (fields: Record<string, unknown>) => void;
  now?: () => Date;
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
            code: "INTERNAL-ERROR",
            message: "Provider could not process the request",
          },
        };
      }
      // What rides beside a refusal, where anything does. Never an order: a
      // refused action produced none, and inventing one would tell a client
      // the action half succeeded.
      const attachment = error.attachment ?? {};
      const message: Record<string, unknown> = {};
      if (attachment.seatMap) message.tags = [attachment.seatMap];
      if (attachment.tags) message.tags = attachment.tags;
      if (attachment.refund) message.refund = attachment.refund;
      return {
        context,
        message,
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

  async function answerAction(
    action: ReservedAction,
    request: ReservedProtocolRequest,
  ): Promise<void> {
    const onAction = `on_${action}` as ReservedCallbackAction;
    try {
      const callback = await buildCallback(action, request);
      const validation = callbackValidation(
        dependencies.validator,
        onAction,
        callback,
      );
      if (!validation.valid) {
        throw new Error(
          `Generated ${onAction} failed schema validation: ${JSON.stringify(
            validation.errors,
          )}`,
        );
      }
      await sleep(dependencies.runtime.callbackDelayMs);
      await dispatchCallback(
        callbackUrlFor(dependencies.runtime.callbackUrl, onAction),
        callback,
        dependencies.callbackTimeoutMs,
      );
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
