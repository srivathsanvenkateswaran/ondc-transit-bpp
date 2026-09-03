# HTTP journey source contract

`HttpJourneySource` lets the provider obtain routes and integer-paise fares
from any external planner. The provider remains responsible for converting
those offers into TRV11 catalogues and orders.

Enable it with:

```text
JOURNEY_SOURCE=http
JOURNEY_SOURCE_URL=http://host.docker.internal:3000/api/ondc/offers
```

The provider sends one request per operator search:

```http
POST /api/ondc/offers HTTP/1.1
Content-Type: application/json
Accept: application/json

{
  "operator": "bmtc",
  "from": {
    "code": "INDIRANAGAR_6TH_MAIN",
    "lat": 12.9784,
    "lon": 77.6408
  },
  "to": {
    "code": "KEMPEGOWDA_BUS_STATION",
    "lat": 12.9774,
    "lon": 77.5726
  },
  "departAt": "2026-08-27T09:00:00.000Z"
}
```

`operator` is `bmtc` or `bmrcl`. `from` and `to` carry the search code, GPS
coordinates, or both. They are empty objects for a broad search. `departAt` is
the requested ISO 8601 instant, or the provider's current time if the BAP did
not supply one.

The planner returns:

```json
{
  "offers": [
    {
      "offerId": "planner-500d-20260827-0900",
      "productCode": "SJT",
      "productName": "Single Journey Ticket",
      "farePaise": 2700,
      "validity": "PT2H",
      "routeId": "500D",
      "routeName": "Example bus run",
      "route": [
        {
          "code": "INDIRANAGAR_6TH_MAIN",
          "name": "Indiranagar 6th Main",
          "lat": 12.9784,
          "lon": 77.6408
        },
        {
          "code": "KEMPEGOWDA_BUS_STATION",
          "name": "Kempegowda Bus Station",
          "lat": 12.9774,
          "lon": 77.5726
        }
      ]
    }
  ]
}
```

The complete machine-readable response contract is
[`schemas/journey-source-response.json`](../schemas/journey-source-response.json).
Important constraints include:

- `farePaise` is a non-negative integer. The provider never converts a planner
  float or applies floating-point rounding.
- `productCode` is `SJT`, so the item remains a fare product rather than a
  route or vehicle.
- `offerId` values must be unique within a response; duplicate identities are
  rejected before the catalogue is cached.
- `validity` must be a positive day/hour/minute/second ISO 8601 duration that
  the ticket issuer supports (for example, `PT2H`).
- `route` contains at least two called stops in travel order. Road-shape
  vertices do not belong here.
- Optional `nameLocal`, `isInterchange`, `changeHint`, and `routeColor` values
  pass into the TRV11 fulfillment.
- Optional `serviceTier` is `ORDINARY_BUS`, `AC_BUS` or `METRO`. Only a pass
  settlement claim reads it, to check the ride's class of service against the
  pass's scope. **Omitting it means the operator's vehicle category decides**,
  so a bus ride reads as Ordinary and an AC bus ride cannot be told apart from
  an ordinary one - see [`docs/passes.md`](passes.md). A planner that knows
  the tier should state it; the local fixtures do not.

The deadline is five seconds. A network error, timeout, non-2xx response,
invalid JSON, or schema-invalid response produces a structured `FALLBACK` log
and runs the same search against the local fixtures. This keeps a cold planner
from taking down the demonstration. A fallback fare is still the explicitly
labelled whole-route fixture placeholder and must not be presented as a
distance-correct fare.
