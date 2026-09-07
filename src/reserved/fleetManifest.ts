/**
 * The manifest egress: this provider pushes, `transit-fleet-sim` never pulls.
 *
 * `docs/intercity-coaches.md` §7.4 (in the sibling repository) draws the
 * direction and the reason: the simulator has no scheduler and no way to know
 * which duties have bookings, while a `confirm` that succeeds and a
 * cancellation that completes are both events this provider already knows
 * about the instant they happen. So this module is the only place in this
 * repository that calls out to that service, and it calls out exactly twice -
 * `PUT` on a change to what is booked, `DELETE` when nothing is booked at all.
 *
 * **A push failure must never fail a booking.** A rider's seat is sold the
 * moment `ReservedStore.confirmBooking` commits; the fleet simulator finding
 * out about it is a courtesy to a coach's manifest, not a condition of the
 * sale. So every method here resolves rather than rejects, and a failure is
 * reported through `eventLogger` and nowhere else. The simulator's own
 * `intercity-coaches.md` §7.6 already describes the case where nothing
 * arrives: the manifest it holds ages out on its own clock, and it publishes
 * nothing rather than a guess. That is exactly the state a failed push here
 * leaves it in, and it is a state that document already treats as ordinary.
 */

import { seededOccupancy } from "./occupancy.js";
import type { LiveSeatClaim } from "./store.js";
import type { ReservedService, SeatMap } from "./types.js";

export interface ManifestSeatCounts {
  readonly total: number;
  readonly booked: number;
  readonly held: number;
  readonly simulated: number;
}

export interface FleetManifestPushInput {
  readonly serviceId: string;
  readonly travelDate: string;
  readonly seats: ManifestSeatCounts;
  readonly asOf: Date;
}

export interface FleetManifestClearInput {
  readonly serviceId: string;
  readonly travelDate: string;
}

/**
 * What the rest of this provider needs from the egress, and nothing about how
 * it is carried. `ReservedOrderService` is written against this and never
 * against `fetch` directly, on the same reasoning `HttpReservedSource` already
 * follows for the ingress next door.
 */
export interface FleetManifestPublisher {
  publish(input: FleetManifestPushInput): Promise<void>;
  clear(input: FleetManifestClearInput): Promise<void>;
}

/**
 * The default-off case. No `FLEET_MANIFEST_URL` configured means this
 * provider has nowhere to send a push, and the honest behaviour is silence,
 * not a guess at a port nobody asked it to dial. Constructed once, at boot,
 * and it says so exactly once rather than on every booking - see
 * `src/app.ts`.
 */
export class InertFleetManifestPublisher implements FleetManifestPublisher {
  async publish(): Promise<void> {}
  async clear(): Promise<void> {}
}

export type FleetManifestEventLogger = (fields: Record<string, unknown>) => void;

export const FLEET_MANIFEST_TIMEOUT_MS = 5_000;

export interface HttpFleetManifestPublisherOptions {
  /** The simulator's own base URL, e.g. `http://localhost:8080`. No default - see `src/config.ts`. */
  url: string;
  /** `MANIFEST_TOKEN` on the simulator's side. Sent as a bearer credential. */
  token: string;
  /**
   * How long a pushed count is allowed to stand before the simulator expires
   * it on its own clock (`INTERCITY_MANIFEST_TTL_MAX_SECONDS`, default a day).
   * This provider pushes on every change, so the ceiling only matters if this
   * provider itself goes dark; it is not a polling interval.
   */
  ttlSeconds: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  eventLogger?: FleetManifestEventLogger;
}

/**
 * The real egress, over HTTP, straight at `PUT`/`DELETE /fleet/manifest`.
 *
 * Mirrors `HttpReservedSource`'s shape - an injectable `fetchImpl` and clock,
 * a bounded timeout, and every failure caught and logged rather than thrown -
 * because the two are the same kind of seam: a call to a peer service that
 * this provider must survive losing.
 */
export class HttpFleetManifestPublisher implements FleetManifestPublisher {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly eventLogger: FleetManifestEventLogger;

  constructor(private readonly options: HttpFleetManifestPublisherOptions) {
    this.timeoutMs = options.timeoutMs ?? FLEET_MANIFEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.eventLogger = options.eventLogger ?? (() => undefined);
  }

  async publish(input: FleetManifestPushInput): Promise<void> {
    await this.send("PUT", "publish", input.serviceId, input.travelDate, {
      serviceId: input.serviceId,
      travelDate: input.travelDate,
      seats: input.seats,
      asOf: input.asOf.toISOString(),
      ttlSeconds: this.options.ttlSeconds,
    });
  }

  async clear(input: FleetManifestClearInput): Promise<void> {
    const url = new URL("/fleet/manifest", this.options.url);
    url.searchParams.set("service", input.serviceId);
    url.searchParams.set("date", input.travelDate);
    await this.send("DELETE", "clear", input.serviceId, input.travelDate, undefined, url);
  }

  private async send(
    method: "PUT" | "DELETE",
    action: "publish" | "clear",
    serviceId: string,
    travelDate: string,
    body: unknown,
    url: URL = new URL("/fleet/manifest", this.options.url),
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Fleet manifest push timed out")),
      this.timeoutMs,
    );
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Fleet manifest ${action} returned ${response.status} ${response.statusText}`.trim(),
        );
      }
    } catch (error) {
      // A rider's seat is already sold; the simulator finding out is not a
      // condition of that sale. §7.6 already treats a manifest that never
      // arrives as ordinary, so this is reported, not retried and not thrown.
      this.eventLogger({
        action: "fleet_manifest_publish",
        outcome: "FAILED",
        method: action,
        serviceId,
        travelDate,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Everything needed to compute one push's seat counts. */
export interface ManifestSeatCountInputs {
  readonly service: Pick<ReservedService, "serviceId" | "popularity" | "serviceClass">;
  readonly seatMap: SeatMap;
  readonly travelDate: string;
  readonly occupancySeed: number;
}

/**
 * The split section 7.4 asks for, computed from this provider's own state and
 * nothing borrowed from a request.
 *
 * `booked` and `held` come from `claims`, which the caller reads fresh from
 * `ReservedStore.liveClaims` after the mutation that triggered this push has
 * already committed - never from a count carried over from before it. `total`
 * is the seat map's own capacity and `simulated` is the same seeded set
 * `occupancy.ts` already computes for the catalogue and the seat lock rule;
 * recomputing it here rather than threading it through keeps this function
 * free of anything but its own inputs, which is what makes it worth testing
 * on its own (`occupancy.ts`'s header: never a coin flip per seat, never a
 * fresh roll per request - the seed and the inputs are the only source of
 * variation, exactly as they are here).
 */
export function manifestSeatCounts(
  input: ManifestSeatCountInputs,
  claims: readonly Pick<LiveSeatClaim, "state">[],
): ManifestSeatCounts {
  return {
    total: input.seatMap.seats.length,
    booked: claims.filter((claim) => claim.state === "BOOKED").length,
    held: claims.filter((claim) => claim.state === "HELD").length,
    simulated: seededOccupancy(
      input.service,
      input.seatMap,
      input.travelDate,
      input.occupancySeed,
    ).size,
  };
}
