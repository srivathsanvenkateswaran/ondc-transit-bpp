import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import type {
  JourneySource,
  OperatorKey,
  SearchQuery,
  TransitOffer,
} from "./types.js";
import { validateOfferSet } from "./validate.js";

export const HTTP_JOURNEY_SOURCE_TIMEOUT_MS = 5_000;

type EventLogger = (fields: Record<string, unknown>) => void;

export interface HttpJourneySourceOptions {
  operatorKey: OperatorKey;
  url: string;
  fallback: JourneySource;
  responseSchemaPath: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  eventLogger?: EventLogger;
  now?: () => Date;
}

interface JourneySourceResponse {
  offers: TransitOffer[];
}

function endpoint(
  code: string | undefined,
  gps: { lat: number; lon: number } | undefined,
): Record<string, string | number> {
  return {
    ...(code ? { code } : {}),
    ...(gps ? { lat: gps.lat, lon: gps.lon } : {}),
  };
}

function compileResponseValidator(path: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

export class HttpJourneySource implements JourneySource {
  readonly operator;

  private readonly validateResponse: ValidateFunction;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly eventLogger: EventLogger;
  private readonly now: () => Date;

  constructor(private readonly options: HttpJourneySourceOptions) {
    this.operator = options.fallback.operator;
    this.validateResponse = compileResponseValidator(options.responseSchemaPath);
    this.timeoutMs = options.timeoutMs ?? HTTP_JOURNEY_SOURCE_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.eventLogger = options.eventLogger ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  async search(query: SearchQuery): Promise<TransitOffer[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("HTTP journey source timed out")),
      this.timeoutMs,
    );

    try {
      const response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operator: this.options.operatorKey,
          from: endpoint(query.fromCode, query.fromGps),
          to: endpoint(query.toCode, query.toGps),
          departAt: query.departAt ?? this.now().toISOString(),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP journey source returned ${response.status} ${response.statusText}`.trim(),
        );
      }

      const body: unknown = await response.json();
      if (!this.validateResponse(body)) {
        throw new Error(
          `HTTP journey source response failed schema validation: ${JSON.stringify(
            this.validateResponse.errors ?? [],
          )}`,
        );
      }
      const offers = (body as JourneySourceResponse).offers;
      validateOfferSet(offers, "HTTP journey source response");
      return structuredClone(offers);
    } catch (error) {
      this.eventLogger({
        action: "journey_source",
        operator: this.options.operatorKey,
        source: "http",
        fallback_source: "fixture",
        outcome: "FALLBACK",
        reason: error instanceof Error ? error.message : String(error),
      });
      return this.options.fallback.search(query);
    } finally {
      clearTimeout(timeout);
    }
  }
}
