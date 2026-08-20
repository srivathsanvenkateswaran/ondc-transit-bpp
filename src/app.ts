import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AppConfig, OperatorRuntimeConfig } from "./config.js";
import { logEvent } from "./log.js";
import { TransitOrderService } from "./orders/service.js";
import { InMemoryOrderStore, OrderLifecycleError } from "./orders/store.js";
import { ack, nack } from "./protocol/ack.js";
import { dispatchCallback } from "./protocol/dispatch.js";
import type {
  ActionRequest,
  CallbackResponse,
  ConfirmRequest,
  InitRequest,
  ProtocolOrder,
  SearchRequest,
  SelectRequest,
  StatusRequest,
} from "./protocol/types.js";
import {
  createProtocolValidator,
  type ProtocolValidator,
  type ValidationResult,
} from "./protocol/validate.js";
import { FixtureJourneySource } from "./sources/fixture.js";
import { HttpJourneySource } from "./sources/http.js";
import type { JourneySource, OperatorKey } from "./sources/types.js";
import { buildOnSearch, searchQueryFromRequest } from "./trv11/catalog.js";

const MAX_BODY_BYTES = 1_048_576;
const requestActions = ["search", "select", "init", "confirm", "status"] as const;
type RequestAction = (typeof requestActions)[number];
type CallbackAction = `on_${RequestAction}`;

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRequestAction(value: unknown): value is RequestAction {
  return requestActions.includes(value as RequestAction);
}

function callbackUrl(operator: OperatorRuntimeConfig, action: CallbackAction) {
  const url = new URL(operator.callbackUrl);
  if (/\/on_[^/]+$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/on_[^/]+$/, `/${action}`);
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${action}`;
  }
  return url.toString();
}

function callbackContext(
  request: ActionRequest,
  operator: OperatorRuntimeConfig,
  action: CallbackAction,
  contextTtl: string,
) {
  return {
    ...request.context,
    action,
    bpp_id: operator.subscriberId,
    bpp_uri: operator.subscriberUri,
    timestamp: new Date().toISOString(),
    ttl: contextTtl,
  };
}

function requestValidation(
  validator: ProtocolValidator,
  action: RequestAction,
  body: unknown,
): ValidationResult {
  const validators: Record<RequestAction, (value: unknown) => ValidationResult> = {
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
  action: CallbackAction,
  body: unknown,
): ValidationResult {
  const validators: Record<CallbackAction, (value: unknown) => ValidationResult> = {
    on_search: validator.onSearch,
    on_select: validator.onSelect,
    on_init: validator.onInit,
    on_confirm: validator.onConfirm,
    on_status: validator.onStatus,
  };
  return validators[action](body);
}

export async function createApp(
  config: AppConfig,
  sourceOverrides: Partial<Record<OperatorKey, JourneySource>> = {},
  eventLogger: typeof logEvent = logEvent,
) {
  const validator = createProtocolValidator(config.schemaRoot);
  if (config.journeySource === "http" && !config.journeySourceUrl) {
    throw new Error("HTTP journey source requires journeySourceUrl");
  }
  const fixtureSources: Record<OperatorKey, JourneySource> = {
    bmtc: await FixtureJourneySource.load(config.fixtureRoot, "bmtc"),
    bmrcl: await FixtureJourneySource.load(config.fixtureRoot, "bmrcl"),
  };
  const configuredSource = (operatorKey: OperatorKey): JourneySource =>
    config.journeySource === "http"
      ? new HttpJourneySource({
          operatorKey,
          url: config.journeySourceUrl!,
          fallback: fixtureSources[operatorKey],
          responseSchemaPath: config.journeySourceResponseSchema,
          eventLogger,
        })
      : fixtureSources[operatorKey];
  const sources: Record<OperatorKey, JourneySource> = {
    bmtc: sourceOverrides.bmtc ?? configuredSource("bmtc"),
    bmrcl: sourceOverrides.bmrcl ?? configuredSource("bmrcl"),
  };
  const store = new InMemoryOrderStore();
  const orders: Record<OperatorKey, TransitOrderService> = {
    bmtc: new TransitOrderService(
      "bmtc",
      sources.bmtc.operator,
      config.operators.bmtc,
      store,
      { publicBaseUrl: config.publicBaseUrl },
    ),
    bmrcl: new TransitOrderService(
      "bmrcl",
      sources.bmrcl.operator,
      config.operators.bmrcl,
      store,
      { publicBaseUrl: config.publicBaseUrl },
    ),
  };

  async function buildCallback(
    operatorKey: OperatorKey,
    action: RequestAction,
    request: ActionRequest,
  ): Promise<CallbackResponse | Record<string, unknown>> {
    const operator = config.operators[operatorKey];
    const onAction = `on_${action}` as CallbackAction;
    const context = callbackContext(request, operator, onAction, config.contextTtl);
    try {
      let order: ProtocolOrder;
      switch (action) {
        case "search": {
          const search = request as SearchRequest;
          const offers = await sources[operatorKey].search(
            searchQueryFromRequest(search),
          );
          orders[operatorKey].cacheCatalogue(search.context.transaction_id, offers);
          return buildOnSearch(search, sources[operatorKey], operator, {
            publicBaseUrl: config.publicBaseUrl,
            contextTtl: config.contextTtl,
            offers,
          });
        }
        case "select":
          order = orders[operatorKey].select(request as SelectRequest);
          break;
        case "init":
          order = orders[operatorKey].init(request as InitRequest);
          break;
        case "confirm":
          order = await orders[operatorKey].confirm(request as ConfirmRequest);
          break;
        case "status":
          order = orders[operatorKey].status(request as StatusRequest);
          break;
      }
      return { context, message: { order } };
    } catch (error) {
      if (action === "search") throw error;
      return {
        context,
        error:
          error instanceof OrderLifecycleError
            ? { code: error.code, type: error.type, message: error.message }
            : {
                code: "INTERNAL-ERROR",
                type: "CORE-ERROR",
                message: error instanceof Error ? error.message : String(error),
              },
      };
    }
  }

  async function answerAction(
    operatorKey: OperatorKey,
    action: RequestAction,
    request: ActionRequest,
  ) {
    const operator = config.operators[operatorKey];
    const onAction = `on_${action}` as CallbackAction;
    try {
      const callback = await buildCallback(operatorKey, action, request);
      const validation = callbackValidation(validator, onAction, callback);
      if (!validation.valid) {
        throw new Error(
          `Generated ${onAction} failed schema validation: ${JSON.stringify(
            validation.errors,
          )}`,
        );
      }
      await sleep(operator.callbackDelayMs);
      await dispatchCallback(
        callbackUrl(operator, onAction),
        callback,
        config.callbackTimeoutMs,
      );
      const callbackRecord = callback as CallbackResponse;
      const orderId = callbackRecord.message?.order?.id;
      eventLogger({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: operator.subscriberId,
        operator: operatorKey,
        outcome: callbackRecord.error ? "ERROR" : "ACK",
        ...(orderId ? { order_id: orderId } : {}),
        ...(callbackRecord.error ? { error: callbackRecord.error } : {}),
      });
    } catch (error) {
      eventLogger({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: onAction,
        subscriber_id: operator.subscriberId,
        operator: operatorKey,
        outcome: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        status: "up",
        journeySource: config.journeySource,
        operators: Object.keys(sources),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/terms") {
      json(response, 200, {
        specimen: true,
        notice: "Local demonstration only. No ticket is valid for travel.",
      });
      return;
    }
    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (request.method === "GET" && orderMatch) {
      const order = store.inspect(decodeURIComponent(orderMatch[1]));
      json(response, order ? 200 : 404, order ?? { error: "Order not found" });
      return;
    }

    const match = url.pathname.match(
      /^\/(bmtc|bmrcl)\/(inbound|search|select|init|confirm|status)$/,
    );
    if (request.method !== "POST" || !match) {
      json(response, 404, { error: "Not found" });
      return;
    }

    const operatorKey = match[1] as OperatorKey;
    const pathAction = match[2];
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      json(
        response,
        400,
        nack(error instanceof Error ? error.message : "Invalid JSON"),
      );
      return;
    }

    const action = (body as { context?: { action?: unknown } }).context?.action;
    if (!isRequestAction(action) || (pathAction !== "inbound" && pathAction !== action)) {
      json(
        response,
        400,
        nack(`Request action ${String(action)} does not match path ${pathAction}`),
      );
      return;
    }
    const validation = requestValidation(validator, action, body);
    if (!validation.valid) {
      json(
        response,
        400,
        nack(`${action} payload failed TRV11 validation`, validation.errors),
      );
      return;
    }

    const protocolRequest = body as ActionRequest;
    if (action === "search") {
      const search = protocolRequest as SearchRequest;
      const expectedCategory = sources[operatorKey].operator.vehicleCategory;
      const requestedCategory = search.message.intent.fulfillment.vehicle?.category;
      if (requestedCategory && requestedCategory !== expectedCategory) {
        eventLogger({
          transaction_id: search.context.transaction_id,
          message_id: search.context.message_id,
          action,
          subscriber_id: config.operators[operatorKey].subscriberId,
          operator: operatorKey,
          outcome: "SKIPPED",
          reason: `Requested vehicle category ${requestedCategory}; expected ${expectedCategory}`,
          requested_category: requestedCategory,
          expected_category: expectedCategory,
        });
        json(response, 202, ack);
        return;
      }
    }

    json(response, 202, ack);
    eventLogger({
      transaction_id: protocolRequest.context.transaction_id,
      message_id: protocolRequest.context.message_id,
      action,
      subscriber_id: config.operators[operatorKey].subscriberId,
      operator: operatorKey,
      outcome: "ACK",
    });
    void answerAction(operatorKey, action, protocolRequest);
  });
}
