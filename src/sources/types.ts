/** Where a provider backend gets journeys and fares from. */
export interface JourneySource {
  /** Static facts about the operator this source speaks for. */
  readonly operator: OperatorProfile;

  /** Answer one TRV11 search. Returns zero or more sellable offers. */
  search(query: SearchQuery): Promise<TransitOffer[]>;
}

export type OperatorKey = "bmtc" | "bmrcl";

/**
 * The class of service a ride is on, and the axis a pass scopes to. A pass
 * covers a tier by the class-based rule in `src/trv11/pass.ts`: a higher
 * class is honoured on a lower service, never the reverse.
 */
export type ServiceTier = "ORDINARY_BUS" | "AC_BUS" | "METRO";

export interface OperatorProfile {
  id: string;
  name: string;
  vehicleCategory: "BUS" | "METRO";
  serviceWindow: { startHHMM: string; endHHMM: string };
}

export interface SearchQuery {
  fromCode?: string;
  toCode?: string;
  fromGps?: { lat: number; lon: number };
  toGps?: { lat: number; lon: number };
  departAt?: string;
  cityCode: string;
}

export interface TransitOffer {
  offerId: string;
  productCode: "SJT";
  productName: string;
  farePaise: number;
  /**
   * Optional. Only a pass settlement claim reads this, to check the ride's
   * tier against the pass's scope. When a source does not supply it the tier
   * falls back to the operator's vehicle category (`defaultServiceTier`),
   * which for BMTC means Ordinary - what the fixture fares actually are.
   */
  serviceTier?: ServiceTier;
  validity: string;
  route: RouteStop[];
  routeId: string;
  routeName: string;
  routeColor?: string;
}

export interface FixtureOffer extends Omit<TransitOffer, "farePaise"> {
  /** Placeholder fare for the complete fixture route, not a distance model. */
  wholeRouteFarePaise: number;
}

export interface RouteStop {
  code?: string;
  name: string;
  nameLocal?: string;
  lat: number;
  lon: number;
  isInterchange?: boolean;
  changeHint?: string;
}

export interface FixtureFile {
  operator: OperatorProfile;
  offers: FixtureOffer[];
}
