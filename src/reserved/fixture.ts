import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runsOn } from "./calendar.js";
import { validateReservedCatalogue } from "./integrity.js";
import type {
  BoardingPoint,
  FareTable,
  ReservedCatalogue,
  ReservedOperatorKey,
  ReservedOperatorProfile,
  ReservedSearchQuery,
  ReservedService,
  ReservedServiceSource,
  SeatMap,
} from "./types.js";

/**
 * The default source: JSON on disk, and nothing else.
 *
 * No harvester, no statewide database, no cold start. A stranger clones the
 * repository and gets a working reserved intercity seller in under five
 * minutes with nothing else running, which is the same argument the existing
 * fixture source is built on and the property that makes any of this worth
 * publishing.
 *
 * Every fixture file carries a top-level `sourcing` block naming what its
 * figures came from and how strongly. That is the fabrication disclosure in
 * machine-readable form, which is a stronger discipline than a prose
 * disclosure alone because it cannot go stale relative to the data it
 * describes.
 */

/** The shape on disk, before boarding points are joined onto services. */
interface ServiceFile {
  services: Array<
    Omit<ReservedService, "boardingPoints" | "droppingPoints"> & {
      boardingPoints: Array<{
        boardingPointId: string;
        reportingOffsetMinutes: number;
      }>;
      droppingPoints: Array<{
        boardingPointId: string;
        reportingOffsetMinutes: number;
      }>;
    }
  >;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

/**
 * The reporting offset lives on the service rather than on the point, because
 * the same physical stand is a different number of minutes into two different
 * runs. The point file holds identity; the service file holds timing; this is
 * where the two meet.
 */
function resolvePoints(
  refs: Array<{ boardingPointId: string; reportingOffsetMinutes: number }>,
  byId: Map<string, Omit<BoardingPoint, "reportingOffsetMinutes">>,
  serviceId: string,
): BoardingPoint[] {
  return refs.map((ref) => {
    const point = byId.get(ref.boardingPointId);
    if (!point) {
      throw new Error(
        `Service ${serviceId} names boarding point ${ref.boardingPointId}, which no town declares`,
      );
    }
    return { ...point, reportingOffsetMinutes: ref.reportingOffsetMinutes };
  });
}

export async function loadReservedCatalogue(
  fixtureRoot: string,
  operator: ReservedOperatorKey,
): Promise<ReservedCatalogue> {
  const root = join(fixtureRoot, operator);
  const [operatorFile, townFile, pointFile, serviceFile] = await Promise.all([
    readJson<{ operator: ReservedOperatorProfile }>(join(root, "operator.json")),
    readJson<{ towns: ReservedCatalogue["towns"] }>(join(root, "towns.json")),
    readJson<{
      points: Record<string, Array<Omit<BoardingPoint, "townCode" | "reportingOffsetMinutes">>>;
    }>(join(root, "boarding-points.json")),
    readJson<ServiceFile>(join(root, "services.json")),
  ]);

  const boardingPoints = Object.entries(pointFile.points).flatMap(
    ([townCode, points]) => points.map((point) => ({ ...point, townCode })),
  );
  const byId = new Map(
    boardingPoints.map((point) => [point.boardingPointId, point]),
  );

  const services: ReservedService[] = serviceFile.services.map((service) => ({
    ...service,
    boardingPoints: resolvePoints(service.boardingPoints, byId, service.serviceId),
    droppingPoints: resolvePoints(service.droppingPoints, byId, service.serviceId),
  }));

  const seatMapIds = [...new Set(services.map((service) => service.seatMapId))];
  const fareTableIds = [...new Set(services.map((service) => service.fareTableId))];
  const seatMaps = await Promise.all(
    seatMapIds.map(async (id) =>
      (await readJson<{ seatMap: SeatMap }>(join(root, "seatmaps", `${id}.json`)))
        .seatMap,
    ),
  );
  const fareTables = await Promise.all(
    fareTableIds.map(async (id) =>
      (await readJson<{ fareTable: FareTable }>(join(root, "fares", `${id}.json`)))
        .fareTable,
    ),
  );

  return {
    operator: operatorFile.operator,
    towns: townFile.towns,
    // Boarding points on the catalogue carry no reporting offset of their own:
    // a point has no time until a service passes through it.
    boardingPoints: boardingPoints.map((point) => ({
      ...point,
      reportingOffsetMinutes: 0,
    })),
    services,
    seatMaps,
    fareTables,
  };
}

export class FixtureReservedSource implements ReservedServiceSource {
  readonly operator: ReservedOperatorProfile;

  constructor(private readonly catalogue: ReservedCatalogue) {
    this.operator = catalogue.operator;
  }

  /**
   * The whole set is validated at load, so a broken fixture fails at boot
   * rather than at the first select. A reference that does not resolve, an
   * asymmetric seat map or a confidence claim nobody can audit is a bug in the
   * data, and the cheapest moment to find it is before the process is
   * listening.
   */
  static async load(
    fixtureRoot: string,
    operator: ReservedOperatorKey,
  ): Promise<FixtureReservedSource> {
    const catalogue = await loadReservedCatalogue(fixtureRoot, operator);
    validateReservedCatalogue(
      catalogue,
      `Reserved fixture set ${join(fixtureRoot, operator)}`,
    );
    return new FixtureReservedSource(catalogue);
  }

  async services(query: ReservedSearchQuery): Promise<ReservedService[]> {
    return structuredClone(
      this.catalogue.services.filter(
        (service) =>
          service.boardingPoints.some(
            (point) => point.townCode === query.fromTownCode,
          ) &&
          service.droppingPoints.some(
            (point) => point.townCode === query.toTownCode,
          ) &&
          (query.serviceClass === undefined ||
            service.serviceClass === query.serviceClass) &&
          runsOn(service.operatingPattern, query.travelDate),
      ),
    );
  }

  async service(serviceId: string): Promise<ReservedService | undefined> {
    const service = this.catalogue.services.find(
      (candidate) => candidate.serviceId === serviceId,
    );
    return service ? structuredClone(service) : undefined;
  }

  /** Every service the fixture set carries, for integrity checks and tests. */
  async allServices(): Promise<ReservedService[]> {
    return structuredClone(this.catalogue.services);
  }

  async seatMap(seatMapId: string): Promise<SeatMap | undefined> {
    const map = this.catalogue.seatMaps.find(
      (candidate) => candidate.seatMapId === seatMapId,
    );
    return map ? structuredClone(map) : undefined;
  }

  async fareTable(fareTableId: string): Promise<FareTable | undefined> {
    const table = this.catalogue.fareTables.find(
      (candidate) => candidate.fareTableId === fareTableId,
    );
    return table ? structuredClone(table) : undefined;
  }
}
