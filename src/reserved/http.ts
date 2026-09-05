import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import { runsOn } from "./calendar.js";
import { validateReservedCatalogue } from "./integrity.js";
import type {
  FareTable,
  ReservedCatalogue,
  ReservedOperatorProfile,
  ReservedSearchQuery,
  ReservedService,
  ReservedServiceSource,
  SeatMap,
} from "./types.js";

/**
 * A reserved catalogue read over http, with the fixtures underneath it.
 *
 * The contract is published as a schema and a document so that any dataset can
 * satisfy it, including a harvested one built by another project entirely.
 * Neither repository depends on the other, and that is the point: this
 * provider is not a client of one particular dataset, it is a seller with a
 * pluggable source.
 *
 * **Inventory is never in the source.** A source supplies the static shape of
 * what is sellable: services, layouts, fares. Which seats are sold is decided
 * in this process, because a source that could answer that would be a source
 * with live operator inventory, which is exactly the thing nobody has.
 *
 * **The whole catalogue arrives at once, rather than a query at a time.** The
 * journey source next door asks per search because it asks a planner a
 * question about two points and an instant, and the answer is different every
 * time. This asks for a dataset: services, layouts and fares change on the
 * timescale of a data release, not of a request. Fetching the set once and
 * holding it for a short window also means a select and the confirm that
 * follows it are priced against the same catalogue, which a per-request fetch
 * could not promise.
 *
 * **A failure falls back to the fixtures and says so in the log.** Byte for
 * byte the behaviour the journey source already implements, and for the same
 * reason: a seller that answers nothing because a dataset service is down is
 * worse than a seller that answers from the data it shipped with, as long as
 * nobody can mistake which happened.
 */

export const HTTP_RESERVED_SOURCE_TIMEOUT_MS = 5_000;
/** How long a fetched catalogue is served before it is asked for again. */
export const HTTP_RESERVED_SOURCE_TTL_MS = 60_000;

type EventLogger = (fields: Record<string, unknown>) => void;

export interface HttpReservedSourceOptions {
  url: string;
  fallback: ReservedServiceSource & {
    allServices(): Promise<ReservedService[]>;
  };
  responseSchemaPath: string;
  timeoutMs?: number;
  cacheTtlMs?: number;
  fetchImpl?: typeof fetch;
  eventLogger?: EventLogger;
  now?: () => Date;
}

function compileResponseValidator(path: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(path, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

export class HttpReservedSource implements ReservedServiceSource {
  readonly operator: ReservedOperatorProfile;

  private readonly validateResponse: ValidateFunction;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly eventLogger: EventLogger;
  private readonly now: () => Date;
  private cached: { catalogue: ReservedCatalogue; fetchedAt: number } | undefined;

  constructor(private readonly options: HttpReservedSourceOptions) {
    this.operator = options.fallback.operator;
    this.validateResponse = compileResponseValidator(options.responseSchemaPath);
    this.timeoutMs = options.timeoutMs ?? HTTP_RESERVED_SOURCE_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? HTTP_RESERVED_SOURCE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.eventLogger = options.eventLogger ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  private async catalogue(): Promise<ReservedCatalogue | undefined> {
    const at = this.now().getTime();
    if (this.cached && at - this.cached.fetchedAt < this.cacheTtlMs) {
      return this.cached.catalogue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("HTTP reserved source timed out")),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(this.options.url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `HTTP reserved source returned ${response.status} ${response.statusText}`.trim(),
        );
      }
      const body: unknown = await response.json();
      if (!this.validateResponse(body)) {
        throw new Error(
          `HTTP reserved source response failed schema validation: ${JSON.stringify(
            this.validateResponse.errors ?? [],
          )}`,
        );
      }
      const catalogue = (body as { catalogue: ReservedCatalogue }).catalogue;
      // The same integrity check the fixtures pass at boot. A dataset that
      // resolves against the schema and not against itself would fail at the
      // first select, and this provider would rather refuse the data than
      // publish it.
      validateReservedCatalogue(catalogue, "HTTP reserved source response");
      this.cached = { catalogue, fetchedAt: at };
      return catalogue;
    } catch (error) {
      this.eventLogger({
        action: "reserved_source",
        operator: "ksrtc",
        source: "http",
        fallback_source: "fixture",
        outcome: "FALLBACK",
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  async services(query: ReservedSearchQuery): Promise<ReservedService[]> {
    const catalogue = await this.catalogue();
    if (!catalogue) return this.options.fallback.services(query);
    return structuredClone(
      catalogue.services.filter(
        (service) =>
          service.boardingPoints.some(
            (point) => point.townCode === query.fromTownCode,
          ) &&
          service.droppingPoints.some(
            (point) => point.townCode === query.toTownCode,
          ) &&
          (query.serviceClass === undefined ||
            service.serviceClass === query.serviceClass) &&
          runsOn(service.operatingPattern, query.travelDate),
      ),
    );
  }

  async service(serviceId: string): Promise<ReservedService | undefined> {
    const catalogue = await this.catalogue();
    if (!catalogue) return this.options.fallback.service(serviceId);
    const service = catalogue.services.find(
      (candidate) => candidate.serviceId === serviceId,
    );
    return service ? structuredClone(service) : undefined;
  }

  async seatMap(seatMapId: string): Promise<SeatMap | undefined> {
    const catalogue = await this.catalogue();
    if (!catalogue) return this.options.fallback.seatMap(seatMapId);
    const map = catalogue.seatMaps.find(
      (candidate) => candidate.seatMapId === seatMapId,
    );
    return map ? structuredClone(map) : undefined;
  }

  async fareTable(fareTableId: string): Promise<FareTable | undefined> {
    const catalogue = await this.catalogue();
    if (!catalogue) return this.options.fallback.fareTable(fareTableId);
    const table = catalogue.fareTables.find(
      (candidate) => candidate.fareTableId === fareTableId,
    );
    return table ? structuredClone(table) : undefined;
  }
}
