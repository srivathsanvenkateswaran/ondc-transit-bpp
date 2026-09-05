import { ReservedLifecycleError } from "./errors.js";
import type {
  FareCell,
  FareTable,
  ReservedService,
  ServiceClass,
} from "./types.js";

/**
 * The fare key is the boarding-point pair plus the class.
 *
 * Not distance, and not a class coefficient over a base fare. Two classes on
 * the identical corridor charge unrelated numbers, and a rider boarding at a
 * suburban point on a long-haul service departs later and may pay a different
 * fare than one boarding at the terminus. No source establishes whether the
 * operator prices by distance slab or by point-to-point table, and what the
 * research did establish is that differentiated multi-point boarding fares
 * exist, which a distance-only model could only reproduce by inventing
 * per-point distances anyway.
 *
 * A missing cell is refused, never interpolated. Pricing at a neighbouring
 * cell's value would be inventing a fare, and a buyer app that asked for a
 * price this provider does not have needs to hear that rather than receive a
 * plausible number.
 */

export interface BoardingPair {
  fromBoardingPointId: string;
  toBoardingPointId: string;
}

export function findFareCell(
  table: FareTable,
  pair: BoardingPair,
  serviceClass: ServiceClass,
): FareCell | undefined {
  return table.fares.find(
    (cell) =>
      cell.fromBoardingPointId === pair.fromBoardingPointId &&
      cell.toBoardingPointId === pair.toBoardingPointId &&
      cell.serviceClass === serviceClass,
  );
}

export function fareCell(
  table: FareTable,
  pair: BoardingPair,
  serviceClass: ServiceClass,
): FareCell {
  const cell = findFareCell(table, pair, serviceClass);
  if (!cell) {
    throw new ReservedLifecycleError(
      "FARE-NOT-PUBLISHED",
      `No fare is published for ${pair.fromBoardingPointId} to ${pair.toBoardingPointId} in class ${serviceClass}; this provider refuses rather than interpolating from a neighbouring pair`,
    );
  }
  return cell;
}

/**
 * The pair the catalogue's headline price is for.
 *
 * The first boarding point to the last dropping point, which is the whole run
 * and the fare a rider who has chosen nothing yet is quoted. It is published
 * beside the price as `PRICED_FOR`, because a quote for a different pair
 * legitimately differs and a consistency check that did not know the basis
 * would fire on every rider who picks up somewhere other than the terminus.
 */
export function headlinePair(service: ReservedService): BoardingPair {
  return {
    fromBoardingPointId: service.boardingPoints[0].boardingPointId,
    toBoardingPointId:
      service.droppingPoints[service.droppingPoints.length - 1].boardingPointId,
  };
}

/**
 * The chosen pair, checked against the stops the service actually makes.
 *
 * A boarding point the service does not stop at is refused as an unpublished
 * fare rather than as an unknown point: from the buyer's side the two are the
 * same fact, that this provider will not price that journey.
 */
export function boardingPairFromStops(
  service: ReservedService,
  stops: Array<{ type?: string; location?: { descriptor?: { code?: string } } }>,
): BoardingPair {
  const start = stops.find((stop) => stop.type === "START");
  const end = stops.find((stop) => stop.type === "END");
  const pair = {
    fromBoardingPointId:
      start?.location?.descriptor?.code ??
      service.boardingPoints[0].boardingPointId,
    toBoardingPointId:
      end?.location?.descriptor?.code ??
      service.droppingPoints[service.droppingPoints.length - 1].boardingPointId,
  };
  const boards = service.boardingPoints.some(
    (point) => point.boardingPointId === pair.fromBoardingPointId,
  );
  const alights = service.droppingPoints.some(
    (point) => point.boardingPointId === pair.toBoardingPointId,
  );
  if (!boards || !alights) {
    throw new ReservedLifecycleError(
      "FARE-NOT-PUBLISHED",
      `Service ${service.serviceId} does not run ${pair.fromBoardingPointId} to ${pair.toBoardingPointId}`,
    );
  }
  return pair;
}

/** The reporting offset of a point on one service, in minutes after departure. */
export function reportingOffsetFor(
  service: ReservedService,
  boardingPointId: string,
): number {
  const point = [...service.boardingPoints, ...service.droppingPoints].find(
    (candidate) => candidate.boardingPointId === boardingPointId,
  );
  if (!point) {
    throw new ReservedLifecycleError(
      "SERVICE-NOT-FOUND",
      `Service ${service.serviceId} does not stop at ${boardingPointId}`,
    );
  }
  return point.reportingOffsetMinutes;
}
