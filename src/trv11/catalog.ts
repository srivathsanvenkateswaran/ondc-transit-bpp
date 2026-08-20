import type { OperatorRuntimeConfig } from "../config.js";
import type { OnSearchResponse, SearchRequest } from "../protocol/types.js";
import type {
  JourneySource,
  RouteStop,
  SearchQuery,
  TransitOffer,
} from "../sources/types.js";

function parseGps(value: string | undefined) {
  if (!value) return undefined;
  const [lat, lon] = value.split(",").map((part) => Number(part.trim()));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
}

export function searchQueryFromRequest(request: SearchRequest): SearchQuery {
  const fulfillment = request.message.intent.fulfillment;
  const start = fulfillment.stops.find((stop) => stop.type === "START");
  const end = fulfillment.stops.find((stop) => stop.type === "END");
  if (!start || !end) {
    throw new Error("Search fulfillment must contain START and END stops");
  }
  return {
    fromCode: start.location.descriptor?.code,
    toCode: end.location.descriptor?.code,
    fromGps: parseGps(start.location.gps),
    toGps: parseGps(end.location.gps),
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
    ...(index === 0
      ? {}
      : {
          instructions: {
            name: `Stop ${index}`,
            ...(stop.changeHint ? { short_desc: stop.changeHint } : {}),
          },
        }),
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

function fulfillment(offer: TransitOffer, category: "BUS" | "METRO") {
  const id = `F${offer.offerId.replace(/\D/g, "") || "1"}`;
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

function serviceInstant(timestamp: string, hhmm: string): string {
  const date = timestamp.slice(0, 10);
  return `${date}T${hhmm}:00.000+05:30`;
}

export async function buildOnSearch(
  request: SearchRequest,
  source: JourneySource,
  operator: OperatorRuntimeConfig,
  options: { publicBaseUrl: string; contextTtl: string; now?: () => Date },
): Promise<OnSearchResponse> {
  const now = options.now ?? (() => new Date());
  const offers = await source.search(searchQueryFromRequest(request));
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
    items: offers.map((offer) => ({
      id: offer.offerId,
      category_ids: ["C1"],
      descriptor: { name: offer.productName, code: offer.productCode },
      price: { currency: "INR", value: paiseToRupees(offer.farePaise) },
      quantity: { maximum: { count: 6 }, minimum: { count: 1 } },
      fulfillment_ids: [`F${offer.offerId.replace(/\D/g, "") || "1"}`],
      time: {
        label: "Validity",
        duration: offer.validity,
        timestamp: now().toISOString(),
      },
    })),
    fulfillments: offers.map((offer) =>
      fulfillment(offer, source.operator.vehicleCategory),
    ),
    payments: [
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
                value: `${options.publicBaseUrl}/terms`,
              },
            ],
          },
        ],
      },
    ],
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
