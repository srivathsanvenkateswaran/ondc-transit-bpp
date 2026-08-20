import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { AppConfig } from "./config.js";
import { ack, nack } from "./protocol/ack.js";
import { dispatchCallback } from "./protocol/dispatch.js";
import type { SearchRequest } from "./protocol/types.js";
import { createProtocolValidator } from "./protocol/validate.js";
import { FixtureJourneySource } from "./sources/fixture.js";
import type { JourneySource, OperatorKey } from "./sources/types.js";
import { buildOnSearch } from "./trv11/catalog.js";
import { logEvent } from "./log.js";

const MAX_BODY_BYTES = 1_048_576;

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

export async function createApp(
  config: AppConfig,
  sourceOverrides: Partial<Record<OperatorKey, JourneySource>> = {},
) {
  const validator = createProtocolValidator(config.schemaRoot);
  const sources: Record<OperatorKey, JourneySource> = {
    bmtc:
      sourceOverrides.bmtc ??
      (await FixtureJourneySource.load(config.fixtureRoot, "bmtc")),
    bmrcl:
      sourceOverrides.bmrcl ??
      (await FixtureJourneySource.load(config.fixtureRoot, "bmrcl")),
  };

  async function answerSearch(operatorKey: OperatorKey, request: SearchRequest) {
    const operator = config.operators[operatorKey];
    try {
      const callback = await buildOnSearch(request, sources[operatorKey], operator, {
        publicBaseUrl: config.publicBaseUrl,
        contextTtl: config.contextTtl,
      });
      const validation = validator.onSearch(callback);
      if (!validation.valid) {
        throw new Error(`Generated on_search failed schema validation: ${JSON.stringify(validation.errors)}`);
      }
      await sleep(operator.callbackDelayMs);
      await dispatchCallback(
        operator.callbackUrl,
        callback,
        config.callbackTimeoutMs,
      );
      logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: "on_search",
        subscriber_id: operator.subscriberId,
        operator: operatorKey,
        outcome: "ACK",
        offers: callback.message.catalog.providers.length,
      });
    } catch (error) {
      logEvent({
        transaction_id: request.context.transaction_id,
        message_id: request.context.message_id,
        action: "on_search",
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

    const match = url.pathname.match(/^\/(bmtc|bmrcl)\/search$/);
    if (request.method !== "POST" || !match) {
      json(response, 404, { error: "Not found" });
      return;
    }

    const operatorKey = match[1] as OperatorKey;
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (error) {
      json(response, 400, nack(error instanceof Error ? error.message : "Invalid JSON"));
      return;
    }

    const validation = validator.search(body);
    if (!validation.valid) {
      json(response, 400, nack("Search payload failed TRV11 validation", validation.errors));
      return;
    }

    const search = body as SearchRequest;
    const expectedCategory = sources[operatorKey].operator.vehicleCategory;
    const requestedCategory = search.message.intent.fulfillment.vehicle?.category;
    if (requestedCategory && requestedCategory !== expectedCategory) {
      json(response, 202, ack);
      return;
    }

    json(response, 202, ack);
    logEvent({
      transaction_id: search.context.transaction_id,
      message_id: search.context.message_id,
      action: "search",
      subscriber_id: config.operators[operatorKey].subscriberId,
      operator: operatorKey,
      outcome: "ACK",
    });
    void answerSearch(operatorKey, search);
  });
}
