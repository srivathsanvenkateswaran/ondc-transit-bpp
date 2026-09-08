import type { OperatorRuntimeConfig } from "../config.js";
import { OrderLifecycleError } from "../orders/store.js";
import type { TransitOrderService } from "../orders/service.js";
import { nack } from "../protocol/ack.js";
import type {
  ActionRequest,
  CallbackResponse,
  ConfirmRequest,
  InitRequest,
  ProtocolOrder,
  SearchRequest,
  SelectRequest,
  StatusRequest,
  Trv11Context,
} from "../protocol/types.js";
import type { ProtocolValidator, ValidationResult } from "../protocol/validate.js";
import type { OperatorProfile } from "../sources/types.js";
import { buildPassOnSearch, isPassSearch } from "./pass.js";

/**
 * Karnataka Sarige's own pass route - `/ksrtc/pass/*` - and why it is not
 * `/bmtc/*` or `/bmrcl/*`'s third sibling.
 *
 * Those two routes answer ack-then-callback (SPEC 5.4): the request gets a
 * bare 202, and the real `on_<action>` is posted, after a delay, to
 * `operator.callbackUrl` - the deployed onix network's own inbound webhook,
 * which is what turns that async callback back into the single synchronous
 * response Tatak's `OndcClient` gets to work with. That machinery is
 * registry-driven: the network's gateway fans a `search` out to whichever
 * BPPs it has a subscriber entry for, and its addressed routing for
 * `select`/`init`/`confirm` is keyed the same way. As of this feature, that
 * registry carries exactly two BPPs - `bmtc` and `bmrcl` - configured as six
 * environment keys on the deployed network (`BAP_URI`, `GATEWAY_URI`,
 * `BMTC_BPP_URI`, `BMTC_WEBHOOK_URL`, `BMRCL_BPP_URI`,
 * `BMRCL_WEBHOOK_URL`). Adding a third leg there is not a configuration
 * change - it is a change to the vendored onix network Tatak deploys - and is
 * out of scope for this feature.
 *
 * So this route does not travel that network at all. It is dialled directly,
 * the same shape `src/reserved/handler.ts`'s `answerActionSync` already
 * established for the reserved intercity category and for the identical
 * reason stated there: no gateway sits in front of it, so there is nothing
 * an ack-then-callback shape buys here, and answering on the open connection
 * is both simpler and the only thing a direct-dialling caller with no public
 * webhook of its own can actually consume. Unlike `reserved`, there is no
 * toggle between the two shapes here: this route exists for exactly one
 * caller, dialling it directly, so it only ever answers synchronously.
 *
 * **This is a real sale against a real seller - reconciled, TOTP-credentialed,
 * settlement-checked, identical in every way to a `bmtc` or `bmrcl` pass
 * order once a request reaches `TransitOrderService`.** What it is not is a
 * sale that has travelled the ONDC network's own gateway and registry the
 * way the other nine catalogue items do. A reader of an event log or a
 * captured request should be able to tell the two apart, which is the whole
 * reason this route is spelled differently rather than folded into
 * `/bmtc|bmrcl/` as a third, quieter member.
 */
export const KSRTC_PASS_ROUTE =
  /^\/ksrtc\/pass\/(search|select|init|confirm|status)$/;

const KSRTC_PASS_ACTIONS = [
  "search",
  "select",
  "init",
  "confirm",
  "status",
] as const;

type KsrtcPassAction = (typeof KSRTC_PASS_ACTIONS)[number];
type KsrtcPassCallbackAction = `on_${KsrtcPassAction}`;

function isKsrtcPassAction(value: unknown): value is KsrtcPassAction {
  return (KSRTC_PASS_ACTIONS as readonly unknown[]).includes(value);
}

function requestValidation(
  validator: ProtocolValidator,
  action: KsrtcPassAction,
  body: unknown,
): ValidationResult {
  const validators: Record<KsrtcPassAction, (value: unknown) => ValidationResult> = {
    search: validator.search,
    select: validator.select,
    init: validator.init,
    confirm: validator.confirm,
    status: validator.status,
  };
  return validators[action](body);
}

function callbackValidation(
  validator: ProtocolValidator,
  action: KsrtcPassCallbackAction,
  body: unknown,
): ValidationResult {
  const validators: Record<KsrtcPassCallbackAction, (value: unknown) => ValidationResult> = {
    on_search: validator.onSearch,
    on_select: validator.onSelect,
    on_init: validator.onInit,
    on_confirm: validator.onConfirm,
    on_status: validator.onStatus,
  };
  return validators[action](body);
}

export interface KsrtcPassHandlerDependencies {
  /** Static facts about Karnataka Sarige - name, service window - the same
   *  shape `sources[operatorKey].operator` already carries for bmtc/bmrcl,
   *  read here from `fixtures/ksrtc/offers.json` rather than a live journey
   *  source: this provider sells no Sarige ride offers, only passes. */
  profile: OperatorProfile;
  orders: TransitOrderService;
  validator: ProtocolValidator;
  runtime: OperatorRuntimeConfig;
  publicBaseUrl: string;
  contextTtl: string;
  logEvent: (fields: Record<string, unknown>) => void;
  now?: () => Date;
}

export function createKsrtcPassHandler(deps: KsrtcPassHandlerDependencies) {
  const now = deps.now ?? (() => new Date());

  function callbackContext(
    request: ActionRequest,
    action: KsrtcPassCallbackAction,
  ): Trv11Context {
    return {
      ...request.context,
      action,
      bpp_id: deps.runtime.subscriberId,
      bpp_uri: deps.runtime.subscriberUri,
      timestamp: now().toISOString(),
      ttl: deps.contextTtl,
    };
  }

  async function buildCallback(
    action: KsrtcPassAction,
    request: ActionRequest,
  ): Promise<Record<string, unknown>> {
    if (action === "search") {
      return buildPassOnSearch(
        request as SearchRequest,
        deps.profile,
        "ksrtc",
        deps.runtime,
        { publicBaseUrl: deps.publicBaseUrl, contextTtl: deps.contextTtl, now },
      );
    }
    const onAction = `on_${action}` as KsrtcPassCallbackAction;
    const context = callbackContext(request, onAction);
    try {
      let order: ProtocolOrder;
      switch (action) {
        case "select":
          order = deps.orders.select(request as SelectRequest);
          break;
        case "init":
          order = deps.orders.init(request as InitRequest);
          break;
        case "confirm":
          order = await deps.orders.confirm(request as ConfirmRequest);
          break;
        case "status":
          order = deps.orders.status(request as StatusRequest);
          break;
      }
      return { context, message: { order } };
    } catch (error) {
      if (!(error instanceof OrderLifecycleError)) {
        deps.logEvent({
          transaction_id: request.context.transaction_id,
          message_id: request.context.message_id,
          action: onAction,
          subscriber_id: deps.runtime.subscriberId,
          operator: "ksrtc",
          outcome: "BUILD_ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        context,
        message: {},
        error:
          error instanceof OrderLifecycleError
            ? { code: error.code, message: error.message }
            : {
                code: "INTERNAL-ERROR",
                message: "Provider could not process the request",
              },
      };
    }
  }

  /** The answer of last resort - `reserved/handler.ts`'s own `lastResort`,
   *  for the same reason: a callback that fails its own schema still owes
   *  the caller an answer, on the one connection this route ever has to
   *  answer on. */
  function lastResort(
    request: ActionRequest,
    onAction: KsrtcPassCallbackAction,
  ): CallbackResponse {
    return {
      context: callbackContext(request, onAction),
      message: {},
      error: {
        code: "INTERNAL-ERROR",
        message:
          "This provider could not express an answer to this request within its own published shapes",
      },
    } as CallbackResponse;
  }

  async function resolveCallback(
    action: KsrtcPassAction,
    request: ActionRequest,
  ): Promise<{ onAction: KsrtcPassCallbackAction; callback: Record<string, unknown> }> {
    const onAction = `on_${action}` as KsrtcPassCallbackAction;
    let callback = await buildCallback(action, request);
    const validation = callbackValidation(deps.validator, onAction, callback);
    if (!validation.valid) {
      deps.logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: deps.runtime.subscriberId,
        operator: "ksrtc",
        outcome: "SCHEMA_ERROR",
        error: `Generated ${onAction} failed schema validation: ${JSON.stringify(validation.errors)}`,
      });
      callback = lastResort(request, onAction);
      const fallback = callbackValidation(deps.validator, onAction, callback);
      if (!fallback.valid) {
        throw new Error(
          `Generated ${onAction} and its refusal both failed schema validation: ${JSON.stringify(fallback.errors)}`,
        );
      }
    }
    return { onAction, callback };
  }

  function logResolution(
    request: ActionRequest,
    onAction: KsrtcPassCallbackAction,
    callback: Record<string, unknown>,
  ): void {
    const error = (callback as { error?: { code: string } }).error;
    const orderId = (callback as { message?: { order?: { id?: string } } })
      .message?.order?.id;
    deps.logEvent({
      transaction_id: request.context.transaction_id,
      message_id: request.context.message_id,
      action: onAction,
      subscriber_id: deps.runtime.subscriberId,
      operator: "ksrtc",
      outcome: error ? "ERROR" : "ACK",
      ...(orderId ? { order_id: orderId } : {}),
      ...(error ? { error } : {}),
    });
  }

  return {
    /** The endpoint list the index page prints. */
    endpoints: KSRTC_PASS_ACTIONS.map((action) => `POST /ksrtc/pass/${action}`),

    async handle(
      pathAction: string,
      body: unknown,
      respond: (status: number, payload: unknown) => void,
    ): Promise<void> {
      const action = (body as { context?: { action?: unknown } })?.context?.action;
      if (!isKsrtcPassAction(action) || action !== pathAction) {
        respond(
          400,
          nack(`Request action ${String(action)} does not match path ${pathAction}`),
        );
        return;
      }
      const validation = requestValidation(deps.validator, action, body);
      if (!validation.valid) {
        respond(
          400,
          nack(`${action} payload failed TRV11 validation`, validation.errors),
        );
        return;
      }
      const request = body as ActionRequest;
      if (action === "search" && !isPassSearch(request as SearchRequest)) {
        respond(
          400,
          nack(
            "This route sells Karnataka Sarige passes only; the search intent named no PASS category",
          ),
        );
        return;
      }
      try {
        const resolved = await resolveCallback(action, request);
        logResolution(request, resolved.onAction, resolved.callback);
        respond(200, resolved.callback);
      } catch (error) {
        const onAction = `on_${action}` as KsrtcPassCallbackAction;
        deps.logEvent({
          transaction_id: request.context.transaction_id,
          message_id: request.context.message_id,
          action: onAction,
          subscriber_id: deps.runtime.subscriberId,
          operator: "ksrtc",
          outcome: "ERROR",
          error: error instanceof Error ? error.message : String(error),
        });
        respond(500, {
          context: callbackContext(request, onAction),
          message: {},
          error: {
            code: "INTERNAL-ERROR",
            message: "Provider could not process the request",
          },
        });
      }
    },
  };
}
