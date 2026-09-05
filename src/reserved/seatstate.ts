import type { SeatState } from "./domain.js";
import { ReservedLifecycleError } from "./errors.js";
import type { SeededGender } from "./occupancy.js";
import type {
  LiveSeatClaim,
  ManifestGender,
  ReservedIdentity,
} from "./store.js";
import type { Seat, SeatMap } from "./types.js";

/**
 * What a seat's published state is, and which free seats a man cannot take.
 *
 * A seat's state is the union of three things, in this order of strength:
 *
 *   1. seeded occupancy, which is a simulation and says so on the wire;
 *   2. a live hold placed by some transaction in this stack;
 *   3. a confirmed booking in this stack.
 *
 * Rows 2 and 3 are facts this provider actually holds. Row 1 is not, and the
 * wire keeps them apart: `SOLD:simulated` and `SOLD:booked` render identically
 * to a rider and differ here, so a buyer app can honestly say "this berth was
 * sold in this demonstration" about one and nothing at all about the other.
 *
 * The lock is a property of a seat's neighbourhood, recomputed on every read
 * rather than stored as a flag. That is what makes it relock: cancel one
 * passenger of a mixed pair and the freed seat's neighbour is now a woman in
 * somebody else's booking, so the seat that was sellable a moment ago is not.
 * A stored flag would have to be found and updated by whoever cancelled, and
 * the one thing worse than a lock that does not fire is a lock that fires
 * because nobody cleaned up after a cancellation.
 */

export interface SeatNeighbourhood {
  map: SeatMap;
  /** Seat id to fabricated gender, for seats the simulation sold. */
  seededSold: Map<string, SeededGender>;
  /** Every live hold and booking on this dated departure. */
  claims: LiveSeatClaim[];
  /**
   * Whose view this is. A hold of theirs reads `HELD_BY_YOU`, and a seat
   * beside a woman in their own booking is not locked against them.
   */
  viewer?: ReservedIdentity;
}

function sameParty(
  left: ReservedIdentity | undefined,
  right: ReservedIdentity,
): boolean {
  return (
    left !== undefined &&
    left.bapId === right.bapId &&
    left.bapUri === right.bapUri &&
    left.transactionId === right.transactionId
  );
}

interface Neighbourhood {
  seats: Map<string, Seat>;
  claims: Map<string, LiveSeatClaim>;
}

function index(input: SeatNeighbourhood): Neighbourhood {
  return {
    seats: new Map(input.map.seats.map((seat) => [seat.seatId, seat])),
    claims: new Map(input.claims.map((claim) => [claim.seatId, claim])),
  };
}

/**
 * Who is notionally in a seat, as far as the lock rule is concerned.
 *
 * A booking outranks the simulation absolutely. Where a seat carries both a
 * confirmed booking and a fabricated gender, the booking is a fact somebody
 * asserted and the fabrication is a number this process drew, so the two are
 * not weighed against each other: the fabrication is not consulted at all.
 */
function occupantGender(
  seatId: string,
  input: SeatNeighbourhood,
  claims: Map<string, LiveSeatClaim>,
): { gender: ManifestGender | SeededGender | null; owner?: ReservedIdentity } {
  const claim = claims.get(seatId);
  if (claim?.state === "BOOKED") {
    return { gender: claim.gender, owner: claim.identity };
  }
  // A held seat has no manifest yet, so nobody knows who is in it and nothing
  // is locked by it.
  if (claim?.state === "HELD") return { gender: null, owner: claim.identity };
  const seeded = input.seededSold.get(seatId);
  return seeded ? { gender: seeded } : { gender: null };
}

/**
 * Whether a free seat is female-only for this viewer.
 *
 * Adjacency is physical and authored on the seat map: the aisle breaks it, so
 * two seats either side of one are numerically consecutive and are not
 * adjacent. Nobody sits shoulder to shoulder across an aisle.
 */
export function isFemaleOnly(
  seatId: string,
  input: SeatNeighbourhood,
  indexed: Neighbourhood = index(input),
): boolean {
  const seat = indexed.seats.get(seatId);
  if (!seat) return false;
  return seat.adjacentSeatIds.some((neighbourId) => {
    const occupant = occupantGender(neighbourId, input, indexed.claims);
    if (occupant.gender !== "female") return false;
    // A simulated passenger belongs to nobody's booking, so nobody is exempt
    // from her.
    if (occupant.owner === undefined) return true;
    // The exemption is the shared booking, and only that. A woman in the
    // viewer's own booking does not lock the seat beside her against them.
    return !sameParty(input.viewer, occupant.owner);
  });
}

export function seatStates(input: SeatNeighbourhood): Map<string, SeatState> {
  const indexed = index(input);
  const states = new Map<string, SeatState>();
  input.map.seats.forEach((seat) => {
    const claim = indexed.claims.get(seat.seatId);
    if (claim?.state === "BOOKED") {
      states.set(seat.seatId, "SOLD:booked");
      return;
    }
    if (claim?.state === "HELD") {
      states.set(
        seat.seatId,
        sameParty(input.viewer, claim.identity) ? "HELD_BY_YOU" : "HELD",
      );
      return;
    }
    if (input.seededSold.has(seat.seatId)) {
      states.set(seat.seatId, "SOLD:simulated");
      return;
    }
    states.set(
      seat.seatId,
      isFemaleOnly(seat.seatId, input, indexed) ? "FEMALE_ONLY" : "AVAILABLE",
    );
  });
  return states;
}

/** How many seats a buyer could still take on this dated departure. */
export function availableSeatCount(input: SeatNeighbourhood): number {
  let free = 0;
  seatStates(input).forEach((state) => {
    if (state === "AVAILABLE" || state === "FEMALE_ONLY") free += 1;
  });
  return free;
}

export interface SeatAssignment {
  seatId: string;
  gender: ManifestGender | null;
}

/**
 * Refuse a manifest that puts the wrong passenger in a locked seat.
 *
 * Checked at `init` and again at `confirm`, and not at `select`, because the
 * hold taken at select names seats only. The manifest is the first point at
 * which this provider learns which gender is going where, which makes `init`
 * the earliest moment the rule can fire and the one where a rider can still
 * act on it. `docs/reserved-intercity.md` section 7 describes the refusal as a
 * select-time one, which its own section 14.4 then contradicts; the later and
 * more specific statement is the one implemented.
 *
 * The refusal names the seat and the required gender. It never names the
 * neighbouring passenger or anything about them, because the rule is a
 * constraint on a seat and disclosing whose presence caused it would tell a
 * stranger something about a passenger they have no business knowing.
 */
export function assertGenderLocks(
  input: SeatNeighbourhood,
  assignments: SeatAssignment[],
): void {
  const indexed = index(input);
  assignments.forEach((assignment) => {
    if (assignment.gender === "female") return;
    if (!isFemaleOnly(assignment.seatId, input, indexed)) return;
    throw new ReservedLifecycleError(
      "SEAT-GENDER-LOCKED",
      `Seat ${assignment.seatId} is held for a female passenger and the manifest declares ${
        assignment.gender ?? "no gender"
      }`,
      { seatId: assignment.seatId, requiredGender: "female" },
    );
  });
}
