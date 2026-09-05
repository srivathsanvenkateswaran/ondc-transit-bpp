/**
 * The domain this category is published under, and the vocabulary it invents.
 *
 * `TRANSIT.LOCALHOST:INTERCITY` at version `0.1.0` is a locally owned,
 * Beckn-shaped domain string. It claims conformance to nothing. The reasoning
 * is set out in full in `docs/reserved-intercity.md` section 2; the short
 * version is that the released mobility specification this repository already
 * implements covers unreserved public transit only, the intercity coach
 * specification that would cover this category is still a draft branch, and no
 * state road transport corporation is a live participant on any real network
 * for intercity booking. Publishing under an administered namespace would
 * assert two things that are not true - conformance to a released
 * specification, and membership of a namespace somebody else administers.
 *
 * `TRANSIT.LOCALHOST` is the namespace half of the subscriber ids this stack
 * already uses. `.localhost` is reserved by RFC 6761 and unresolvable, so the
 * domain string cannot collide with an issued one by the same mechanism that
 * already stops the subscriber ids colliding. `INTERCITY` names the product.
 *
 * Version `0.1.0` rather than a two-part number: a zero major says this is
 * pre-stable and locally owned, and it cannot be mistaken for a release number
 * of the specification next door.
 *
 * Every code in this file is this repository's own naming. There is no
 * published enumeration to transcribe from, and section 14.8 keeps the codes
 * in one table so that mapping them onto a released specification, if one ever
 * arrives, is a table-to-table exercise rather than a search through source.
 */

export const RESERVED_DOMAIN = "TRANSIT.LOCALHOST:INTERCITY";
export const RESERVED_VERSION = "0.1.0";

/** The third catalogue axis, alongside the two this provider already sells. */
export const RESERVED_CATEGORY_ID = "C3";
export const RESERVED_CATEGORY_CODE = "RESERVED";

/** `Item.descriptor.code`. */
export const RESERVED_ITEM_CODE = "RESERVED";

/** `Fulfillment.type`. A reserved booking is neither a trip nor a pass. */
export const RESERVED_FULFILLMENT_TYPE = "RESERVATION";

/** `vehicle.category`. An intercity coach is not a city bus. */
export const RESERVED_VEHICLE_CATEGORY = "COACH";

/**
 * The mark that rides on every reserved item and every seat map. The seats a
 * rider sees as sold here were sold by an algorithm in this process, not by
 * anybody's booking system, and a surface that let a rider read them as live
 * availability would be making a claim this provider cannot make.
 */
export const SIMULATED_INVENTORY_MARK =
  "Modelled inventory. The seats shown as sold are simulated by this specimen provider, not KSRTC's live availability.";

export const SPECIMEN_NOTICE = "SPECIMEN - NOT VALID FOR TRAVEL";

/**
 * The five states a seat can be published in, and a client's legend must
 * enumerate all five. A legend that undercounts the states actually on screen
 * is a documented real-world failure, compounded in the documented case by the
 * missing state being the safety-relevant one.
 *
 * `SOLD:simulated` and `SOLD:booked` render identically to a rider and differ
 * on the wire, so a client can honestly say "sold in this demonstration" about
 * one and nothing at all about the other. `FEMALE_ONLY` is a distinct
 * enumerated value rather than a hint folded into `AVAILABLE`, because the
 * documented failure is a ladies-only seat distinguished by a pale border and
 * a rider booking one by accident.
 */
export const SEAT_STATES = [
  "AVAILABLE",
  "HELD",
  "HELD_BY_YOU",
  "FEMALE_ONLY",
  "SOLD:simulated",
  "SOLD:booked",
] as const;

export type SeatState = (typeof SEAT_STATES)[number];

export const CONFIRMED_SPECIMEN_NOTICE =
  "SPECIMEN - NOT VALID FOR TRAVEL - not issued by KSRTC, NWKRTC or KKRTC";

/** Section 14.8's table, as a value so a test can assert the whole of it. */
export const RESERVED_TAG_CODES = [
  "SERVICE_INFO",
  "PRICED_FOR",
  "SERVICE_PROVENANCE",
  "OPERATOR_DISCLOSURE",
  "SIMULATED_INVENTORY",
  "SPECIMEN_INFO",
  "SEAT_MAP_REF",
  "SEAT_MAP",
  "SEATS",
  "HOLD_INFO",
  "MANIFEST",
  "BOOKING_REF",
  "VEHICLE_LOOKUP",
  "REFUND_SLAB",
] as const;

export type ReservedTagCode = (typeof RESERVED_TAG_CODES)[number];

/** Section 14.9's table. Declared here so no caller invents a nineteenth. */
export const RESERVED_ERROR_CODES = [
  "TRAVEL-DATE-REQUIRED",
  "SERVICE-NOT-FOUND",
  "OUTSIDE-BOOKING-WINDOW",
  "FARE-NOT-PUBLISHED",
  "SEAT-NOT-ON-MAP",
  "SEAT-UNAVAILABLE",
  "SEAT-GENDER-LOCKED",
  "SEAT-COUNT-MISMATCH",
  "HOLD-REQUIRED",
  "HOLD-EXPIRED",
  "HOLD-SEAT-MISMATCH",
  "MANIFEST-INCOMPLETE",
  "MANIFEST-FIELD-NOT-ACCEPTED",
  "CONCESSION-RATE-NOT-PUBLISHED",
  "CONCESSION-NOT-APPLICABLE",
  "BOOKING-NOT-FOUND",
  "REFUND-SLAB-MOVED",
  "REFUND-QUOTE-EXPIRED",
  "MIXED-CATEGORY-ORDER",
] as const;

export type ReservedErrorCode = (typeof RESERVED_ERROR_CODES)[number];

const IST_CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An item's identity has to carry the date. Two calendar dates of the same
 * scheduled service are two entirely different sellable inventories, so the
 * item id is not the service - it is the service, the date and the class.
 *
 * This is the single largest structural difference from the two existing
 * categories, where an item id is stable across every search forever. A buyer
 * app must treat the string as opaque and read the fields off the
 * `SERVICE_INFO` tag rather than parsing it back out.
 */
export function reservedItemId(
  serviceId: string,
  travelDate: string,
  serviceClass: string,
): string {
  if (!IST_CALENDAR_DATE.test(travelDate)) {
    throw new Error(
      `A reserved item id needs a bare travel date in YYYY-MM-DD, not ${travelDate}`,
    );
  }
  return `RSV-${serviceId}-${travelDate}-${serviceClass}`;
}

export function reservedFulfillmentId(itemId: string): string {
  return `F-${itemId}`;
}
