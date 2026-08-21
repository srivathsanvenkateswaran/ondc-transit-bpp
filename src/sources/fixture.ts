import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  FixtureFile,
  JourneySource,
  OperatorKey,
  RouteStop,
  SearchQuery,
  TransitOffer,
} from "./types.js";
import { validateOfferSet } from "./validate.js";

const EARTH_RADIUS_KM = 6371;

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineKm(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): number {
  const latitudeDelta = radians(to.lat - from.lat);
  const longitudeDelta = radians(to.lon - from.lon);
  const fromLatitude = radians(from.lat);
  const toLatitude = radians(to.lat);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

function codeIndex(route: RouteStop[], code: string | undefined): number {
  const wanted = normalized(code);
  return route.findIndex((stop) => normalized(stop.code) === wanted);
}

function nearestIndex(
  route: RouteStop[],
  point: { lat: number; lon: number },
): { index: number; distanceKm: number } {
  return route.reduce(
    (best, stop, index) => {
      const distanceKm = haversineKm(point, stop);
      return distanceKm < best.distanceKm ? { index, distanceKm } : best;
    },
    { index: -1, distanceKm: Number.POSITIVE_INFINITY },
  );
}

function sliceOffer(
  offer: TransitOffer,
  fromIndex: number,
  toIndex: number,
): TransitOffer | undefined {
  if (fromIndex < 0 || toIndex <= fromIndex) {
    return undefined;
  }
  return { ...offer, route: offer.route.slice(fromIndex, toIndex + 1) };
}

export class FixtureJourneySource implements JourneySource {
  readonly operator;

  constructor(
    private readonly offers: TransitOffer[],
    operator: FixtureFile["operator"],
    private readonly nearestStopRadiusKm = 3,
  ) {
    this.operator = operator;
  }

  static async load(
    fixtureRoot: string,
    operator: OperatorKey,
    nearestStopRadiusKm = 3,
  ): Promise<FixtureJourneySource> {
    const path = join(fixtureRoot, operator, "offers.json");
    const fixture = JSON.parse(await readFile(path, "utf8")) as FixtureFile;
    if (!fixture.operator || !Array.isArray(fixture.offers)) {
      throw new Error(`Invalid fixture file: ${path}`);
    }
    const offers = fixture.offers.map(({ wholeRouteFarePaise, ...offer }) => ({
      ...offer,
      farePaise: wholeRouteFarePaise,
    }));
    validateOfferSet(offers, `Fixture file ${path}`);
    return new FixtureJourneySource(
      offers,
      fixture.operator,
      nearestStopRadiusKm,
    );
  }

  async search(query: SearchQuery): Promise<TransitOffer[]> {
    const hasFrom = Boolean(query.fromCode || query.fromGps);
    const hasTo = Boolean(query.toCode || query.toGps);
    if (hasFrom && hasTo) {
      return this.offers.flatMap((offer) => {
        const fromIndex = query.fromCode
          ? codeIndex(offer.route, query.fromCode)
          : this.nearestStopIndex(offer.route, query.fromGps!);
        const toIndex = query.toCode
          ? codeIndex(offer.route, query.toCode)
          : this.nearestStopIndex(offer.route, query.toGps!);
        const match = sliceOffer(offer, fromIndex, toIndex);
        return match ? [match] : [];
      });
    }

    return structuredClone(this.offers);
  }

  private nearestStopIndex(
    route: RouteStop[],
    point: { lat: number; lon: number },
  ): number {
    const nearest = nearestIndex(route, point);
    return nearest.distanceKm <= this.nearestStopRadiusKm ? nearest.index : -1;
  }
}
