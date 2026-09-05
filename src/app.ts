import { timingSafeEqual } from "node:crypto";
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
import { openReservedDatabase } from "./reserved/db.js";
import { FixtureReservedSource } from "./reserved/fixture.js";
import { HttpReservedSource } from "./reserved/http.js";
import {
  RESERVED_ROUTE,
  createReservedHandler,
  type ReservedHandler,
} from "./reserved/handler.js";
import { ReservedOrderService } from "./reserved/order.js";
import { createReservedValidator } from "./reserved/schema.js";
import { ReservedStore } from "./reserved/store.js";
import type { ReservedServiceSource } from "./reserved/types.js";
import { FixtureJourneySource } from "./sources/fixture.js";
import { HttpJourneySource } from "./sources/http.js";
import type { JourneySource, OperatorKey } from "./sources/types.js";
import { buildOnSearch, searchQueryFromRequest } from "./trv11/catalog.js";
import { buildPassOnSearch, isPassSearch } from "./trv11/pass.js";

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

function bearerTokenMatches(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const actual = request.headers.authorization;
  if (!actual) return false;
  const expected = `Bearer ${expectedToken}`;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
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

/**
 * What a test needs to hold still on the reserved path, and nothing a
 * deployment sets. The clock is injected because whether a hold is live and
 * which refund slab applies are decisions made against it, and no test should
 * have to wait ten real minutes to see one.
 */
export interface ReservedOverrides {
  source?: ReservedServiceSource;
  now?: () => Date;
  idFactory?: () => string;
}

export async function createApp(
  config: AppConfig,
  sourceOverrides: Partial<Record<OperatorKey, JourneySource>> = {},
  eventLogger: typeof logEvent = logEvent,
  reservedOverrides: ReservedOverrides = {},
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

  /**
   * The third path, and it is off unless a deployment asked for it. A second
   * domain means a second registry subscription and a second gateway routing
   * entry, neither of which an existing deployment has, so nothing here is
   * constructed while the flag is false: no database file is opened, no
   * migration runs, and the routes answer exactly the 404 they answered
   * before.
   */
  let reserved: ReservedHandler | undefined;
  let reservedStore: ReservedStore | undefined;
  if (config.reservedEnabled) {
    const reservedOperator = config.reservedOperators?.ksrtc;
    if (!reservedOperator) {
      throw new Error(
        "RESERVED_ENABLED is on and no KSRTC operator identity is configured",
      );
    }
    const reservedFixtures = await FixtureReservedSource.load(
      config.fixtureRoot,
      "ksrtc",
    );
    const reservedSource =
      reservedOverrides.source ??
      (config.reservedSource === "http"
        ? new HttpReservedSource({
            url: config.reservedSourceUrl!,
            fallback: reservedFixtures,
            responseSchemaPath: config.reservedSourceResponseSchema,
            eventLogger,
          })
        : reservedFixtures);
    reservedStore = new ReservedStore(
      openReservedDatabase({
        url: config.reservedDatabaseUrl,
        migrationRoot: config.reservedMigrationRoot,
      }),
      reservedOverrides.idFactory
        ? { idFactory: reservedOverrides.idFactory }
        : {},
    );
    reserved = createReservedHandler({
      orders: new ReservedOrderService(
        "ksrtc",
        reservedSource,
        reservedOperator,
        reservedStore,
        {
          publicBaseUrl: config.publicBaseUrl,
          reservation: config.reservation,
          ...(reservedOverrides.now ? { now: reservedOverrides.now } : {}),
          ...(reservedOverrides.idFactory
            ? { idFactory: reservedOverrides.idFactory }
            : {}),
        },
      ),
      validator: createReservedValidator(config.reservedSchemaRoot),
      runtime: reservedOperator,
      contextTtl: config.contextTtl,
      callbackTimeoutMs: config.callbackTimeoutMs,
      logEvent: eventLogger,
      ...(reservedOverrides.now ? { now: reservedOverrides.now } : {}),
    });
  }

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
          if (isPassSearch(search)) {
            // A pass catalogue is nine static items. It asks the journey
            // source nothing, because a pass has no route to plan and no stop
            // pair to price.
            return buildPassOnSearch(
              search,
              sources[operatorKey].operator,
              operatorKey,
              operator,
              {
                publicBaseUrl: config.publicBaseUrl,
                contextTtl: config.contextTtl,
              },
            );
          }
          const offers = await sources[operatorKey].search(
            searchQueryFromRequest(search),
          );
          orders[operatorKey].cacheCatalogue(search.context, offers);
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
      if (!(error instanceof OrderLifecycleError)) {
        eventLogger({
          transaction_id: request.context.transaction_id,
          message_id: request.context.message_id,
          action: onAction,
          subscriber_id: operator.subscriberId,
          operator: operatorKey,
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

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://provider.invalid");
    if (request.method === "GET" && url.pathname === "/") {
      json(response, 200, {
        service: "ondc-transit-bpp",
        description: "ONDC TRV11 BPP for Bengaluru transit (BMTC bus + BMRCL metro)",
        journeySource: config.journeySource,
        operators: Object.keys(sources),
        endpoints: {
          health: "GET /healthz",
          terms: "GET /terms",
          orders: "GET /orders/:orderId  (requires Bearer token)",
          bmtc: ["POST /bmtc/search", "POST /bmtc/select", "POST /bmtc/init", "POST /bmtc/confirm", "POST /bmtc/status", "POST /bmtc/inbound"],
          bmrcl: ["POST /bmrcl/search", "POST /bmrcl/select", "POST /bmrcl/init", "POST /bmrcl/confirm", "POST /bmrcl/status", "POST /bmrcl/inbound"],
          ...(reserved ? { ksrtc: reserved.endpoints } : {}),
        },
      });
      return;
    }
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
        ...(config.reservedEnabled
          ? {
              // The one policy in this repository that is the operator's own
              // published words rather than something it invented. Published
              // here because a cancellation quote names a slab code and a
              // rider is entitled to read what the code means.
              reservedCancellation: {
                notice:
                  "Deducted from the base fare. The reservation fee is not refunded in any slab and the toll is refunded in full in every slab.",
                slabs: [
                  { code: "OVER_72H", when: "more than 72 hours before departure", deductionPercent: 10 },
                  { code: "72H_TO_24H", when: "72 to 24 hours before departure", deductionPercent: 25 },
                  { code: "24H_TO_2H", when: "24 to 2 hours before departure", deductionPercent: 50 },
                  { code: "UNDER_2H", when: "less than 2 hours before departure, or after it", deductionPercent: 100 },
                ],
                quoteValidity: "PT2M",
                holdTtlSeconds: config.reservation.holdTtlSeconds,
                money:
                  "No money moves in this specimen. A refund figure is arithmetic, not a payment.",
              },
            }
          : {}),
      });
      return;
    }
    const orderMatch = url.pathname.match(/^\/orders\/([^/]+)$/);
    if (request.method === "GET" && orderMatch) {
      response.setHeader("cache-control", "no-store");
      if (!config.orderInspectionToken) {
        json(response, 404, { error: "Not found" });
        return;
      }
      if (!bearerTokenMatches(request, config.orderInspectionToken)) {
        response.setHeader("www-authenticate", "Bearer");
        json(response, 401, { error: "Unauthorized" });
        return;
      }
      let orderId: string;
      try {
        orderId = decodeURIComponent(orderMatch[1]);
      } catch {
        json(response, 400, { error: "Invalid order id encoding" });
        return;
      }
      // The reserved store is asked second and only when the in-memory one
      // has nothing, so an operator with one reference does not have to know
      // which category issued it. What comes back for a reserved booking
      // includes the passenger manifest, which makes leaving this endpoint
      // enabled on a shared host a more consequential decision than it was
      // when the only thing behind it was a specimen ticket.
      const order =
        store.inspect(orderId) ?? reservedStore?.inspect(orderId)?.order;
      json(response, order ? 200 : 404, order ?? { error: "Order not found" });
      return;
    }

    const reservedMatch = url.pathname.match(RESERVED_ROUTE);
    if (request.method === "POST" && reservedMatch) {
      if (!reserved) {
        json(response, 404, { error: "Not found" });
        return;
      }
      let reservedBody: unknown;
      try {
        reservedBody = await readJson(request);
      } catch (error) {
        json(
          response,
          400,
          nack(error instanceof Error ? error.message : "Invalid JSON"),
        );
        return;
      }
      await reserved.handle(
        reservedMatch[2],
        reservedBody,
        request,
        (status, payload) => json(response, status, payload),
      );
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
    if (action === "search" && !isPassSearch(protocolRequest as SearchRequest)) {
      const search = protocolRequest as SearchRequest;
      try {
        searchQueryFromRequest(search);
      } catch (error) {
        json(
          response,
          400,
          nack(error instanceof Error ? error.message : "Invalid search query"),
        );
        return;
      }
      const expectedCategory = sources[operatorKey].operator.vehicleCategory;
      const requestedCategory = search.message.intent.fulfillment?.vehicle?.category;
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

  // The reserved database outlives no server that closed. Nothing else in
  // this process holds an operating-system resource, which is why this is the
  // only hook of its kind here.
  server.on("close", () => reservedStore?.close());
  return server;
}
