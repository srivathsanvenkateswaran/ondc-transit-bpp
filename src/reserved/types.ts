/**
 * The model a reserved intercity seller holds.
 *
 * A single-journey ticket is a fare for a stop pair. A pass is a fare for a
 * period and a scope of service. A reserved seat is neither: it is one named
 * person, in one numbered seat, on one dated departure of one service,
 * boarding at one named point. Nothing else this provider sells has a
 * calendar, a seat, a passenger name, a refund, or a finite quantity that
 * another buyer can exhaust, and that is what makes this a third catalogue
 * axis rather than a richer item under an existing one.
 *
 * These types are the operator's own domain model. They are what a real
 * seller would hold regardless of the wire format, which is why they carry no
 * protocol vocabulary at all.
 */

/** The one operator that sells this category. */
export type ReservedOperatorKey = "ksrtc";

/**
 * The three corporations that share one reservation brand and portal. A rider
 * is sold a brand; which corporation dispatches the coach is a separate and
 * usually unknown fact. See `operatingCorporation` below.
 */
export type Corporation = "KSRTC" | "NWKRTC" | "KKRTC";

/**
 * The classes this category sells. Every one of them genuinely sells numbered
 * seats.
 *
 * This is exactly the set Tatak's own `src/intercity/classes.ts` marks
 * `reservationRequired: true` - fifteen of them, not five. Ten were missing
 * from this list until this pass, and the gap was silent: a rider offered a
 * Kalyana Ratha or an Amoghavarsha by Tatak's planner reached this provider
 * with a class it had never heard of and was refused with "This coach is not
 * available", which reads as a real sale gone wrong rather than as a class
 * this provider simply never learned to sell.
 *
 * `SARIGE` is deliberately still absent: it is Tatak's one intercity class
 * with `reservationRequired: false` - an unreserved, walk-up,
 * standing-room-permitted ordinary bus - and gating on the corporation
 * rather than the class would block a plain mofussil bus from ever appearing
 * as a walk-up option. An ordinary intercity bus is a single-journey product
 * and belongs on the existing path if it is modelled at all.
 *
 * `ASHWAMEDHA` was ALSO wrongly excluded on that same "unreserved ordinary
 * bus" reasoning before this pass, on the assumption that a class priced at
 * the ordinary floor must be an ordinary bus. Tatak's own data says
 * otherwise: `reservationRequired: true`, and Shakti's own exclusion list
 * does not name it, so it is a genuinely reserved, express-tier product that
 * happens to be priced low - not `SARIGE` wearing a different name. It is
 * included here now, for exactly the reason this whole pass exists: a
 * silent mismatch between what this provider will sell and what Tatak
 * actually offers is how classes go missing.
 *
 * `EV_POWER_PLUS` and `AMBAARI_DREAM_CLASS` were absent because no seat
 * layout or route scale could be sourced for either. Tatak's own domain
 * research has since resolved both (`classes.ts`'s own EV_POWER_PLUS and
 * AMBAARI_DREAM_CLASS entries carry a stated layout each), so the reason for
 * the exclusion no longer holds and both are included.
 *
 * `CORONA` and `CORONA_CLUB_CLASS` remain absent because they are not
 * currently-marketed class names: "Corona" survives only as the historic
 * chassis name for the original 2015 sleeper, and no active product under
 * that name was found. Nothing here may publish either.
 *
 * ## Naming: this provider's ids are Tatak's ids, on purpose
 *
 * Before this pass, two of the five classes this provider sold used their
 * own shorter ids (`RAJAHAMSA`, `AIRAVAT_CLUB`) rather than Tatak's own
 * (`RAJAHAMSA_EXECUTIVE`, `AIRAVAT_CLUB_CLASS`), and nothing reconciled the
 * two vocabularies - Tatak asked this provider for `RAJAHAMSA_EXECUTIVE` and
 * was told no such class existed, on a class this provider was in fact
 * selling under a different spelling. That mismatch is a stricter failure
 * than the ten simply-missing classes above: those fail loudly with
 * "not sellable", where a name mismatch fails as a false "not available" on
 * a class both sides genuinely support.
 *
 * The fix is alignment, not a translation table. Every id in this list is
 * copied from Tatak's own `src/intercity/classes.ts` `id` field, verbatim,
 * for every class both projects carry. Where a translation existed only by
 * coincidence of history (`RAJAHAMSA` -> `RAJAHAMSA_EXECUTIVE`,
 * `AIRAVAT_CLUB` -> `AIRAVAT_CLUB_CLASS`) it is retired here: this list now
 * IS the mapping, because the two sides use one spelling. A second
 * consequence of alignment, not its purpose but worth recording: it also
 * gives `AIRAVAT_CLUB_CLASS_2` a slot of its own. Before this pass this
 * provider's vocabulary had no second Airavat Club tier, so the generator
 * squeezed both `AIRAVAT_CLUB_CLASS` and `AIRAVAT_CLUB_CLASS_2` onto the one
 * `AIRAVAT_CLUB` id, and whichever of the two claimed a fare cell for a
 * boarding pair first silently kept the other's real, different fare from
 * ever being sold. With `AIRAVAT_CLUB_CLASS_2` carrying its own id, that
 * squeeze is gone: each tier owns its own fare cells and its own seat map.
 *
 * The generator that turns Tatak's GTFS output into this provider's fixtures
 * (`scripts/generate-ksrtc-fixtures.ts`) reads this exact list as the single
 * named place that says which of Tatak's classes this provider can sell -
 * see that script's own `CLASS_MAP` for where the two are joined.
 */
export const SERVICE_CLASSES = [
  "RAJAHAMSA_EXECUTIVE",
  "AIRAVAT",
  "AIRAVAT_CLUB_CLASS",
  "PALLAKKI",
  "AMBAARI_UTSAV",
  "ASHWAMEDHA",
  "NON_AC_SLEEPER",
  "AMBAARI_DREAM_CLASS",
  "AIRAVAT_CLUB_CLASS_2",
  "EV_POWER_PLUS",
  "FLYBUS",
  "KALYANA_RATHA",
  "AMOGHAVARSHA",
  "AC_SEATER_EXECUTIVE_CHAIR",
  "AC_SLEEPER",
] as const;

export type ServiceClass = (typeof SERVICE_CLASSES)[number];

/**
 * How a service is known to exist and run on the schedule claimed.
 *
 * These are byte-identical to the three values the buyer app defines, and
 * they have to stay that way: the app renders them, and a fourth value here
 * would be a value it cannot draw.
 *
 * - `confirmed`: several agreeing sources. Only major trunk corridors reach
 *   this, and nothing shipped in these fixtures does.
 * - `inferred`: derived from a road distance, a depot fleet count, a
 *   schedules-per-route ratio, or a single uncorroborated aggregator figure.
 * - `none`: the value exists so that confidence nobody checked cannot arrive
 *   as a silent default. Nothing shipped should carry it on a service.
 *
 * Only `inferred` and `none` render a mark. A `confirmed` service is silent,
 * because a verified tick would be an affirmative certification claim nobody
 * here is in a position to make, whereas a mark on an inferred row costs
 * nothing to justify: it only ever says how little is known.
 */
export type ServiceProvenance = "confirmed" | "inferred" | "none";

/** `V` read against a primary source, `S` secondary, `I` an inference. */
export type SourcingLabel = "V" | "S" | "I";

export type OperatingPattern =
  | { kind: "daily" }
  /** 0 is Sunday, read against the IST calendar. */
  | { kind: "daysOfWeek"; days: number[] }
  /** ISO `YYYY-MM-DD` in IST. */
  | { kind: "dates"; dates: string[] };

export interface BoardingPoint {
  /** Stable identity. Half of the fare key, and half of the ticket. */
  boardingPointId: string;
  name: string;
  nameLocal?: string;
  /** The town this point belongs to. A search names towns, not points. */
  townCode: string;
  /**
   * Optional, and genuinely often absent. A named locality on the far side of
   * a corridor is a fare and time identity, not necessarily a surveyed point
   * on a map, and a point with no coordinate publishes none rather than one
   * synthesised from a town centroid. A boarding point is not a transit stop
   * and must not be modelled as one.
   */
  gps?: { lat: number; lon: number };
  /**
   * Minutes after the service's own `departureMinute` at which the coach is at
   * this point, and therefore by which a rider must be there. This is what
   * makes a boarding point a choice with consequences rather than a label.
   *
   * The specification's section 9.1 shows a ticket reading "report by 22:44"
   * for a 22:59 departure from the origin, which cannot be an offset after
   * departure. The field is implemented as documented - an offset after
   * departure, zero at the origin - because that is what section 14.2's stop
   * timestamps require, and a separate reporting lead is a display concern
   * for whichever surface wants to subtract one. The discrepancy is recorded
   * here rather than resolved silently.
   */
  reportingOffsetMinutes: number;
  /** Where a code exists in an ingested feed, for joining to a stop. */
  stopCode?: string;
}

export interface ReservedService {
  /**
   * Stable across dates and across releases, and the join key three separate
   * projects have to agree on before any of them builds a join against it.
   * Internal: a rider never sees it.
   */
  serviceId: string;
  /**
   * What is painted on the coach's own board, and what staff at a stand answer
   * questions about. This is the identifier a rider uses to find a coach they
   * have never seen. Separately typed from `serviceId` because it is a
   * rider-facing fact rather than a join key, and the two are free to diverge
   * for any service whose board says something else.
   */
  serviceNumber: string;
  /** What the rider is sold. A brand, not a fact about who dispatches. */
  brand: Corporation;
  /**
   * Who actually operates it, where that is known to a `confirmed` standard.
   * `null` means unknown, and unknown must render as absent, never as `brand`.
   * The three corporations share one reservation brand and portal and run
   * their premium classes jointly, so a coach booked under one brand may be
   * another corporation's vehicle.
   */
  operatingCorporation: Corporation | null;
  /** How the claim above is known. `none` when there is no claim. */
  operatingCorporationBasis: ServiceProvenance;
  /** How the service itself is known to exist and run as claimed. */
  provenance: ServiceProvenance;
  /**
   * The number of independent sources that agree. This is what makes
   * `confirmed` auditable rather than asserted: a service claiming
   * `confirmed` on one source is a bug, and the integrity check fails on it.
   */
  provenanceSourceCount: number;
  serviceClass: ServiceClass;
  /** Ordered in travel order, with a reporting time each. */
  boardingPoints: BoardingPoint[];
  droppingPoints: BoardingPoint[];
  operatingPattern: OperatingPattern;
  /**
   * Departure from the first boarding point, in minutes after midnight IST on
   * the travel date. May exceed 1440 for a service whose board says it leaves
   * after midnight on the date named.
   */
  departureMinute: number;
  /** Scheduled running time to the final dropping point, in minutes. */
  runningMinutes: number;
  seatMapId: string;
  fareTableId: string;
  /**
   * How full this service tends to run, 0 to 1. A fidelity dial, not a claim:
   * it is not derived from ridership data, because none exists at route level
   * for these corporations, and the fixture says so per service.
   */
  popularity: number;
  /**
   * Non-refundable in every slab. The policy is the operator's own published
   * one; the figure is this repository's.
   */
  reservationFeePaise: number;
  /**
   * Refunded in full in every slab. The policy is the operator's own
   * published one; the figure is this repository's.
   */
  tollPaise: number;
}

export interface Seat {
  /**
   * The contract. A buyer app selects by this exact string, and it appears on
   * the manifest and on the ticket.
   */
  seatId: string;
  deck: 1 | 2;
  /** 1-based from the front. */
  row: number;
  /**
   * Position across the coach, 1-based from the left as the rider faces
   * forward. The aisle is a gap in this sequence, not a column.
   */
  column: number;
  kind: "SEAT" | "BERTH";
  /** True against a window on either side. Feeds the desirability weighting. */
  window: boolean;
  /**
   * The other half of a shared two-person berth, where one exists. Null for a
   * single berth and for every seater seat.
   */
  pairedSeatId: string | null;
  /**
   * Seats physically beside this one. The aisle breaks adjacency: two seats
   * either side of it are numerically consecutive and are not adjacent,
   * because nobody sits shoulder to shoulder across an aisle. Deriving this
   * from seat numbering would lock the wrong seat on every 2+2 coach.
   */
  adjacentSeatIds: string[];
}

export interface SeatMap {
  seatMapId: string;
  serviceClass: ServiceClass;
  kind: "SEATER" | "SLEEPER";
  /** 1 for a single-deck coach; 2 for a two-deck sleeper. */
  decks: 1 | 2;
  /**
   * The capacity the class is reported at, where a figure was found. Null
   * where none was, so that an unsourced layout cannot be checked against a
   * number nobody published.
   */
  documentedCapacity: number | null;
  seats: Seat[];
}

export interface FareCell {
  fromBoardingPointId: string;
  toBoardingPointId: string;
  serviceClass: ServiceClass;
  /** Integer paise, as everywhere else in this repository. */
  farePaise: number;
  /**
   * Carried per cell rather than per table, because a table can be
   * part-sourced: one corridor's headline fare might be an aggregator figure
   * while the same table's shorter-boarding fare is interpolated. A per-table
   * label would launder the second into the first.
   */
  sourcing: SourcingLabel;
}

export interface FareTable {
  fareTableId: string;
  currency: "INR";
  /**
   * A missing cell is refused at request time, never interpolated. The table
   * is therefore allowed to be incomplete, and the integrity check does not
   * demand completeness.
   */
  fares: FareCell[];
}

export interface ReservedOperatorProfile {
  id: string;
  name: string;
  vehicleCategory: "COACH";
  serviceWindow: { startHHMM: string; endHHMM: string };
}

export interface Town {
  code: string;
  name: string;
  nameLocal?: string;
}

/** Everything a fixture set or an equivalent source supplies, resolved. */
export interface ReservedCatalogue {
  operator: ReservedOperatorProfile;
  towns: Town[];
  boardingPoints: BoardingPoint[];
  services: ReservedService[];
  seatMaps: SeatMap[];
  fareTables: FareTable[];
}

export interface ReservedSearchQuery {
  fromTownCode: string;
  toTownCode: string;
  /** ISO `YYYY-MM-DD` in Asia/Kolkata. Never an instant. */
  travelDate: string;
  serviceClass?: ServiceClass;
  cityCode: string;
}

/**
 * Where a reserved seller gets its services, layouts and fares from.
 *
 * Everything downstream of `ReservedService` is protocol shaping. Everything
 * upstream is somebody's transit data.
 *
 * Inventory is never in the source. A source supplies the static shape of
 * what is sellable; occupancy is seeded in this process and holds and
 * bookings live here. A source that could supply which seats are sold would
 * be a source with live operator inventory, which is exactly the thing nobody
 * has.
 */
export interface ReservedServiceSource {
  readonly operator: ReservedOperatorProfile;

  /** Services running between two towns on one calendar date. */
  services(query: ReservedSearchQuery): Promise<ReservedService[]>;

  /**
   * One service by its own id.
   *
   * An extension to the interface the specification sketches, and it earns its
   * place: every action after `search` names an item rather than a town pair,
   * and resolving one through the town search would mean reconstructing the
   * question a rider asked several actions ago from an answer that no longer
   * carries it.
   */
  service(serviceId: string): Promise<ReservedService | undefined>;

  /** The seat map a class uses. Authored per class, not per service. */
  seatMap(seatMapId: string): Promise<SeatMap | undefined>;

  /** The fare table a service references. */
  fareTable(fareTableId: string): Promise<FareTable | undefined>;
}
