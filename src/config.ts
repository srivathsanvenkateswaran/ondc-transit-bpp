import { join } from "node:path";

import type { OperatorKey } from "./sources/types.js";

export interface OperatorRuntimeConfig {
  key: OperatorKey;
  subscriberId: string;
  subscriberUri: string;
  callbackUrl: string;
  callbackDelayMs: number;
}

export interface AppConfig {
  host: string;
  port: number;
  publicBaseUrl: string;
  journeySource: "fixture";
  fixtureRoot: string;
  schemaRoot: string;
  callbackTimeoutMs: number;
  contextTtl: string;
  operators: Record<OperatorKey, OperatorRuntimeConfig>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const journeySource = env.JOURNEY_SOURCE?.trim() || "fixture";
  if (journeySource !== "fixture") {
    throw new Error(`Unsupported JOURNEY_SOURCE ${journeySource}`);
  }
  return {
    host: required(env, "PROVIDER_HOST"),
    port: positiveInteger(env, "PROVIDER_PORT"),
    publicBaseUrl: required(env, "PROVIDER_PUBLIC_BASE_URL"),
    journeySource,
    fixtureRoot: env.FIXTURE_ROOT ?? join(process.cwd(), "fixtures"),
    schemaRoot:
      env.TRV11_SCHEMA_ROOT ??
      join(process.cwd(), "schemas", "ondc_trv11", "2.0.1"),
    callbackTimeoutMs: positiveInteger(env, "CALLBACK_TIMEOUT_MS"),
    contextTtl: required(env, "CONTEXT_TTL"),
    operators: {
      bmtc: {
        key: "bmtc",
        subscriberId: required(env, "BMTC_BPP_ID"),
        subscriberUri: required(env, "BMTC_BPP_URI"),
        callbackUrl: required(env, "BMTC_CALLBACK_URL"),
        callbackDelayMs: positiveInteger(env, "BMTC_CALLBACK_DELAY_MS"),
      },
      bmrcl: {
        key: "bmrcl",
        subscriberId: required(env, "BMRCL_BPP_ID"),
        subscriberUri: required(env, "BMRCL_BPP_URI"),
        callbackUrl: required(env, "BMRCL_CALLBACK_URL"),
        callbackDelayMs: positiveInteger(env, "BMRCL_CALLBACK_DELAY_MS"),
      },
    },
  };
}
