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
  journeySource: "fixture" | "http";
  journeySourceUrl?: string;
  journeySourceResponseSchema: string;
  fixtureRoot: string;
  schemaRoot: string;
  callbackTimeoutMs: number;
  contextTtl: string;
  orderInspectionToken?: string;
  operators: Record<OperatorKey, OperatorRuntimeConfig>;
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
  return {
    host: required(env, "PROVIDER_HOST"),
    port: integerInRange(env, "PROVIDER_PORT", 0, 65_535),
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
  };
}
