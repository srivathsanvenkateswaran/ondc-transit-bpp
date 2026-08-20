/** Where a provider backend gets journeys and fares from. */
export interface JourneySource {
  /** Static facts about the operator this source speaks for. */
  readonly operator: OperatorProfile;

  /** Answer one TRV11 search. Returns zero or more sellable offers. */
  search(query: SearchQuery): Promise<TransitOffer[]>;
}

export type OperatorKey = "bmtc" | "bmrcl";

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
  validity: string;
  route: RouteStop[];
  routeId: string;
  routeName: string;
  routeColor?: string;
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
  offers: TransitOffer[];
}
