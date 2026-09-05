import { rand } from "./rand.js";
import type { ReservedService, Seat, SeatMap, ServiceClass } from "./types.js";

/**
 * How full a coach is, and which seats have gone.
 *
 * Occupancy is a consequence of which service, on which date, in which class,
 * with a per-seat perturbation on top. It is never a coin flip per seat and
 * never a fresh roll per request.
 *
 * The sibling fleet simulator adopted exactly this discipline for bus load and
 * its reasoning transfers unchanged: an earlier implementation rebucketed a
 * keyed hash every five minutes, so a vehicle's fullness jumped arbitrarily
 * instead of following a shape, and what replaced it treats load as a property
 * of the trip with random draws present only as perturbations layered on that
 * shape.
 *
 * Nothing in this module reads the wall clock or an unseeded source, and a
 * test asserts it by replacing every reachable clock with one that throws.
 * That costs realism - a booking curve that filled a coach as its departure
 * approached would be more lifelike - and the cost is deliberate: a curve
 * would be indistinguishable on screen from real inventory moving, which is a
 * claim this provider cannot make. A static seeded map is visibly a
 * simulation, keeps a screenshot and a golden file reproducible, and means the
 * answer to "why does berth L3B show sold" does not depend on when you asked.
 */

/** Nobody's coach is completely empty, and nobody's is completely full. */
export const MIN_FILL = 0.08;
export const MAX_FILL = 0.95;

/**
 * The ordinary shape of an Indian intercity demand week: Friday evening out,
 * Sunday back, a midweek trough. An inference from ordinary travel patterns,
 * not a figure anybody published.
 */
const DAY_OF_WEEK_MULTIPLIER: readonly number[] = [
  1.15, // Sunday
  0.92,
  0.88,
  0.9,
  1.0,
  1.2, // Friday
  1.05,
];

/**
 * A cheaper class fills first at the same popularity. An inference. No fare
 * multiplier between classes is encoded anywhere in this repository, because
 * none could be sourced; this is a demand shape, not a price relationship.
 */
const CLASS_MULTIPLIER: Record<ServiceClass, number> = {
  RAJAHAMSA: 1.1,
  PALLAKKI: 1.05,
  AIRAVAT: 1.0,
  AMBAARI_UTSAV: 0.92,
  AIRAVAT_CLUB: 0.9,
};

/**
 * How much of a seat's rank is its desirability and how much is noise. The
 * perturbation is deliberately smaller than the largest weight, so that noise
 * perturbs the shape rather than being the shape.
 */
const PERTURBATION_WEIGHT = 0.35;

const WINDOW_BONUS = 0.45;
const LOWER_DECK_BONUS = 0.35;
const SINGLE_BERTH_BONUS = 0.3;
const FORWARD_ROW_BONUS = 0.2;
const REAR_BENCH_PENALTY = 0.4;

const INDIA_OFFSET_MILLISECONDS = 5.5 * 60 * 60 * 1000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The day of the week a travel date falls on, 0 for Sunday, read against the
 * IST calendar and derived from the date string alone. Deriving it from the
 * string rather than from a `Date` built at call time is what keeps this
 * function clock-free.
 */
function dayOfWeek(travelDate: string): number {
  const match = CALENDAR_DATE.exec(travelDate);
  if (!match) {
    throw new Error(
      `A travel date must be a bare calendar date in YYYY-MM-DD, not ${travelDate}`,
    );
  }
  const [, year, month, day] = match;
  const midnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(midnight).getUTCDay();
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Every input is a property of the service and the date. `popularity` is
 * authored in the fixture per service and is a fidelity dial rather than a
 * claim: it is not derived from ridership data, because none exists at route
 * level for these corporations.
 */
export function fillFraction(
  service: Pick<ReservedService, "popularity" | "serviceClass">,
  travelDate: string,
): number {
  return clamp(
    service.popularity *
      DAY_OF_WEEK_MULTIPLIER[dayOfWeek(travelDate)] *
      CLASS_MULTIPLIER[service.serviceClass],
    MIN_FILL,
    MAX_FILL,
  );
}

/**
 * A row is a bench when its seats occupy a contiguous run of columns. The
 * aisle is a gap in the column sequence, so a row with no gap has no aisle,
 * which on an Indian coach means the rear bench. Deriving it from the geometry
 * rather than carrying a flag keeps the seat map free of a field that would
 * only ever restate what the columns already say.
 */
function isBenchRow(map: SeatMap, seat: Seat): boolean {
  const columns = map.seats
    .filter((candidate) => candidate.deck === seat.deck && candidate.row === seat.row)
    .map((candidate) => candidate.column)
    .sort((a, b) => a - b);
  if (columns.length < 3) return false;
  return columns.every(
    (column, index) => index === 0 || column - columns[index - 1] === 1,
  );
}

/**
 * How much a seat is wanted, before any noise. A pure function of the seat and
 * the layout, so that a change which flattened it into a plain hash shows up
 * as a failing shape test rather than as a coach that quietly stopped looking
 * like a coach.
 */
export function seatDesirability(seat: Seat, map: SeatMap): number {
  const maxRow = Math.max(...map.seats.map((candidate) => candidate.row));
  const forward =
    maxRow > 1 ? 1 - (seat.row - 1) / (maxRow - 1) : 1;
  return (
    (seat.window ? WINDOW_BONUS : 0) +
    (map.decks === 2 && seat.deck === 1 ? LOWER_DECK_BONUS : 0) +
    (seat.kind === "BERTH" && seat.pairedSeatId === null ? SINGLE_BERTH_BONUS : 0) +
    FORWARD_ROW_BONUS * forward -
    (isBenchRow(map, seat) ? REAR_BENCH_PENALTY : 0)
  );
}

/**
 * The sold set: the top `round(fraction x capacity)` seats by desirability
 * plus a keyed perturbation. Ties break on the seat id so the answer is total
 * rather than dependent on the order the map happened to be authored in.
 */
export function selectSoldSeats(
  map: SeatMap,
  fraction: number,
  serviceId: string,
  travelDate: string,
  seed: number,
): string[] {
  const count = Math.round(fraction * map.seats.length);
  const ranked = map.seats
    .map((seat) => ({
      seatId: seat.seatId,
      rank:
        seatDesirability(seat, map) +
        PERTURBATION_WEIGHT *
          rand(seed, serviceId, `seat-rank|${travelDate}`, seat.seatId),
    }))
    .sort((left, right) =>
      right.rank === left.rank
        ? left.seatId.localeCompare(right.seatId)
        : right.rank - left.rank,
    );
  return ranked
    .slice(0, count)
    .map((entry) => entry.seatId)
    .sort();
}

export function soldSeatIds(
  service: Pick<ReservedService, "serviceId" | "popularity" | "serviceClass">,
  map: SeatMap,
  travelDate: string,
  seed: number,
): string[] {
  return selectSoldSeats(
    map,
    fillFraction(service, travelDate),
    service.serviceId,
    travelDate,
    seed,
  );
}

export type SeededGender = "male" | "female";

/**
 * A notionally occupied seat also gets a deterministic gender, from the same
 * keyed hash, because the adjacency rule cannot evaluate a lock without
 * knowing who is notionally beside the empty seat.
 *
 * This is a genuine consequence of choosing a deterministic simulation over a
 * live feed: this provider fabricates a gender for seats nobody booked, purely
 * so that a real, rule-following lock can be demonstrated. It never leaves the
 * seat-state computation as an identity. What reaches the wire is the
 * resulting lock, never a claim about a person.
 */
export function seededGender(
  seed: number,
  serviceId: string,
  travelDate: string,
  seatId: string,
): SeededGender {
  return rand(seed, serviceId, `seat-gender|${travelDate}`, seatId) < 0.5
    ? "male"
    : "female";
}

/** The sold set with its seeded genders, which is what the lock rule reads. */
export function seededOccupancy(
  service: Pick<ReservedService, "serviceId" | "popularity" | "serviceClass">,
  map: SeatMap,
  travelDate: string,
  seed: number,
): Map<string, SeededGender> {
  return new Map(
    soldSeatIds(service, map, travelDate, seed).map((seatId) => [
      seatId,
      seededGender(seed, service.serviceId, travelDate, seatId),
    ]),
  );
}
