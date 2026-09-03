import type { OperatorRuntimeConfig } from "../config.js";
import type { OnSearchResponse, SearchRequest } from "../protocol/types.js";
import type {
  JourneySource,
  RouteStop,
  SearchQuery,
  TransitOffer,
} from "../sources/types.js";
import { serviceInstant } from "./time.js";

const DECIMAL_COORDINATE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

function parseGps(value: string | undefined) {
  if (!value) return undefined;
  const parts = value.split(",");
  if (parts.length !== 2) {
    throw new Error(
      `GPS must contain exactly one latitude/longitude pair: ${value}`,
    );
  }
  const coordinates = parts.map((part) => part.trim());
  if (coordinates.some((part) => !DECIMAL_COORDINATE.test(part))) {
    throw new Error(`GPS coordinates must be decimal numbers: ${value}`);
  }
  const [lat, lon] = coordinates.map(Number);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    throw new Error(`GPS coordinates are outside valid ranges: ${value}`);
  }
  return { lat, lon };
}

export function searchQueryFromRequest(request: SearchRequest): SearchQuery {
  const fulfillment = request.message.intent.fulfillment;
  if (!fulfillment) {
    throw new Error(
      "Search intent carries no fulfillment; a stop-pair search needs one and a PASS-category search is answered from the pass catalogue instead",
    );
  }
  const starts = fulfillment.stops.filter((stop) => stop.type === "START");
  const ends = fulfillment.stops.filter((stop) => stop.type === "END");
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      "Search fulfillment must contain exactly one START and one END stop",
    );
  }
  const [start] = starts;
  const [end] = ends;
  const fromCode = start.location.descriptor?.code?.trim();
  const toCode = end.location.descriptor?.code?.trim();
  const fromGps = parseGps(start.location.gps);
  const toGps = parseGps(end.location.gps);
  if ((!fromCode && !fromGps) || (!toCode && !toGps)) {
    throw new Error(
      "Each search endpoint must contain a stop code or valid GPS",
    );
  }
  return {
    ...(fromCode ? { fromCode } : {}),
    ...(toCode ? { toCode } : {}),
    ...(fromGps ? { fromGps } : {}),
    ...(toGps ? { toGps } : {}),
    departAt: start.time?.timestamp ?? request.context.timestamp,
    cityCode: request.context.location.city.code,
  };
}

export function paiseToRupees(farePaise: number): string {
  if (!Number.isSafeInteger(farePaise) || farePaise < 0) {
    throw new Error("farePaise must be a non-negative safe integer");
  }
  const rupees = Math.floor(farePaise / 100);
  const paise = farePaise % 100;
  return paise === 0
    ? String(rupees)
    : `${rupees}.${String(paise).padStart(2, "0")}`;
}

function stopType(stop: RouteStop, index: number, count: number) {
  if (index === 0) return "START";
  if (index === count - 1) return "END";
  return stop.isInterchange ? "TRANSIT_STOP" : "INTERMEDIATE_STOP";
}

function mapStop(stop: RouteStop, index: number, count: number) {
  const id = String(index + 1);
  return {
    id,
    ...(index === 0 ? {} : { parent_stop_id: String(index) }),
    type: stopType(stop, index, count),
    ...(stop.changeHint
      ? {
          instructions: {
            name: stop.name,
            short_desc: stop.changeHint,
          },
        }
      : {}),
    location: {
      descriptor: {
        name: stop.name,
        ...(stop.code ? { code: stop.code } : {}),
      },
      gps: `${stop.lat}, ${stop.lon}`,
    },
    ...(stop.nameLocal
      ? {
          tags: [
            {
              descriptor: { code: "LOCAL_NAME" },
              list: [{ descriptor: { code: "NAME" }, value: stop.nameLocal }],
            },
          ],
        }
      : {}),
  };
}

export function fulfillmentIdForOffer(offerId: string): string {
  return `F-${offerId}`;
}

/**
 * The provider-level payment terms. Identical for both categories: the
 * settlement apparatus is structurally present and commercially meaningless
 * whether the item is a single journey or a pass (SPEC section 9).
 */
export function providerPayments(publicBaseUrl: string) {
  return [
    {
      collected_by: "BPP",
      tags: [
        {
          descriptor: { code: "BUYER_FINDER_FEES" },
          display: false,
          list: [
            {
              descriptor: { code: "BUYER_FINDER_FEES_PERCENTAGE" },
              value: "1",
            },
          ],
        },
        {
          descriptor: { code: "SETTLEMENT_TERMS" },
          display: false,
          list: [
            { descriptor: { code: "SETTLEMENT_WINDOW" }, value: "P30D" },
            {
              descriptor: { code: "SETTLEMENT_BASIS" },
              value: "INVOICE_RECEIPT",
            },
            {
              descriptor: { code: "MANDATORY_ARBITRATION" },
              value: "TRUE",
            },
            {
              descriptor: { code: "COURT_JURISDICTION" },
              value: "Bengaluru",
            },
            {
              descriptor: { code: "STATIC_TERMS" },
              value: `${publicBaseUrl}/terms`,
            },
          ],
        },
      ],
    },
  ];
}

export function tripFulfillmentForOffer(
  offer: TransitOffer,
  category: "BUS" | "METRO",
  id = fulfillmentIdForOffer(offer.offerId),
) {
  return {
    id,
    type: "TRIP",
    stops: offer.route.map((stop, index) => mapStop(stop, index, offer.route.length)),
    vehicle: { category },
    tags: [
      {
        descriptor: { code: "ROUTE_INFO" },
        list: [
          { descriptor: { code: "ROUTE_ID" }, value: offer.routeId },
          { descriptor: { code: "ROUTE_NAME" }, value: offer.routeName },
          ...(offer.routeColor
            ? [{ descriptor: { code: "ROUTE_COLOR" }, value: offer.routeColor }]
            : []),
        ],
      },
    ],
  };
}

export async function buildOnSearch(
  request: SearchRequest,
  source: JourneySource,
  operator: OperatorRuntimeConfig,
  options: {
    publicBaseUrl: string;
    contextTtl: string;
    now?: () => Date;
    offers?: TransitOffer[];
  },
): Promise<OnSearchResponse> {
  const now = options.now ?? (() => new Date());
  const offers =
    options.offers ?? (await source.search(searchQueryFromRequest(request)));
  const mappedOffers = offers.map((offer) => ({
    offer,
    fulfillmentId: fulfillmentIdForOffer(offer.offerId),
  }));
  const provider = {
    id: source.operator.id,
    descriptor: { name: source.operator.name },
    categories: [{ id: "C1", descriptor: { name: "Ticket", code: "TICKET" } }],
    time: {
      range: {
        start: serviceInstant(
          request.context.timestamp,
          source.operator.serviceWindow.startHHMM,
        ),
        end: serviceInstant(
          request.context.timestamp,
          source.operator.serviceWindow.endHHMM,
        ),
      },
    },
    items: mappedOffers.map(({ offer, fulfillmentId }) => ({
      id: offer.offerId,
      category_ids: ["C1"],
      descriptor: { name: offer.productName, code: offer.productCode },
      price: { currency: "INR", value: paiseToRupees(offer.farePaise) },
      quantity: { maximum: { count: 6 }, minimum: { count: 1 } },
      fulfillment_ids: [fulfillmentId],
      time: {
        label: "Validity",
        duration: offer.validity,
        timestamp: now().toISOString(),
      },
    })),
    fulfillments: mappedOffers.map(({ offer, fulfillmentId }) =>
      tripFulfillmentForOffer(
        offer,
        source.operator.vehicleCategory,
        fulfillmentId,
      ),
    ),
    payments: providerPayments(options.publicBaseUrl),
  };

  return {
    context: {
      ...request.context,
      action: "on_search",
      bpp_id: operator.subscriberId,
      bpp_uri: operator.subscriberUri,
      timestamp: now().toISOString(),
      ttl: options.contextTtl,
    },
    message: {
      catalog: {
        descriptor: { name: `${source.operator.name} Specimen Catalogue` },
        providers: offers.length === 0 ? [] : [provider],
      },
    },
  };
}
