import {
  SERVICE_CLASSES,
  type ReservedCatalogue,
  type SeatMap,
  type ServiceClass,
} from "./types.js";

/**
 * Boot-time integrity validation for a reserved catalogue.
 *
 * A broken fixture fails here rather than at the first `select`. The checks
 * are not defensive programming: each one exists because the corresponding
 * mistake is silent, and a silent mistake in this data is a claim about
 * Karnataka that nobody made.
 *
 * What this deliberately does not check is completeness of a fare table. A
 * missing cell is refused at request time with a named code, never
 * interpolated, so an incomplete table is a valid table and demanding
 * completeness here would push authors towards inventing the cells they are
 * missing.
 */

/**
 * Classes this category is not permitted to publish, and why, so that a
 * refusal names its reason rather than only its rule.
 */
const REFUSED_CLASSES: Record<string, string> = {
  SARIGE:
    "an unreserved, walk-up, standing-room-permitted ordinary bus, which belongs on the single-journey path if it is modelled at all",
  ASHWAMEDHA:
    "an unreserved, walk-up, standing-room-permitted ordinary bus, which belongs on the single-journey path if it is modelled at all",
  EV_POWER_PLUS: "a class with no confirmed seat layout or route scale",
  AMBAARI_DREAM: "a class with no confirmed seat layout or route scale",
  CORONA:
    "not a currently-marketed class name; it survives only as the historic chassis name of the original 2015 sleeper, and no active product under it was found",
  CORONA_CLUB_CLASS:
    "not a currently-marketed class name; it survives only as the historic chassis name of the original 2015 sleeper, and no active product under it was found",
};

function fail(sourceDescription: string, message: string): never {
  throw new Error(`${sourceDescription}: ${message}`);
}

function checkSeatMap(map: SeatMap, where: string): void {
  const seatIds = new Set<string>();
  map.seats.forEach((seat) => {
    if (seatIds.has(seat.seatId)) {
      fail(where, `seat map ${map.seatMapId} has a duplicate seat id ${seat.seatId}`);
    }
    seatIds.add(seat.seatId);
    if (seat.deck > map.decks) {
      fail(
        where,
        `seat map ${map.seatMapId} places ${seat.seatId} on deck ${seat.deck}, and the coach has ${map.decks}`,
      );
    }
  });

  const byId = new Map(map.seats.map((seat) => [seat.seatId, seat]));
  map.seats.forEach((seat) => {
    if (seat.adjacentSeatIds.includes(seat.seatId)) {
      fail(where, `seat map ${map.seatMapId} makes ${seat.seatId} adjacent to itself`);
    }
    seat.adjacentSeatIds.forEach((neighbourId) => {
      const neighbour = byId.get(neighbourId);
      if (!neighbour) {
        fail(
          where,
          `seat map ${map.seatMapId} makes ${seat.seatId} adjacent to ${neighbourId}, which is not on the map`,
        );
      }
      // Asymmetric adjacency would lock a seat in one direction and not the
      // other, which is a gender rule that fires on some riders and not on
      // others for no reason either of them can see.
      if (!neighbour.adjacentSeatIds.includes(seat.seatId)) {
        fail(
          where,
          `seat map ${map.seatMapId} has asymmetric adjacency: ${seat.seatId} names ${neighbourId}, and ${neighbourId} does not name ${seat.seatId} back`,
        );
      }
    });
    if (seat.pairedSeatId !== null) {
      const partner = byId.get(seat.pairedSeatId);
      if (!partner) {
        fail(
          where,
          `seat map ${map.seatMapId} pairs ${seat.seatId} with ${seat.pairedSeatId}, which is not on the map`,
        );
      }
      if (partner.pairedSeatId !== seat.seatId) {
        fail(
          where,
          `seat map ${map.seatMapId} has asymmetric pairing: ${seat.seatId} pairs with ${seat.pairedSeatId}, and ${seat.pairedSeatId} does not pair back`,
        );
      }
    }
  });

  // Checked only where a capacity was actually documented. An unsourced
  // layout cannot be checked against a number nobody published.
  if (
    map.documentedCapacity !== null &&
    map.seats.length !== map.documentedCapacity
  ) {
    fail(
      where,
      `seat map ${map.seatMapId} authors ${map.seats.length} seats, and the class is documented at ${map.documentedCapacity}`,
    );
  }
}

export function validateReservedCatalogue(
  catalogue: ReservedCatalogue,
  sourceDescription: string,
): void {
  const where = sourceDescription;
  const townCodes = new Set(catalogue.towns.map((town) => town.code));
  const pointIds = new Set(
    catalogue.boardingPoints.map((point) => point.boardingPointId),
  );
  catalogue.boardingPoints.forEach((point) => {
    if (!townCodes.has(point.townCode)) {
      fail(where, `boarding point ${point.boardingPointId} names unknown town ${point.townCode}`);
    }
  });

  const seatMapIds = new Set(catalogue.seatMaps.map((map) => map.seatMapId));
  const fareTableIds = new Set(
    catalogue.fareTables.map((table) => table.fareTableId),
  );
  catalogue.seatMaps.forEach((map) => checkSeatMap(map, where));

  const serviceIds = new Set<string>();
  catalogue.services.forEach((service) => {
    if (serviceIds.has(service.serviceId)) {
      fail(where, `duplicate service id ${service.serviceId}`);
    }
    serviceIds.add(service.serviceId);

    const refusal = REFUSED_CLASSES[service.serviceClass];
    if (refusal) {
      fail(
        where,
        `service ${service.serviceId} is class ${service.serviceClass}, which this category does not sell: ${refusal}`,
      );
    }
    if (!(SERVICE_CLASSES as readonly string[]).includes(service.serviceClass)) {
      fail(
        where,
        `service ${service.serviceId} names class ${service.serviceClass}, which is not a class this category sells`,
      );
    }

    if (!seatMapIds.has(service.seatMapId)) {
      fail(
        where,
        `service ${service.serviceId} names seat map ${service.seatMapId}, which nobody authored`,
      );
    }
    if (!fareTableIds.has(service.fareTableId)) {
      fail(
        where,
        `service ${service.serviceId} names fare table ${service.fareTableId}, which nobody authored`,
      );
    }

    if (service.boardingPoints.length === 0 || service.droppingPoints.length === 0) {
      fail(where, `service ${service.serviceId} has no boarding or no dropping point`);
    }
    [...service.boardingPoints, ...service.droppingPoints].forEach((point) => {
      if (!pointIds.has(point.boardingPointId)) {
        fail(
          where,
          `service ${service.serviceId} stops at ${point.boardingPointId}, which no town declares`,
        );
      }
    });

    // `confirmed` is the only value that asserts anything, and the source
    // count is what makes the assertion auditable rather than a label.
    if (service.provenance === "confirmed" && service.provenanceSourceCount < 2) {
      fail(
        where,
        `service ${service.serviceId} claims confirmed provenance on ${service.provenanceSourceCount} source; confirmed needs at least 2 independent sources that agree`,
      );
    }
    if (service.provenanceSourceCount < 0) {
      fail(where, `service ${service.serviceId} has a negative source count`);
    }

    // The whole value of the operating-corporation disclosure is that it
    // closes a gap every other surface leaves open. A disclosure that is
    // sometimes wrong closes nothing and misleads instead, so a named
    // corporation must be confirmed and an unknown one must say so.
    if (
      service.operatingCorporation !== null &&
      service.operatingCorporationBasis !== "confirmed"
    ) {
      fail(
        where,
        `service ${service.serviceId} names operating corporation ${service.operatingCorporation} on a ${service.operatingCorporationBasis} basis; publishing an inferred corporation is worse than publishing none`,
      );
    }
    if (
      service.operatingCorporation === null &&
      service.operatingCorporationBasis !== "none"
    ) {
      fail(
        where,
        `service ${service.serviceId} has no operating corporation and a basis of ${service.operatingCorporationBasis}; with no claim the basis is none`,
      );
    }

    if (
      !Number.isFinite(service.popularity) ||
      service.popularity < 0 ||
      service.popularity > 1
    ) {
      fail(
        where,
        `service ${service.serviceId} has popularity ${service.popularity}, and the dial runs 0 to 1`,
      );
    }

    if (!Number.isInteger(service.departureMinute) || service.departureMinute < 0) {
      fail(where, `service ${service.serviceId} has a non-integer departure minute`);
    }
    if (!Number.isInteger(service.runningMinutes) || service.runningMinutes <= 0) {
      fail(where, `service ${service.serviceId} has a non-positive running time`);
    }
    [
      ["reservationFeePaise", service.reservationFeePaise],
      ["tollPaise", service.tollPaise],
    ].forEach(([field, value]) => {
      if (!Number.isSafeInteger(value as number) || (value as number) < 0) {
        fail(
          where,
          `service ${service.serviceId} has a ${field} that is not a non-negative whole number of paise`,
        );
      }
    });
  });

  catalogue.fareTables.forEach((table) => {
    // A cell is keyed to a service through its class, so the points it names
    // have to be points some service of that class actually stops at.
    const servicesForTable = catalogue.services.filter(
      (service) => service.fareTableId === table.fareTableId,
    );
    const reachable = new Map<ServiceClass, Set<string>>();
    servicesForTable.forEach((service) => {
      const set = reachable.get(service.serviceClass) ?? new Set<string>();
      [...service.boardingPoints, ...service.droppingPoints].forEach((point) =>
        set.add(point.boardingPointId),
      );
      reachable.set(service.serviceClass, set);
    });
    table.fares.forEach((cell) => {
      if (!["V", "S", "I"].includes(cell.sourcing)) {
        fail(
          where,
          `fare table ${table.fareTableId} has a cell with no sourcing label; a per-table label would launder an interpolated cell into a sourced one`,
        );
      }
      if (!Number.isSafeInteger(cell.farePaise) || cell.farePaise < 0) {
        fail(
          where,
          `fare table ${table.fareTableId} has a fare that is not a non-negative whole number of paise`,
        );
      }
      const points = reachable.get(cell.serviceClass);
      if (!points) {
        fail(
          where,
          `fare table ${table.fareTableId} prices class ${cell.serviceClass}, and no service using this table runs it`,
        );
      }
      [cell.fromBoardingPointId, cell.toBoardingPointId].forEach((pointId) => {
        if (!points.has(pointId)) {
          fail(
            where,
            `fare table ${table.fareTableId} prices ${pointId}, which no ${cell.serviceClass} service using this table stops at`,
          );
        }
      });
    });
  });
}
