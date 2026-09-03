import type { OperatorRuntimeConfig } from "../config.js";
import type { OnSearchResponse, SearchRequest } from "../protocol/types.js";
import type {
  OperatorKey,
  OperatorProfile,
  ServiceTier,
} from "../sources/types.js";
import { fulfillmentIdForOffer, paiseToRupees, providerPayments } from "./catalog.js";
import { serviceInstant } from "./time.js";

/**
 * Passes: a fare for a period and a scope of service, not a fare for a stop
 * pair. `SPEC.md` section 2.2 named `PASS` as a real TRV11 item code and
 * declined it for phase one; this module implements it.
 *
 * Every price and every concession rate here is synthetic and derived. No
 * operator quotes a pass price or a concession rate to this software. The
 * derivations, their sourcing, and how unevenly grounded each number is are
 * set out in `docs/passes.md`, which is the disclosure this module's numbers
 * are only honest alongside.
 */

export type PassWindow = "DAY" | "WEEKLY" | "MONTHLY";
export type PassDuration = "P1D" | "P7D" | "P1M";
export type ConcessionClass = "SENIOR" | "STUDENT";

/**
 * A pass's scope is a class of service, and the nine published items scope to
 * exactly one each. "Bus and Metro" is deliberately not here: neither
 * operator sells the other's network, so a buyer app composes that from two
 * orders under one checkout id of its own.
 */
export type PassScope = ServiceTier;

export const CONCESSION_CLASSES: readonly ConcessionClass[] = ["SENIOR", "STUDENT"];

/** The category axis a pass search asks on, alongside the existing `TICKET`. */
export const PASS_CATEGORY_ID = "C2";
export const PASS_CATEGORY_CODE = "PASS";
export const TICKET_CATEGORY_ID = "C1";

/** `Item.descriptor.code`, parallel to the `SJT` this repo already issues. */
export const PASS_ITEM_CODE = "PASS";

/** `Fulfillment.type`, parallel to the existing `TRIP`. */
export const PASS_FULFILLMENT_TYPE = "PASS";

/**
 * The mark every rendered pass price has to carry. `docs/specs/passes.md` in
 * the Tatak repo calls its own equivalent `SYNTHETIC_PASS_MARK` and requires
 * that a caller cannot drop it; this is this repo's wording of the same mark,
 * published on the item so a client that only reads `on_search` still gets it.
 */
export const SYNTHETIC_PASS_MARK =
  "Modelled pass. The rules and the price are set by this specimen provider, not by BMTC or BMRCL.";

/**
 * Day price = `PASS_CEILING_MULTIPLE` x the scope's ceiling single fare,
 * chosen so a day pass pays for itself on the third full-length ride. This is
 * `docs/specs/passes.md`'s own derivation for `DAY_PASSES`, extended rather
 * than replaced.
 */
export const PASS_CEILING_MULTIPLE = 2.5;

/** Five weekday-equivalents; the two weekend days are the weekly pass's saving. */
export const WEEKLY_DAY_MULTIPLE = 5;

/**
 * OPEN CONSTANT, and the one most in need of the owner's sign-off after the
 * student concession rate. Proposed, not derived from anything BMTC has
 * stated, and less defensible than the day price's own multiple - the same
 * status `PASS_CEILING_MULTIPLE` had before it shipped. See `docs/passes.md`.
 */
export const MONTHLY_DAY_MULTIPLE = 18;

/**
 * Ceiling single fares the day price derives from, in paise. Bus figures are
 * Tatak's existing `BUS_FARES.ordinary.maxPaise` / `.ac.maxPaise`; the metro
 * figure is its metro fare ceiling. Synthetic like everything else here.
 */
export const CEILING_SINGLE_FARE_PAISE: Record<PassScope, number> = {
  ORDINARY_BUS: 3000,
  AC_BUS: 6000,
  METRO: 9000,
};

const WINDOW_MULTIPLE: Record<PassWindow, number> = {
  DAY: 1,
  WEEKLY: WEEKLY_DAY_MULTIPLE,
  MONTHLY: MONTHLY_DAY_MULTIPLE,
};

const WINDOW_DURATION: Record<PassWindow, PassDuration> = {
  DAY: "P1D",
  WEEKLY: "P7D",
  MONTHLY: "P1M",
};

const WINDOW_LABEL: Record<PassWindow, string> = {
  DAY: "day",
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};

const SCOPE_LABEL: Record<PassScope, string> = {
  ORDINARY_BUS: "Ordinary bus",
  AC_BUS: "AC bus",
  METRO: "Metro",
};

const SCOPE_OPERATOR: Record<PassScope, OperatorKey> = {
  ORDINARY_BUS: "bmtc",
  AC_BUS: "bmtc",
  METRO: "bmrcl",
};

/**
 * Senior rates trace to BMTC's passenger charter as reported in 2014: 25% off
 * a single fare, 10% off a monthly commuter pass. That source is eleven years
 * old, predates a roughly 15% BMTC fare rise in January 2025, and conflicts
 * with itself on whether the qualifying age is 60 or 65. Applying it to a
 * BMRCL metro item is an extrapolation with no metro-specific source at all.
 */
const SENIOR_DISCOUNT_PERCENT: Record<PassWindow, number> = {
  DAY: 25,
  WEEKLY: 25,
  MONTHLY: 10,
};

/**
 * A round number invented so the product exists. No source of any kind, weak
 * or otherwise - no current BMTC student pass price could be found from any
 * primary source. This needs the owner's sign-off more than any other
 * constant in this feature.
 */
const STUDENT_DISCOUNT_PERCENT = 33;

export interface PassCatalogueItem {
  /** The contract. A buyer app selects by this exact string. */
  id: string;
  operator: OperatorKey;
  window: PassWindow;
  scope: PassScope;
  duration: PassDuration;
  name: string;
  pricePaise: number;
  seniorDiscountPercent: number;
  studentDiscountPercent: number;
}

function dayPricePaise(scope: PassScope): number {
  // Kept in integer paise: the multiple is 2.5, so multiply by five and halve.
  const price = (CEILING_SINGLE_FARE_PAISE[scope] * 5) / 2;
  if (!Number.isSafeInteger(price)) {
    throw new Error(
      `Ceiling fare for ${scope} does not yield a whole-paise day pass price`,
    );
  }
  return price;
}

function passItem(window: PassWindow, scope: PassScope): PassCatalogueItem {
  const pricePaise = dayPricePaise(scope) * WINDOW_MULTIPLE[window];
  if (!Number.isSafeInteger(pricePaise)) {
    throw new Error(`Derived pass price for ${window}/${scope} is not a safe integer`);
  }
  return {
    id: `PASS-${window}-${scope}`,
    operator: SCOPE_OPERATOR[scope],
    window,
    scope,
    duration: WINDOW_DURATION[window],
    name: `${SCOPE_LABEL[scope]} ${WINDOW_LABEL[window]} pass`,
    pricePaise,
    seniorDiscountPercent: SENIOR_DISCOUNT_PERCENT[window],
    studentDiscountPercent: STUDENT_DISCOUNT_PERCENT,
  };
}

/**
 * The nine catalogue items, in the order the brief tabulates them: BMTC's six
 * (Ordinary and AC bus across three windows), then BMRCL's three (Metro).
 */
export const PASS_CATALOGUE: readonly PassCatalogueItem[] = [
  ...(["DAY", "WEEKLY", "MONTHLY"] as const).flatMap((window) =>
    (["ORDINARY_BUS", "AC_BUS"] as const).map((scope) => passItem(window, scope)),
  ),
  ...(["DAY", "WEEKLY", "MONTHLY"] as const).map((window) =>
    passItem(window, "METRO"),
  ),
];

const PASS_BY_ID = new Map(PASS_CATALOGUE.map((item) => [item.id, item]));

export function passCatalogueFor(operator: OperatorKey): PassCatalogueItem[] {
  return PASS_CATALOGUE.filter((item) => item.operator === operator);
}

export function isPassItemId(itemId: string): boolean {
  return PASS_BY_ID.has(itemId);
}

/**
 * Pass items are static constants, identical for every buyer and every
 * transaction, so they resolve without the per-transaction catalogue cache a
 * single-journey offer needs. A stop-pair offer is route-sliced and priced by
 * the journey source per search, which is why that path caches and this one
 * does not.
 */
export function passItemById(
  operator: OperatorKey,
  itemId: string,
): PassCatalogueItem | undefined {
  const item = PASS_BY_ID.get(itemId);
  return item?.operator === operator ? item : undefined;
}

/**
 * A higher class is honoured on a lower service, never the reverse - the same
 * class-based coverage rule Tatak's own fare model already applies. Metro
 * covers metro only; neither bus scope reaches it and it reaches neither of
 * them.
 */
export function passCovers(scope: PassScope, tier: ServiceTier): boolean {
  if (scope === "METRO" || tier === "METRO") return scope === tier;
  if (scope === "AC_BUS") return tier === "AC_BUS" || tier === "ORDINARY_BUS";
  return tier === "ORDINARY_BUS";
}

export function concessionRatePercent(
  item: PassCatalogueItem,
  concession: ConcessionClass,
): number {
  return concession === "SENIOR"
    ? item.seniorDiscountPercent
    : item.studentDiscountPercent;
}

/** `SENIOR_DISCOUNT_PERCENT` / `STUDENT_DISCOUNT_PERCENT`, as published on the item. */
export function concessionRateCode(concession: string): string {
  return `${concession}_DISCOUNT_PERCENT`;
}

/**
 * Discount for one unit, in paise. Both sides compute this from the rate
 * published on the item, so neither hard-codes a percentage. Every shipped
 * price is a whole number of rupees and every rate is a whole percent, so the
 * division is exact and no rounding convention is ever exercised - which is
 * what lets the two sides agree without having agreed on one.
 */
export function concessionDiscountPaise(
  pricePaise: number,
  percent: number,
): number {
  return Math.round((pricePaise * percent) / 100);
}

export function signedPaiseToRupees(paise: number): string {
  return paise < 0 ? `-${paiseToRupees(-paise)}` : paiseToRupees(paise);
}

/* ------------------------------------------------------------------ *
 * The validity window
 * ------------------------------------------------------------------ */

const INDIA_OFFSET_MILLISECONDS = 5.5 * 60 * 60 * 1000;

function istCalendarDay(atMilliseconds: number) {
  const shifted = new Date(atMilliseconds + INDIA_OFFSET_MILLISECONDS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

function istMidnightMilliseconds(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) - INDIA_OFFSET_MILLISECONDS;
}

function istMidnightIso(milliseconds: number): string {
  const { year, month, day } = istCalendarDay(milliseconds);
  const date = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  // `+05:30` rather than `Z`, so the calendar boundary this window is anchored
  // to is legible on the wire. `serviceInstant` already uses the same form.
  return `${date}T00:00:00.000+05:30`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export interface PassValidityWindow {
  validFrom: string;
  validTo: string;
  validFromMs: number;
  validToMs: number;
}

/**
 * The pass's own window, not the TOTP algorithm's concept of validity.
 *
 * `valid_from` is midnight in `Asia/Kolkata` on the day the pass was
 * confirmed, not the purchase instant, so a pass bought at 11pm does not read
 * as still valid at 10pm the next day. `valid_to` is that midnight advanced
 * by the item's own window and is exclusive - the instant the pass stops
 * being valid.
 *
 * A monthly window lands on the same day of the following month. Where that
 * day does not exist there - the 31st of January - it lands on the first of
 * the month after, so the pass covers the whole of the short month rather
 * than being cut off inside it or spilling past it.
 */
export function passValidityWindow(
  issuedAt: Date,
  window: PassWindow,
): PassValidityWindow {
  const issuedAtMs = issuedAt.getTime();
  if (!Number.isFinite(issuedAtMs)) {
    throw new Error("Pass validity window needs a valid issue instant");
  }
  const { year, month, day } = istCalendarDay(issuedAtMs);
  const validFromMs = istMidnightMilliseconds(year, month, day);
  let validToMs: number;
  if (window === "DAY") {
    validToMs = istMidnightMilliseconds(year, month, day + 1);
  } else if (window === "WEEKLY") {
    validToMs = istMidnightMilliseconds(year, month, day + 7);
  } else {
    const targetYear = month === 11 ? year + 1 : year;
    const targetMonth = (month + 1) % 12;
    validToMs =
      day <= daysInMonth(targetYear, targetMonth)
        ? istMidnightMilliseconds(targetYear, targetMonth, day)
        : istMidnightMilliseconds(targetYear, targetMonth + 1, 1);
  }
  return {
    validFrom: istMidnightIso(validFromMs),
    validTo: istMidnightIso(validToMs),
    validFromMs,
    validToMs,
  };
}

/* ------------------------------------------------------------------ *
 * Tags
 * ------------------------------------------------------------------ */

export function passInfoTag(item: PassCatalogueItem) {
  return {
    descriptor: { code: "PASS_INFO" },
    list: [
      { descriptor: { code: "WINDOW" }, value: item.window },
      { descriptor: { code: "SCOPE" }, value: item.scope },
    ],
  };
}

export function concessionInfoTag(item: PassCatalogueItem) {
  return {
    descriptor: { code: "CONCESSION_INFO" },
    display: false,
    list: [
      {
        descriptor: { code: "SENIOR_DISCOUNT_PERCENT" },
        value: String(item.seniorDiscountPercent),
      },
      {
        descriptor: { code: "STUDENT_DISCOUNT_PERCENT" },
        value: String(item.studentDiscountPercent),
      },
    ],
  };
}

export function syntheticPassTag() {
  return {
    descriptor: { code: "SYNTHETIC_PASS_INFO" },
    display: true,
    list: [{ descriptor: { code: "NOTICE" }, value: SYNTHETIC_PASS_MARK }],
  };
}

export function concessionTag(concession: ConcessionClass) {
  return {
    descriptor: { code: "CONCESSION" },
    display: false,
    list: [{ descriptor: { code: "CLASS" }, value: concession }],
  };
}

export function totpInfoTag(parameters: {
  algorithm: string;
  digits: number;
  periodSeconds: number;
}) {
  return {
    descriptor: { code: "TOTP_INFO" },
    display: false,
    list: [
      { descriptor: { code: "ALGORITHM" }, value: parameters.algorithm },
      { descriptor: { code: "DIGITS" }, value: String(parameters.digits) },
      {
        descriptor: { code: "PERIOD_SECONDS" },
        value: String(parameters.periodSeconds),
      },
    ],
  };
}

export function passFulfillment(item: PassCatalogueItem) {
  return {
    id: fulfillmentIdForOffer(item.id),
    type: PASS_FULFILLMENT_TYPE,
    // No stops, here or anywhere else on a pass. A pass names a period and a
    // scope, not a route between two places.
    tags: [passInfoTag(item)],
  };
}

/* ------------------------------------------------------------------ *
 * The pass search
 * ------------------------------------------------------------------ */

/**
 * A pass intent names a category and carries no `fulfillment` block at all -
 * no stops, because it asks about a category of products rather than a
 * journey between two points.
 */
export function isPassSearch(request: SearchRequest): boolean {
  return (
    request.message.intent.category?.descriptor?.code?.trim().toUpperCase() ===
    PASS_CATEGORY_CODE
  );
}

export function buildPassOnSearch(
  request: SearchRequest,
  profile: OperatorProfile,
  operatorKey: OperatorKey,
  operator: OperatorRuntimeConfig,
  options: { publicBaseUrl: string; contextTtl: string; now?: () => Date },
): OnSearchResponse {
  const now = options.now ?? (() => new Date());
  const items = passCatalogueFor(operatorKey);
  const timestamp = now().toISOString();
  const provider = {
    id: profile.id,
    descriptor: { name: profile.name },
    categories: [
      { id: TICKET_CATEGORY_ID, descriptor: { name: "Ticket", code: "TICKET" } },
      {
        id: PASS_CATEGORY_ID,
        descriptor: { name: "Pass", code: PASS_CATEGORY_CODE },
      },
    ],
    time: {
      range: {
        start: serviceInstant(
          request.context.timestamp,
          profile.serviceWindow.startHHMM,
        ),
        end: serviceInstant(
          request.context.timestamp,
          profile.serviceWindow.endHHMM,
        ),
      },
    },
    items: items.map((item) => ({
      id: item.id,
      category_ids: [PASS_CATEGORY_ID],
      descriptor: { name: item.name, code: PASS_ITEM_CODE },
      price: { currency: "INR", value: paiseToRupees(item.pricePaise) },
      quantity: { maximum: { count: 6 }, minimum: { count: 1 } },
      fulfillment_ids: [fulfillmentIdForOffer(item.id)],
      time: { label: "Validity", duration: item.duration, timestamp },
      tags: [passInfoTag(item), concessionInfoTag(item), syntheticPassTag()],
    })),
    fulfillments: items.map((item) => passFulfillment(item)),
    payments: providerPayments(options.publicBaseUrl),
  };

  return {
    context: {
      ...request.context,
      action: "on_search",
      bpp_id: operator.subscriberId,
      bpp_uri: operator.subscriberUri,
      timestamp,
      ttl: options.contextTtl,
    },
    message: {
      catalog: {
        descriptor: { name: `${profile.name} Specimen Pass Catalogue` },
        providers: items.length === 0 ? [] : [provider],
      },
    },
  };
}
