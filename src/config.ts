import { join } from "node:path";

import type { ReservedOperatorKey } from "./reserved/types.js";
import type { OperatorKey } from "./sources/types.js";

export interface OperatorRuntimeConfig {
  key: OperatorKey;
  subscriberId: string;
  subscriberUri: string;
  callbackUrl: string;
  callbackDelayMs: number;
}

/**
 * The dials the reserved intercity category needs before it can refuse a sale
 * or draw a seat map. All three are constants with a stated standing rather
 * than tuning knobs: two of them are the operator's own published figures, and
 * the third exists so that this repository's tests, a demo recording and a
 * stranger's first clone all draw the same coach.
 */
export interface ReservationConfig {
  /**
   * Reservations close this many minutes before departure. The conservative
   * end of the operator's own published 30-to-45 minute range: refusing a sale
   * this provider might have made costs nothing, and making one an operator
   * would have refused is the wrong error.
   */
  closeMinutes: number;
  /**
   * How far ahead a date can be booked. Matches the operator's own published
   * advance window, but the reason it is enforced here is a fidelity choice:
   * inventing a seat map for a date nobody could book yet is fabrication with
   * extra steps.
   */
  horizonDays: number;
  /**
   * The seed every occupancy draw is keyed through. Fixed by default, because
   * a seat map that differed between two clones would make a screenshot and a
   * golden file meaningless.
   */
  occupancySeed: number;
  /**
   * How long a hold lasts, absolutely, from the instant this provider takes
   * it. Ten minutes is twice the best-documented incumbent figure of five, and
   * the departure is deliberate: that five minutes covers a passenger form and
   * a payment, while this window covers a name, an age and a gender per seat,
   * six fields for a couple and twelve for a family of four, typed on a phone
   * by somebody who may be asking the person beside them for their age. There
   * is also no payment step here to fail fast and end the window early.
   *
   * The cost is bounded: on a thirty-berth sleeper, a ten-minute hold caps the
   * damage one abandoned session can do at 3.3% of the coach for a sixth of an
   * hour. If that trade is judged wrong, five minutes is the better default
   * and this constant is the one line that changes.
   */
  holdTtlSeconds: number;
  /**
   * How long a passenger name outlives its journey. The booking row survives,
   * because a rider needs to see that a journey happened; the names do not,
   * because nothing needs them once the coach has gone.
   */
  manifestRetentionDays: number;
}

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  journeySource: "fixture" | "http";
  journeySourceUrl?: string;
  journeySourceResponseSchema: string;
  fixtureRoot: string;
  schemaRoot: string;
  callbackTimeoutMs: number;
  contextTtl: string;
  orderInspectionToken?: string;
  operators: Record<OperatorKey, OperatorRuntimeConfig>;
  /**
   * A second domain is a second registry subscription and a second gateway
   * routing entry, neither of which an existing deployment has. The flag
   * defaults to false so a deployment that has not made those two changes
   * boots exactly as it did, and the operator block below is required only
   * once it is on.
   */
  reservedEnabled: boolean;
  reservedSchemaRoot: string;
  /**
   * Where held and booked seats live. One file beside the process by default,
   * and in memory under test. A held seat is a shared, finite resource rather
   * than a settled fact on somebody's phone, so it has to outlive a release.
   */
  reservedDatabaseUrl: string;
  reservedMigrationRoot: string;
  /**
   * Where the reserved catalogue comes from. The fixtures by default, so that
   * a stranger cloning this repository gets a working seller with nothing else
   * running; a dataset over http where one exists, with the fixtures still
   * underneath it as the fallback.
   */
  reservedSource: "fixture" | "http";
  reservedSourceUrl?: string;
  reservedSourceResponseSchema: string;
  reservedOperators?: Record<ReservedOperatorKey, OperatorRuntimeConfig>;
  reservation: ReservationConfig;
  /**
   * Where a confirm or a cancellation pushes the seat count that changed -
   * `transit-fleet-sim`'s `PUT`/`DELETE /fleet/manifest`. No default, on the
   * same reasoning `journeySourceUrl` and `reservedSourceUrl` already carry:
   * a hardcoded fallback would make a deployment that never set this dial
   * silently at a port nobody asked it to reach, rather than visibly not
   * publishing at all. Absent means the publisher this process builds is
   * inert - see `src/reserved/fleetManifest.ts`.
   */
  fleetManifestUrl?: string;
  /** `MANIFEST_TOKEN` on the simulator's side. No default, for the same reason. */
  fleetManifestToken?: string;
  /** The `ttlSeconds` sent on every push. See `FLEET_MANIFEST_TTL_SECONDS`. */
  fleetManifestTtlSeconds: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integerInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function optionalIntegerInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

/** Heroku sets `PORT`; local compose and the Dockerfile use `PROVIDER_PORT`. */
function resolveProviderPort(env: NodeJS.ProcessEnv): number {
  const merged: NodeJS.ProcessEnv = env.PORT?.trim()
    ? { ...env, PROVIDER_PORT: env.PORT }
    : env;
  return integerInRange(merged, "PROVIDER_PORT", 0, 65_535);
}

function parseHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string): string {
  return parseHttpUrl(required(env, name), name);
}

/**
 * The default occupancy seed. A fixed constant rather than a random one so
 * that the repository's own tests, a demo recording and a stranger's first
 * clone all draw the same coach on the same date.
 */
export const DEFAULT_SEAT_OCCUPANCY_SEED = 20_260_905;

function operatorRuntimeConfig(
  env: NodeJS.ProcessEnv,
  key: OperatorKey | ReservedOperatorKey,
  prefix: string,
): OperatorRuntimeConfig {
  return {
    key,
    subscriberId: required(env, `${prefix}_BPP_ID`),
    subscriberUri: httpUrl(env, `${prefix}_BPP_URI`),
    callbackUrl: httpUrl(env, `${prefix}_CALLBACK_URL`),
    callbackDelayMs: integerInRange(
      env,
      `${prefix}_CALLBACK_DELAY_MS`,
      0,
      2_147_483_647,
    ),
  } as OperatorRuntimeConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const journeySource = env.JOURNEY_SOURCE?.trim() || "fixture";
  if (journeySource !== "fixture" && journeySource !== "http") {
    throw new Error(`Unsupported JOURNEY_SOURCE ${journeySource}`);
  }
  const journeySourceUrl = env.JOURNEY_SOURCE_URL?.trim();
  const orderInspectionToken = env.ORDER_INSPECTION_TOKEN?.trim();
  if (journeySource === "http" && !journeySourceUrl) {
    throw new Error("Missing required environment variable JOURNEY_SOURCE_URL");
  }
  if (journeySourceUrl) {
    parseHttpUrl(journeySourceUrl, "JOURNEY_SOURCE_URL");
  }
  const reservedEnabled = (env.RESERVED_ENABLED?.trim() || "false") === "true";
  const reservedSource = env.RESERVED_SOURCE?.trim() || "fixture";
  if (reservedSource !== "fixture" && reservedSource !== "http") {
    throw new Error(`Unsupported RESERVED_SOURCE ${reservedSource}`);
  }
  const reservedSourceUrl = env.RESERVED_SOURCE_URL?.trim();
  if (reservedSource === "http" && !reservedSourceUrl) {
    throw new Error("Missing required environment variable RESERVED_SOURCE_URL");
  }
  if (reservedSourceUrl) parseHttpUrl(reservedSourceUrl, "RESERVED_SOURCE_URL");
  // Unlike JOURNEY_SOURCE_URL and RESERVED_SOURCE_URL, there is no mode flag
  // that makes this one required: a manifest push is best-effort by nature
  // (see fleetManifest.ts), so its absence is never an error, only silence.
  const fleetManifestUrl = env.FLEET_MANIFEST_URL?.trim();
  if (fleetManifestUrl) parseHttpUrl(fleetManifestUrl, "FLEET_MANIFEST_URL");
  const fleetManifestToken = env.FLEET_MANIFEST_TOKEN?.trim();
  return {
    host: required(env, "PROVIDER_HOST"),
    port: resolveProviderPort(env),
    publicBaseUrl: httpUrl(env, "PROVIDER_PUBLIC_BASE_URL"),
    journeySource,
    ...(journeySourceUrl ? { journeySourceUrl } : {}),
    journeySourceResponseSchema:
      env.JOURNEY_SOURCE_RESPONSE_SCHEMA ??
      join(process.cwd(), "schemas", "journey-source-response.json"),
    fixtureRoot: env.FIXTURE_ROOT ?? join(process.cwd(), "fixtures"),
    schemaRoot:
      env.TRV11_SCHEMA_ROOT ??
      join(process.cwd(), "schemas", "ondc_trv11", "2.0.1"),
    callbackTimeoutMs: integerInRange(
      env,
      "CALLBACK_TIMEOUT_MS",
      1,
      2_147_483_647,
    ),
    contextTtl: required(env, "CONTEXT_TTL"),
    ...(orderInspectionToken ? { orderInspectionToken } : {}),
    operators: {
      bmtc: {
        key: "bmtc",
        subscriberId: required(env, "BMTC_BPP_ID"),
        subscriberUri: httpUrl(env, "BMTC_BPP_URI"),
        callbackUrl: httpUrl(env, "BMTC_CALLBACK_URL"),
        callbackDelayMs: integerInRange(
          env,
          "BMTC_CALLBACK_DELAY_MS",
          0,
          2_147_483_647,
        ),
      },
      bmrcl: {
        key: "bmrcl",
        subscriberId: required(env, "BMRCL_BPP_ID"),
        subscriberUri: httpUrl(env, "BMRCL_BPP_URI"),
        callbackUrl: httpUrl(env, "BMRCL_CALLBACK_URL"),
        callbackDelayMs: integerInRange(
          env,
          "BMRCL_CALLBACK_DELAY_MS",
          0,
          2_147_483_647,
        ),
      },
    },
    reservedEnabled,
    reservedSchemaRoot:
      env.RESERVED_SCHEMA_ROOT ??
      join(process.cwd(), "schemas", "transit_local_intercity", "0.1.0"),
    reservedDatabaseUrl:
      env.RESERVED_DB_URL?.trim() || `file:${join(process.cwd(), "data", "reserved.db")}`,
    reservedMigrationRoot:
      env.RESERVED_MIGRATION_ROOT ?? join(process.cwd(), "migrations", "reserved"),
    reservedSource,
    ...(reservedSourceUrl ? { reservedSourceUrl } : {}),
    reservedSourceResponseSchema:
      env.RESERVED_SOURCE_RESPONSE_SCHEMA ??
      join(process.cwd(), "schemas", "reserved-source-response.json"),
    ...(reservedEnabled
      ? {
          reservedOperators: {
            ksrtc: operatorRuntimeConfig(env, "ksrtc", "KSRTC"),
          },
        }
      : {}),
    reservation: {
      closeMinutes: optionalIntegerInRange(
        env,
        "RESERVATION_CLOSE_MINUTES",
        0,
        1_440,
        45,
      ),
      horizonDays: optionalIntegerInRange(
        env,
        "RESERVATION_HORIZON_DAYS",
        1,
        365,
        30,
      ),
      occupancySeed: optionalIntegerInRange(
        env,
        "SEAT_OCCUPANCY_SEED",
        0,
        2_147_483_647,
        DEFAULT_SEAT_OCCUPANCY_SEED,
      ),
      holdTtlSeconds: optionalIntegerInRange(
        env,
        "RESERVATION_HOLD_TTL_SECONDS",
        30,
        3_600,
        600,
      ),
      manifestRetentionDays: optionalIntegerInRange(
        env,
        "RESERVED_MANIFEST_RETENTION_DAYS",
        1,
        3_650,
        30,
      ),
    },
    ...(fleetManifestUrl ? { fleetManifestUrl } : {}),
    ...(fleetManifestToken ? { fleetManifestToken } : {}),
    // Matches transit-fleet-sim's own INTERCITY_MANIFEST_MAX_AGE_SECONDS
    // default (docs/intercity-coaches.md §12.8): this provider pushes fresh
    // on every change, so the two only need to agree on an order of
    // magnitude, not be pinned together.
    fleetManifestTtlSeconds: optionalIntegerInRange(
      env,
      "FLEET_MANIFEST_TTL_SECONDS",
      1,
      86_400,
      3_600,
    ),
  };
}
