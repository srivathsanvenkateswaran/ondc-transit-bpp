import { stopInstant } from "./calendar.js";
import {
  RESERVED_CATEGORY_CODE,
  RESERVED_CATEGORY_ID,
  RESERVED_FULFILLMENT_TYPE,
  RESERVED_ITEM_CODE,
  RESERVED_VEHICLE_CATEGORY,
  SIMULATED_INVENTORY_MARK,
  SPECIMEN_NOTICE,
  reservedFulfillmentId,
  reservedItemId,
  type SeatState,
} from "./domain.js";
import { ReservedLifecycleError } from "./errors.js";
import type { BoardingPair } from "./fares.js";
import { paiseToRupees } from "./money.js";
import type {
  BoardingPoint,
  ReservedSearchQuery,
  ReservedService,
  ServiceClass,
  SourcingLabel,
} from "./types.js";

/**
 * The catalogue, and every tag this category puts on a wire.
 *
 * Two shaping decisions are worth reading before the code.
 *
 * **The rider never sees a corporation.** `OPERATOR_DISCLOSURE` carries the
 * brand and nothing else. An earlier draft of the specification published the
 * operating corporation here on the argument that no consumer surface
 * discloses it; the owner ruled that the rider has no decision to make with
 * it, and the fact moved to a ledger this provider keeps rather than a screen
 * a buyer app draws. Nothing in this file reads a settlement column, and a
 * test asserts as much.
 *
 * **The seats-remaining count is published quietly.** It is an integer and
 * nothing else: no low-stock flag, no threshold, no percentage. Publishing the
 * number is this provider's job and refusing to dress it as urgency is the
 * client's, so the wire carries nothing that would encourage the dressing.
 */

/** What a rider is told they are buying. */
const SERVICE_CLASS_NAMES: Record<ServiceClass, string> = {
  RAJAHAMSA: "Rajahamsa Executive",
  AIRAVAT: "Airavat",
  AIRAVAT_CLUB: "Airavat Club Class",
  PALLAKKI: "Pallakki non-AC sleeper",
  AMBAARI_UTSAV: "Ambaari Utsav",
};

export interface TagEntry {
  descriptor: { code: string };
  value: string;
}

export interface Tag {
  descriptor: { code: string };
  display?: boolean;
  list: TagEntry[];
}

function tag(code: string, display: boolean, list: TagEntry[]): Tag {
  return { descriptor: { code }, display, list };
}

function entry(code: string, value: string): TagEntry {
  return { descriptor: { code }, value };
}

export function serviceInfoTag(
  service: ReservedService,
  travelDate: string,
): Tag {
  return tag("SERVICE_INFO", true, [
    entry("SERVICE_ID", service.serviceId),
    entry("SERVICE_NUMBER", service.serviceNumber),
    entry("TRAVEL_DATE", travelDate),
    entry("SERVICE_CLASS", service.serviceClass),
    entry("RUNNING_MINUTES", String(service.runningMinutes)),
  ]);
}

/**
 * The pair the price beside it was computed for.
 *
 * Without this a buyer app cannot tell a genuine internal inconsistency from
 * an ordinary consequence of the fare key. The catalogue price is for the
 * whole run; a quote is for the pair the rider chose, and a different pair is
 * a different fare. A consistency check that did not know the basis would fire
 * on every rider who boards somewhere other than the terminus, and a false
 * alarm on a fare screen trains riders to ignore a real one.
 */
export function pricedForTag(pair: BoardingPair, sourcing: SourcingLabel): Tag {
  return tag("PRICED_FOR", false, [
    entry("FROM_BOARDING_POINT_ID", pair.fromBoardingPointId),
    entry("TO_BOARDING_POINT_ID", pair.toBoardingPointId),
    // Per cell rather than per table, so that an interpolated fare cannot be
    // laundered into a sourced one by a label further up.
    entry("FARE_SOURCING", sourcing),
  ]);
}

export function serviceProvenanceTag(service: ReservedService): Tag {
  return tag("SERVICE_PROVENANCE", false, [
    entry("BASIS", service.provenance),
    // What makes `confirmed` auditable rather than asserted.
    entry("SOURCE_COUNT", String(service.provenanceSourceCount)),
  ]);
}

/**
 * The brand, and only the brand.
 *
 * `CORPORATION` and `CORPORATION_BASIS` were retired outright rather than made
 * conditional on being known. The tag's name is now wider than what it
 * carries, and renaming it is left alone deliberately: the guard that keeps
 * the ruling from regressing checks for the absence of the two fields rather
 * than for a particular tag name.
 */
export function operatorDisclosureTag(service: ReservedService): Tag {
  return tag("OPERATOR_DISCLOSURE", true, [entry("BRAND", service.brand)]);
}

export function simulatedInventoryTag(): Tag {
  return tag("SIMULATED_INVENTORY", true, [
    entry("NOTICE", SIMULATED_INVENTORY_MARK),
  ]);
}

export function specimenTag(notice: string = SPECIMEN_NOTICE): Tag {
  return tag("SPECIMEN_INFO", true, [entry("NOTICE", notice)]);
}

export function seatMapRefTag(seatMapId: string): Tag {
  return tag("SEAT_MAP_REF", false, [entry("SEAT_MAP_ID", seatMapId)]);
}

/**
 * Every seat and its state, both decks in one payload.
 *
 * Returning one deck per call would force a tab-per-deck seat map on the
 * client, which the incumbent's own funnel data makes the lowest-converting
 * step in the entire booking flow: riders pick a berth in one tab, browse the
 * other and lose track of the first. Whether a client draws a toggle is its
 * decision; this shape makes a stacked view possible without a second round
 * trip.
 */
export function seatMapTag(
  seatMapId: string,
  states: Map<string, SeatState>,
): Tag {
  return tag("SEAT_MAP", false, [
    entry("SEAT_MAP_ID", seatMapId),
    ...[...states].map(([seatId, state]) => entry(seatId, state)),
  ]);
}

export function holdInfoTag(hold: {
  holdId: string;
  expiresAt: number;
  ttlSeconds: number;
}): Tag {
  return tag("HOLD_INFO", true, [
    entry("HOLD_ID", hold.holdId),
    // Absolute and authoritative. A client whose device clock is wrong shows a
    // wrong countdown and is still accepted or refused correctly, because the
    // decision is made here against this provider's own clock.
    entry("EXPIRES_AT", new Date(hold.expiresAt).toISOString()),
    // Published only so a client can write "held for ten minutes" without
    // subtracting two instants. It is never the thing counted against.
    entry("TTL_SECONDS", String(hold.ttlSeconds)),
  ]);
}

export function seatsTag(seatIds: string[]): Tag {
  return tag(
    "SEATS",
    false,
    seatIds.map((seatId) => entry("SEAT_ID", seatId)),
  );
}

export function bookingRefTag(reference: string): Tag {
  return tag("BOOKING_REF", true, [entry("NUMBER", reference)]);
}

/**
 * The two fields a vehicle join needs, and nothing else.
 *
 * This provider never invents a plate and never names a vehicle. Which coach
 * runs a service on a date is a question about a fleet, and the fleet is
 * somebody else's simulation to answer. A ticket that named a registration
 * number this provider chose would be asserting a vehicle assignment nobody
 * made, and a real ticket does not carry one either.
 */
export function vehicleLookupTag(service: ReservedService, travelDate: string): Tag {
  return tag("VEHICLE_LOOKUP", false, [
    entry("SERVICE_ID", service.serviceId),
    entry("TRAVEL_DATE", travelDate),
  ]);
}

export function refundSlabTag(quote: {
  slabCode: string;
  slabPercent: number;
  quoteId: string;
  quoteExpiresAt: number;
}): Tag {
  return tag("REFUND_SLAB", true, [
    entry("SLAB_CODE", quote.slabCode),
    entry("PERCENT", String(quote.slabPercent)),
    entry("REFUND_QUOTE_ID", quote.quoteId),
    entry("QUOTE_EXPIRES_AT", new Date(quote.quoteExpiresAt).toISOString()),
  ]);
}

/* ------------------------------------------------------------------ *
 * Items and fulfillments
 * ------------------------------------------------------------------ */

export interface ItemInput {
  service: ReservedService;
  travelDate: string;
  pricePaise: number;
  pair: BoardingPair;
  fareSourcing: SourcingLabel;
  availableCount?: number;
  selectedCount?: number;
}

export function reservedItem(input: ItemInput): Record<string, unknown> {
  const itemId = reservedItemId(
    input.service.serviceId,
    input.travelDate,
    input.service.serviceClass,
  );
  return {
    id: itemId,
    category_ids: [RESERVED_CATEGORY_ID],
    descriptor: {
      name: SERVICE_CLASS_NAMES[input.service.serviceClass],
      code: RESERVED_ITEM_CODE,
    },
    price: { currency: "INR", value: paiseToRupees(input.pricePaise) },
    quantity: {
      ...(input.availableCount === undefined
        ? {}
        : { available: { count: input.availableCount } }),
      ...(input.selectedCount === undefined
        ? {}
        : { selected: { count: input.selectedCount } }),
      // One named passenger per named seat, and a booking is one boarding pair
      // and one dropping point for everybody on it.
      maximum: { count: 6 },
      minimum: { count: 1 },
    },
    fulfillment_ids: [reservedFulfillmentId(itemId)],
    time: {
      label: "Departure",
      timestamp: stopInstant(
        input.travelDate,
        input.service.departureMinute,
        0,
      ),
    },
    tags: [
      serviceInfoTag(input.service, input.travelDate),
      pricedForTag(input.pair, input.fareSourcing),
      operatorDisclosureTag(input.service),
      serviceProvenanceTag(input.service),
      simulatedInventoryTag(),
      specimenTag(),
    ],
  };
}

function stopLocation(point: BoardingPoint) {
  return {
    descriptor: { name: point.name, code: point.boardingPointId },
    // A point with no coordinate publishes none rather than one synthesised
    // from a town centroid. A pin is only as trustworthy as the operational
    // data behind it, and 2026-dated complaints against the incumbents still
    // report pins that do not match where the coach stops.
    ...(point.gps ? { gps: `${point.gps.lat}, ${point.gps.lon}` } : {}),
  };
}

/**
 * The whole run, in travel order, with an absolute instant at every stop.
 *
 * The instants are allowed to cross midnight: an overnight departure arrives
 * on the following calendar day, which is the case neither existing category
 * has ever produced and the reason the travel date and the departure instant
 * are separate fields rather than one.
 */
export function catalogueFulfillment(
  service: ReservedService,
  travelDate: string,
): Record<string, unknown> {
  const itemId = reservedItemId(
    service.serviceId,
    travelDate,
    service.serviceClass,
  );
  const points = [...service.boardingPoints, ...service.droppingPoints];
  return {
    id: reservedFulfillmentId(itemId),
    type: RESERVED_FULFILLMENT_TYPE,
    vehicle: { category: RESERVED_VEHICLE_CATEGORY },
    stops: points.map((point, index) => ({
      id: String(index + 1),
      ...(index === 0 ? {} : { parent_stop_id: String(index) }),
      type:
        index === 0
          ? "START"
          : index === points.length - 1
            ? "END"
            : "INTERMEDIATE_STOP",
      location: stopLocation(point),
      time: {
        timestamp: stopInstant(
          travelDate,
          service.departureMinute,
          point.reportingOffsetMinutes,
        ),
      },
    })),
    tags: [seatMapRefTag(service.seatMapId)],
  };
}

/**
 * The two stops the rider actually chose.
 *
 * An order's fulfillment carries the boarding point and the dropping point
 * this booking is for rather than the whole timetable: the intermediate stops
 * are a property of the service and belong on the catalogue, and a ticket that
 * listed them would bury the one line that governs the rider's next few
 * minutes, which is where to be and by when.
 */
export function orderFulfillment(
  service: ReservedService,
  travelDate: string,
  pair: BoardingPair,
  tags: Tag[],
): Record<string, unknown> {
  const itemId = reservedItemId(
    service.serviceId,
    travelDate,
    service.serviceClass,
  );
  const points = [...service.boardingPoints, ...service.droppingPoints];
  const find = (id: string) => {
    const point = points.find((candidate) => candidate.boardingPointId === id);
    if (!point) {
      throw new ReservedLifecycleError(
        "SERVICE-NOT-FOUND",
        `Service ${service.serviceId} does not stop at ${id}`,
      );
    }
    return point;
  };
  const from = find(pair.fromBoardingPointId);
  const to = find(pair.toBoardingPointId);
  return {
    id: reservedFulfillmentId(itemId),
    type: RESERVED_FULFILLMENT_TYPE,
    vehicle: { category: RESERVED_VEHICLE_CATEGORY },
    stops: [
      {
        id: "1",
        type: "START",
        location: stopLocation(from),
        time: {
          timestamp: stopInstant(
            travelDate,
            service.departureMinute,
            from.reportingOffsetMinutes,
          ),
        },
      },
      {
        id: "2",
        parent_stop_id: "1",
        type: "END",
        location: stopLocation(to),
        time: {
          timestamp: stopInstant(
            travelDate,
            service.departureMinute,
            to.reportingOffsetMinutes,
          ),
        },
      },
    ],
    tags,
  };
}

/* ------------------------------------------------------------------ *
 * The search intent
 * ------------------------------------------------------------------ */

export interface ReservedSearchIntent {
  message?: {
    intent?: {
      category?: { descriptor?: { code?: string } };
      fulfillment?: {
        stops?: Array<{
          type?: string;
          location?: { descriptor?: { code?: string } };
        }>;
        travel_date?: string;
      };
      item?: { descriptor?: { code?: string } };
    };
  };
  context?: { location?: { city?: { code?: string } } };
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The towns and the date a search names.
 *
 * The travel date is mandatory and is a bare calendar date in the operator's
 * own timezone rather than an instant. A planner that takes a timestamp
 * collapses it to a time of day and silently discards the date, which is the
 * failure the field exists to prevent, so a search with no date is refused
 * rather than answered for today.
 *
 * Over the wire this refusal is normally unreachable, because the request
 * schema requires the field and a request without it is rejected at the
 * envelope with the documented negative acknowledgement. The two guards are
 * layered rather than redundant: the schema catches an absent field, and this
 * catches a present one that says nothing.
 */
export function reservedSearchQuery(
  request: ReservedSearchIntent,
): ReservedSearchQuery {
  const intent = request.message?.intent;
  const travelDate = intent?.fulfillment?.travel_date?.trim();
  if (!travelDate || !CALENDAR_DATE.test(travelDate)) {
    throw new ReservedLifecycleError(
      "TRAVEL-DATE-REQUIRED",
      "A reserved search names the calendar date it means, in YYYY-MM-DD, and this one names none",
    );
  }
  const stops = intent?.fulfillment?.stops ?? [];
  const fromTownCode = stops.find((stop) => stop.type === "START")?.location
    ?.descriptor?.code;
  const toTownCode = stops.find((stop) => stop.type === "END")?.location
    ?.descriptor?.code;
  if (!fromTownCode || !toTownCode) {
    throw new ReservedLifecycleError(
      "SERVICE-NOT-FOUND",
      "A reserved search names an origin town and a destination town",
    );
  }
  const serviceClass = intent?.item?.descriptor?.code as
    | ServiceClass
    | undefined;
  return {
    fromTownCode,
    toTownCode,
    travelDate,
    ...(serviceClass ? { serviceClass } : {}),
    cityCode: request.context?.location?.city?.code ?? "",
  };
}

export const RESERVED_CATEGORY = {
  id: RESERVED_CATEGORY_ID,
  descriptor: { name: "Reserved", code: RESERVED_CATEGORY_CODE },
};
