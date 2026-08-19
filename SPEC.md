# A local ONDC transit network, and the provider adapter that feeds it

**Status:** build-ready specification. No code has been written yet.
**Audience:** an engineer who knows Node, TypeScript and Docker, and knows
neither Beckn nor this project.
**Written:** 19 August 2026. **Deadline it is written against:** 27 August 2026.

---

## 0. Read this first: the headline finding

This document began life as a plan to *build* a mock ONDC network. The research
says do not. Three things already exist, are open source, and between them cover
almost all of it:

1. **`beckn-onix`** installs a complete local Beckn network - registry, gateway,
   BAP adapter, BPP adapter, and a stub provider backend - from one shell script
   over Docker Compose. MIT licensed.
2. **ONDC's TRV11 specification** (`ONDC:TRV11`, "Unreserved Ticket Booking -
   Metro / Intracity Bus") is a published, versioned, example-rich OpenAPI
   repository. Every payload in this document is copied from it, not invented.
3. The ONIX BPP adapter's *shipped example routing config already names
   `ONDC:TRV11`* and routes its actions to a provider backend URL. The extension
   point we need is not something we add; it is the seam the product was built
   around.

So the question is no longer "how do we build a mock network" but "which
existing one do we run, and what small thing do we write on top". The answer:

> **Run `beckn-onix` option 4 (local registry + gateway, no Beckn One) as the
> network. Write exactly one new service: a TRV11 provider backend that answers
> `search`/`select`/`init`/`confirm`/`status` with real BMTC and Namma Metro
> journeys. On the consuming app's side, point its BAP client at the ONIX BAP
> protocol server in synchronous mode, which means the app needs no callback
> endpoints at all for the happy path.**

**Effort dropped from an estimated 7-9 engineering days to 2.5-4.** The single
biggest saving is not the network containers - it is discovering that the ONIX
BAP protocol server supports a **synchronous client mode** (section 5.4), which
deletes the entire async-callback surface the consuming app would otherwise have
had to build, test and debug. See section 12 for the staged estimate and the cut
list.

**On whether this repository should exist at all:** yes, but smaller than the
name suggests, and the name should change. See section 13.

---

## 1. The point, and the fact it rests on

Namma Metro is **genuinely live on the ONDC network today**. BMRCL rolled out
QR ticketing over ONDC in July 2025; tickets are sold through Uber, Navi UPI,
Namma Yatri, Rapido, redBus, Paytm, ixigo and others, all of them buying from
BMRCL through the same protocol this document describes.[^bmrcl][^uber][^navi]

**BMTC is not.** ONDC's intracity bus ticketing is live for Delhi Transport
Corporation, Capital Region Urban Transport (Odisha), BEST (Mumbai) and Katch
Mobility. Bengaluru's bus operator is absent from that list.[^ondc-300k]
ONDC's own resource pages still list intracity bus API specifications as
unreleased at the time of writing.[^ondc-resources]

That asymmetry is the whole argument. A rider in Bengaluru can already buy the
metro half of a multimodal journey from a third-party app over an open network.
They cannot buy the bus half. A local network with a BMRCL BPP and a BMTC BPP,
both answering the same TRV11 calls, is not a pretend version of something that
does not exist - it is a **working demonstration of what BMTC joining the network
that already carries Namma Metro would look like**, built against the real
published specification for exactly that case.

That is a public-interest argument with a real gap behind it, not a technology
demonstration.

### 1.1 The honesty contract

This governs the entire feature and every artefact it produces.

- **No ticket issued through this stack is valid for travel.** Every ticket
  rendered by a consuming app must carry a visible SPECIMEN mark, in every
  surface, at every size.
- **No money moves.** `payment.status` is set to `PAID` in payloads because the
  protocol requires a value there; nothing is charged, no gateway is contacted,
  no settlement occurs. The fidelity table (section 9) states this in the terms
  a judge or reviewer would ask about.
- **No real network participant is contacted or impersonated.** Subscriber IDs
  are local hostnames under a reserved test domain (section 5.3). Nothing in
  this stack is registered with ONDC's staging or production registry, and
  nothing in it should ever be pointed at one without the participant
  onboarding that the real network requires.
- **The provider data is real; the transaction is not.** Routes, stops, fare
  rules and journey times come from published open data. The order, the payment
  and the ticket are fabricated locally.
- Any consuming application must state all of the above in its own README, not
  only here.

---

## 2. Scope

### 2.1 In

The single happy path, twice, for one journey:

```
search → on_search → select → on_select → init → on_init → confirm → on_confirm → status → on_status
```

- **One journey**, multimodal: a BMTC bus leg and a Namma Metro leg, with
  walking legs at the ends.
- **Two BPPs**: one for BMTC, one for BMRCL. Both are the same binary with
  different configuration and different fixtures, because that is what the real
  network looks like - two independent operators answering the same protocol.
- **One gateway broadcast**: the BAP's `search` goes to the gateway, which
  looks the BPPs up in the registry and fans the search out to both. This is
  the single most protocol-characteristic moment in the whole flow and it must
  be visible in the logs.
- **One order per BPP.** A multimodal journey is *two orders*, one per
  operator, because a BPP can only sell what it operates. Section 6.4 explains
  why this matters and how the consuming app stitches them into one itinerary.
- **One specimen ticket per order**, carrying the QR authorization token the
  BPP returns.

### 2.2 Out, explicitly

| Out | Why |
|---|---|
| `cancel` / `on_cancel`, soft and confirmed cancellation | TRV11 models these richly (nine distinct cancellation flows). Real work, no marginal demonstration value. |
| Refunds and settlement | Requires the whole payment and settlement-terms apparatus to mean anything. |
| `update` / `on_update`, `track`, `rating`, `support` | Not on the critical path. |
| Catalogue browsing, passes, round-trip tickets | TRV11 has `SJT`, `RJT` and `PASS` item codes. We issue `SJT` only. |
| Real payment, UPI, payment links | The honesty contract forbids it. |
| Live ONDC onboarding, staging registry subscription | Requires a legal entity, a domain, and ONDC's participant onboarding. Out of reach and out of scope. |
| Pagination of `on_search` | TRV11 defines a pagination flow for bus catalogues. One journey does not need it. |
| Vehicle-based and seller-side confirmation flows | TRV11 intracity-bus variants where the ticket is bound to a specific vehicle at boarding. |

### 2.3 Challenging the original scope

The original proposal named `search → select → init → confirm → status` for one
journey and both operators, and the research **agrees** with it, with two
corrections:

1. **`init` is not optional and not a formality.** In TRV11 `init` is where
   billing details and the payment terms are asserted, and `on_init` returns the
   draft order with settlement terms. Skipping it and jumping `select → confirm`
   would produce a flow that superficially resembles Beckn and is not one.
2. **"One journey, both operators" is two orders, not one.** This was implicit
   in the original framing and it is the single most important structural fact
   for the consuming app. See section 6.4.

---

## 3. Protocol facts, with citations

Every claim in this section has a URL. Where the research could not settle
something it says `UNRESOLVED:` and names what would settle it.

### 3.1 Roles

| Role | Meaning |
|---|---|
| **BAP** - Beckn Application Platform | The buyer-side app. Initiates `search`, `select`, `init`, `confirm`, `status`. |
| **BPP** - Beckn Provider Platform | The seller-side platform. Responds asynchronously with `on_search`, `on_select`, `on_init`, `on_confirm`, `on_status`. |
| **BG** - Beckn Gateway | Broadcasts a BAP's `search` to BPPs. It looks BPPs up in the registry and fans out. It is *only* in the path for `search`; every later action is BAP-to-BPP directly, addressed by the `bpp_id` / `bpp_uri` the BPP put in its own `on_search` context. |
| **Registry** | The participant directory. Holds subscriber IDs, subscriber URIs, public signing keys and domains. Used for signature verification and for the gateway's fan-out. |

Sources: the Beckn ONIX README's role definitions,[^onix-readme] and TRV11's own
sequence diagrams, which show the gateway in the `search` path and absent from
`select` onward.[^trv11-flow]

The TRV11 discovery flow, quoted verbatim from the specification's mermaid
diagram:[^trv11-flow]

```
Buyer Platform (BAP)->>Gateway (BG): search
Gateway (BG) ->> Buyer Platform (BAP): ACK
Gateway (BG)->>Registry: Lookup Seller Platforms (lookup)
Registry->>Gateway (BG): List of Seller Platforms (200 OK)
Gateway (BG)->>Seller Platform (BPP): search
Seller Platform (BPP)->>Gateway (BG) : ACK
Seller Platform (BPP)->>Buyer Platform (BAP): Publish Catalog of Seller 1 (on_search)
Buyer Platform (BAP)->>Seller Platform (BPP): ACK
```

Every subsequent stage is the same two-message shape, BAP to BPP and back:[^trv11-flow]

```
Buyer Platform (BAP)->>Seller Platform (BPP): select
Seller Platform (BPP)-->>Buyer Platform (BAP): ACK
Seller Platform (BPP)->>Buyer Platform (BAP): on_select
Buyer Platform (BAP)-->>Seller Platform (BPP): ACK
```

### 3.2 The asynchronous callback model

This is the fact that shapes the whole architecture, so state it plainly:

**A Beckn call is never answered inline.** A BAP POSTs `search` and receives, on
that same HTTP connection, only an **acknowledgement** - `ACK` or `NACK`. The
actual answer arrives later as a **separate inbound HTTP POST** from the BPP to
the BAP's own `/on_search` endpoint. `ACK` means "your payload passed schema
and signature validation and I have accepted it"; it does not mean "here is your
catalogue".

The `ACK` / `NACK` envelope, quoted from ONDC's mock server documentation:[^mockserver-readme]

```json
{ "message": { "ack": { "status": "ACK" } } }
```

```json
{
  "message": { "ack": { "status": "NACK" } },
  "error": {
    "type": "JSON-SCHEMA-ERROR",
    "code": "50009",
    "message": [ { "message": "must have required property 'domain'" } ]
  }
}
```

A `NACK` means the payload failed schema validation or signature verification.

### 3.3 The `context` object

Every Beckn message, in both directions, carries a `context`. Reproduced here
exactly as it appears in TRV11's own `search` example:[^trv11-search]

```yaml
context:
  location:
    country:
      code: IND
    city:
      code: std:011      # STD dialling code. Bengaluru is std:080.
  domain: ONDC:TRV11
  action: search
  version: 2.0.1
  bap_id: api.example-bap.com
  bap_uri: https://api.example-bap.com/ondc/metro
  bpp_id: api.example-bpp.com
  bpp_uri: https://api.example-bpp.com/ondc/metro
  transaction_id: 6743e9e2-4fb5-487c-92b7-13ba8018f176
  message_id: 6743e9e2-4fb5-487c-92b7-13ba8018f176
  timestamp: '2023-03-23T04:41:16.000Z'
  ttl: PT30S
```

Field-by-field, as used in this build:

| Field | Rule |
|---|---|
| `domain` | `ONDC:TRV11` throughout. |
| `version` | `2.0.1`. This is the TRV11 spec version, not the Beckn core version. |
| `action` | The API being called: `search`, `on_search`, `select`, ... |
| `location.country.code` | `IND`. |
| `location.city.code` | `std:080` for Bengaluru. (`std:011` is Delhi, which is what the upstream examples use.) |
| `transaction_id` | **Constant for the entire lifecycle of one order.** The same UUID appears on `search` and on the final `on_status`. This is the join key for logs, tests and assertions. |
| `message_id` | **New per request/callback pair.** A `select` and its `on_select` share one `message_id`; the following `init` has a different one. |
| `timestamp` | RFC 3339 / ISO 8601 with milliseconds and a `Z` suffix. |
| `ttl` | ISO 8601 duration. TRV11's examples use `PT30S`. The ONIX BAP protocol server's shipped config sets per-action TTLs, `PT15S` for `search` and `PT10S` for the rest.[^onix-bap-config] |
| `bap_id` / `bap_uri` | The BAP's registry subscriber ID and its callback base URI. |
| `bpp_id` / `bpp_uri` | Absent (or ignored) on the initial `search`, since the gateway fans out. Present on everything from `on_search` onward - the BPP stamps its own identity into `on_search`, and the BAP echoes it on `select` and after. |

`UNRESOLVED:` the exact canonical field list and required/optional markers for
Beckn core 1.1.0's `Context`. `developers.becknprotocol.io` now 301-redirects to
`docs.nfh.global`, which documents the newer NFH fabric rather than core 1.1.0.
The authoritative artefact is `schemas/core/v1.1.0/definitions.json#/$defs/Context`
inside `beckn-onix`'s `schemas.zip`,[^onix-schemas] and the builder should read
it directly rather than trust a prose summary. TRV11's own examples, which are
what this build validates against, are reproduced verbatim above and are
sufficient to build from.

### 3.4 The mobility domain: which one, and why it matters

ONDC's mobility specification is split into numbered TRV domains:[^trv-domains][^ondc-mobility-repo]

| Domain | Covers | Latest release branch |
|---|---|---|
| `ONDC:TRV10` | On-demand ride hailing | `release-TRV10-2.1.0` |
| **`ONDC:TRV11`** | **Unreserved ticket booking - metro and intracity bus** | **`release-TRV11-2.0.1`** |
| `ONDC:TRV12` | Airline and intercity bus | `release-TRV12-airline`, `release-TRV12-intercity` |
| `ONDC:TRV13` | Hotels | `release-TRV13-2.0.1` |
| `ONDC:TRV14` | Event ticketing | `release-TRV14-2.0.0` |

**`ONDC:TRV11` is the correct domain for this project and it covers both modes
in one specification.** The repository carries parallel example trees for
`metro/` and `intracity-bus/`, which is precisely the BMRCL / BMTC pairing this
project needs. Its README states that v2.0.1 (20 August 2024) is the "base
version of mobility for metro & intracity", supporting station-code and
GPS-based flows.[^trv11-readme]

Repository: `github.com/ONDC-Official/mobility-specification`, branch
`release-TRV11-2.0.1`. Examples live under
`api/components/examples/{metro,intracity-bus}/<action>/`.

### 3.5 How a route, a fare and a ticket are modelled

This is the part most likely to be got wrong from memory, so it is set out
against the actual example files.

**`Provider`** is the operator. In TRV11's metro `on_search`, the provider is
"Delhi Metro Rail Limited" with id `P1`, and it carries `categories`
(`TICKET` / `PASS`), an operating `time.range`, `items`, `fulfillments`,
`payments` and `tags`.[^trv11-on-search]

**`Item`** is the **fare product**, not the vehicle and not the route. The
metro catalogue lists items like:

```yaml
- id: I1
  category_ids: [C1]
  descriptor:
    name: Single Journey Ticket
    code: SJT
  price:
    currency: INR
    value: '60'
  quantity:
    maximum: { count: 6 }
    minimum: { count: 1 }
  fulfillment_ids: [F1]
  time:
    label: Validity
    duration: PT2D
    timestamp: '2021-03-23T11:01:40.065Z'
```

Note `price.value` is a **string of rupees**, not paise, not a number.

**`Fulfillment`** carries the route. Type `TRIP`, with an ordered `stops` array.
Stop types observed in the metro example: `START`, `INTERMEDIATE_STOP`,
`TRANSIT_STOP` (an interchange, carrying
`instructions.short_desc: "Please Change here for Yellow Line"`), and `END`.
Each stop has `location.descriptor.name`, optionally
`location.descriptor.code`, a `gps` string of the form `"28.686576, 77.441632"`,
an `id`, and a `parent_stop_id` chaining it to the previous stop. The
fulfillment carries `vehicle.category` (`METRO`; `BUS` for intracity) and a
`ROUTE_INFO` tag with `ROUTE_ID` and `ROUTE_NAME`.[^trv11-on-search]

**`Quote`** is the priced total, returned on `on_select` and carried forward
through `on_init` and `on_confirm`:[^trv11-on-select]

```yaml
quote:
  price: { value: '120', currency: INR }
  breakup:
    - title: BASE_FARE
      item:
        id: I1
        price: { currency: INR, value: '60' }
        quantity: { selected: { count: 2 } }
      price: { currency: INR, value: '120' }
```

**`Order`** appears from `on_select` onward: `id`, `status` (`ACTIVE` on a
confirmed order), `items`, `provider`, `fulfillments`, `billing`, `quote`,
`payments`, `cancellation_terms`, `tags`, `created_at`, `updated_at`.

**The ticket, and how the QR is returned.** This is the important one and it is
not obvious. From `on_select` onward, the order carries **additional
fulfillments of type `TICKET`**, one per unit of quantity, each tagged with a
`PARENT_ID` pointing at the `TRIP` fulfillment they belong to. On `on_confirm`
those `TICKET` fulfillments gain a `stops[0].authorization` object holding the
QR:[^trv11-on-confirm]

```yaml
- id: F3
  type: TICKET
  stops:
    - type: START
      authorization:
        type: QR
        token: >-
          aMOPw0KGgoAAAANSUhEUgAAAH0AAAB9AQAAAACn+1GINAAApklEQVR4Xu2U...
        valid_to: '2024-07-23T23:59:59.999Z'
        status: UNCLAIMED
  tags:
    - descriptor: { code: INFO }
      list:
        - descriptor: { code: PARENT_ID }
          value: F1
    - descriptor: { code: TICKET_INFO }
      list:
        - descriptor: { code: NUMBER }
          value: 7ed21b6f
```

So: **`authorization.type: QR`, `authorization.token` a base64 PNG,
`authorization.valid_to` an RFC 3339 expiry, `authorization.status` one of
`UNCLAIMED` / (claimed states), and a human-readable ticket number under a
`TICKET_INFO` tag with code `NUMBER`.** Two tickets means two `TICKET`
fulfillments, `F3` and `F4`, with distinct tokens and distinct numbers.

`UNRESOLVED:` the full enumeration of `authorization.status` values. `UNCLAIMED`
is the only one appearing in the metro examples. The enumeration lives in
`api/components/enum/index.yaml` on the `release-TRV11-2.0.1` branch; the builder
should read it and pin the exact set before asserting on a non-`UNCLAIMED` value.

### 3.6 Request payloads, in full

**`select`** - minimal. Just the item, the selected count and the provider:[^trv11-select]

```yaml
message:
  order:
    items:
      - id: I1
        quantity: { selected: { count: 2 } }
    provider: { id: P1 }
```

**`init`** - adds `billing` and a `payments` array with `status: NOT_PAID`,
`type: PRE_ORDER`, `collected_by: BAP`, and settlement-terms tags.[^trv11-init]

**`confirm`** - the same, with `payments[].status: PAID`, a payment `id`, and
`payments[].params` carrying `transaction_id`, `currency` and `amount`.[^trv11-confirm]

**`status`** - two accepted shapes, `{ order_id: "..." }` or
`{ ref_id: "..." }`.[^trv11-status]

### 3.7 Signing and authentication

Beckn messages on the real network carry an `Authorization` header containing an
Ed25519 signature over a Blake2b hash of the request body, verified against the
sender's public key fetched from the registry. ONDC publishes a signing and
verification guide and reference utilities.[^ondc-signing]

In this build **we do not implement any of this ourselves**. The ONIX
protocol-server and adapter handle signing and verification as a pipeline step -
the Go adapter's step list is literally
`validateSign → addRoute → validateSchema → signAck`,[^onix-bpp-adapter] and its
key manager plugin holds the Ed25519 keypair. Signatures are real inside the
local network because the local registry holds the real public keys the local
participants generated. See the fidelity table (section 9) for what that does
and does not prove.

---

## 4. Build or integrate: the decision

Four candidates were examined. The comparison is on setup cost, mobility
support, protocol fidelity, and how much survives if the stack were ever
pointed at the real network.

### 4.1 `ONDC-Official/ondc-mock-server` - **not recommended**

ONDC's own mock and sandbox. Node/TypeScript, TurboRepo monorepo, Express
backend plus a Vite React frontend, runs under Docker Compose. Its documented
purpose is close to ours: "If you are a buyer app (BAP), you can provide
`/action` APIs payload and you will receive the subsequent sync and async
responses."[^mockserver-readme]

Three findings rule it out.

1. **It does not cover mobility.** Its own README states: "Currently, the mock
   server and sandbox support B2B and services domains."[^mockserver-readme] Its
   `.gitmodules` confirms it: every domain submodule points at
   `ONDC-RET-Specifications`, `ONDC-SRV-Specifications`,
   `ONDC-LOG-Specifications`, `ONDC-MEC-Specifications` or
   `ONDC-AGR-Specifications`. **There is no submodule for
   `mobility-specification` and therefore no TRV domain at all.**[^mockserver-gitmodules]
   The README documents how to add one, and the mechanism is sound, but that is
   work we would be doing, on someone else's monorepo, with no upstream path.
2. **It is not a network.** It validates a payload against a schema and returns
   a canned `on_action`. There is no registry, no gateway, no signing, no
   fan-out, no second provider. The one moment that makes Beckn *look* like
   Beckn - a gateway broadcasting one search to two independent operators - is
   the exact thing it cannot show.
3. **It has no licence file.** The repository contains no `LICENSE`.[^mockserver-nolicense]
   Absent an explicit grant, the default is all rights reserved. Building a
   public open-source project on top of it, or vendoring parts of it, is not
   something to do on an assumption. See section 14.

It remains useful as a **reference for the ACK/NACK envelope and error codes**,
which is how it is cited in section 3.2.

### 4.2 `beckn-onix` - **recommended**

FIDE's reference protocol adapter and network installer. `github.com/beckn/beckn-onix`
and `github.com/Beckn-One/beckn-onix` are the same repository content; use
`beckn/beckn-onix` as canonical. Go 1.24, plugin-based since the August 2025
rewrite; the pre-plugin adapter is preserved on the `main-pre-plugins`
branch.[^onix-readme]

What the installer gives you, and this is the finding that changes the project:

`install/beckn-onix.sh` presents a menu whose **option 4** is
"Set up a network on local machine with local registry and gateway (without
Beckn One)".[^onix-installer] That option runs, in order:[^onix-installer-opt4]

```
install_registry
install_gateway
install_bap_protocol_server
install_bpp_protocol_server_with_sandbox
install_adapter "BOTH"
```

**All four network components on one machine, from one command.** The Compose
files are in the repository and are readable before you run anything:

| Component | Image | Ports | File |
|---|---|---|---|
| Registry | `fidedocker/registry` | 3000, 3030 | `install/docker-compose-registry.yml` |
| Gateway | `fidedocker/gateway` | 4000, 4030 | `install/docker-compose-gateway.yml` |
| BAP client / network | `fidedocker/protocol-server` | 5001, 5002 | `install/docker-compose-bap.yml` |
| BPP client / network | `fidedocker/protocol-server` | 6001, 6002 | `install/docker-compose-bpp-with-sandbox.yml` |
| Stub provider backend | `fidedocker/sandbox-api` | 4010 | same file |
| ONIX adapter + Redis + Vault | `fidedocker/onix-adapter` | 8081 | `install/docker-compose-adapter.yml` |

And the decisive detail: **the ONIX BPP adapter's shipped example routing config
already names `ONDC:TRV11`** and routes its actions to a provider backend
URL:[^onix-bpp-routing]

```yaml
routingRules:
  - domain: "ONDC:TRV11"
    version: "2.0.0"
    routingType: "url"
    target:
      url: "https://services-backend/trv/v1"
    endpoints:
      - select
      - init
      - confirm
```

The seam we need is the seam the product was designed around. We are not
extending ONIX; we are filling in the box its own configuration draws.

The same is true of the older protocol-server path, which option 4 actually
installs: the BPP installer **prompts for a "Webhook URL"** and writes it into
`client.webhook.url` in the BPP client config.[^onix-installer-bpp][^onix-bpp-client-config]
Whatever service sits at that URL *is* the BPP's business logic. That is our one
new service.

Licence: **MIT**, "Copyright (c) 2024 Beckn Protocol".[^onix-licence] (Note the
README badge says Apache 2.0; the `LICENSE` file says MIT. The file governs. See
section 14.)

**Caveat, stated plainly.** The ONIX images are `platform: linux/amd64`. On
Apple Silicon they run under emulation. Expect them to be slow to start and
budget for that in the demo. See section 12's risk list.

### 4.3 `beckn/starter-kit` - **not recommended for this project**

Referenced from ONIX's own setup guide as "the fastest path": it "provisions a
complete working network in a single command: two ONIX adapters (Consumer Node +
Provider Node), sandbox applications, and the NFH fabric services that tie them
together."[^onix-setup] It is genuinely excellent and it is the wrong generation
of the protocol for this project.

The starter kit targets **Beckn 2.0 / NFH fabric**: its action set is
`discover → select → init → confirm`, its registry is the DeDi registry, and
discovery is served by a crawler-fed discovery service reading catalogues a BPP
publishes to its own storage.[^starterkit-readme] ONDC production - and TRV11 -
is the earlier generation: `search → on_search` through a gateway, a subscriber
registry, `ONDC:TRV11` version 2.0.1.

Choosing the starter kit would mean demonstrating a protocol that Namma Metro is
*not* transacting on. That defeats the argument in section 1. It also has no
`LICENSE` file.[^starterkit-nolicense]

Revisit this if the project's horizon extends past this deadline; for a
demonstration whose whole point is "this is the network BMRCL is already on", it
is the wrong choice.

### 4.4 `beckn/beckn-sandbox` - **use as prior art, not as a dependency**

A NestJS service that acts as a BPP's business logic behind the BPP protocol
server, serving fixture JSON per domain. Its README: "Set the
`client.webhook.url` field in BPP Client `config/default.yml` to the address of
this sandbox installation."[^beckn-sandbox-readme] MIT licensed, "Copyright (c)
2022 Beckn".[^beckn-sandbox-licence]

It ships a `src/mobility/` module and a `src/umtc/` (urban mass transit) module
with a full fixture set - `response.search.json`, `response.select.json`,
`response.confirm.json` and so on. The UMTC search fixture is a public transport
catalogue for Delhi Transport Corporation, in Bengaluru's city code
`std:080`.[^beckn-sandbox-umtc]

But its context block reads:

```json
"domain": "mobility:publictransport:0.8.0",
"core_version": "0.9.4"
```

That is Beckn core 0.9.4 with the old `bpp/providers` catalogue shape - several
generations behind TRV11 2.0.1, whose catalogue is `catalog.providers`. **Its
fixtures are not usable as-is.** What *is* usable is its architecture: a small
service, one module per domain, fixture JSON per action, sitting behind the BPP
protocol server's webhook. Our provider backend should look like it and be
written fresh against TRV11.

### 4.5 Also found, worth knowing about

- **`beckn/BAP-sync-adapter`** (Go, Fiber, last updated January 2026). "A
  synchronous wrapper over Beckn protocol APIs. Use this adapter when your BAP
  application must receive synchronous API responses from Beckn ONIX." It
  forwards `POST /api/{action}`, waits for the callback on
  `/webhook/on_{action}`, matches on `transaction_id` and `message_id`, returns
  the callback to the original caller, and times out at 30
  seconds.[^bap-sync-adapter] This is a genuine option for the consuming app
  (section 6.3) and a fallback if the protocol server's own synchronous mode
  disappoints. No `LICENSE` file at time of writing.
- **`beckn/mobility`** - the Beckn (not ONDC) mobility domain adaptation. ONDC's
  TRV11 is downstream of it. Read ONDC's, build against ONDC's.

### 4.6 The recommendation

> **`beckn-onix`, option 4, as the network. One new service on top: a TRV11
> provider backend. Nothing bespoke at the protocol layer.**

| Criterion | Verdict |
|---|---|
| Setup cost | One shell script, one Compose bring-up. Hours, not days. |
| Mobility support | ONIX is domain-agnostic and its own examples already route `ONDC:TRV11`. |
| Protocol fidelity | Real registry, real gateway fan-out, real Ed25519 signing, real schema validation. The highest of the four by a distance. |
| Survives a real-network pivot | **Almost all of it.** The provider backend is the operator's business logic and is unchanged. Pointing at the real network means changing registry URLs, subscribing real keys, and completing ONDC's participant onboarding - configuration and paperwork, not a rewrite. That is the strongest argument of all: the thing we write is the thing a real BPP would write. |

---

## 5. Topology

### 5.1 What runs

Seven containers plus one we write. Several containers, not one, and
deliberately so: the point of the demonstration is that these are **separate
network participants that only know each other through the registry**. Collapsing
them into one process would erase the thing worth showing.

```
                                   ┌───────────────────┐
                                   │     registry      │  :3000 / :3030
                                   │  fidedocker/      │  subscriber IDs,
                                   │    registry       │  public keys, domains
                                   └─────────▲─────────┘
                                             │ lookup
   ┌──────────────┐   search      ┌──────────┴────────┐   search (fan-out)
   │ consuming    │──────────────▶│     gateway       │──────────────┐
   │ app (BAP)    │   :5001       │ fidedocker/gateway│              │
   │              │◀──────────────│      :4000        │              │
   └──────┬───────┘   on_search   └───────────────────┘              │
          │                                                          │
          │ select / init / confirm / status  (direct, no gateway)   │
          │                                                          ▼
   ┌──────▼────────────┐                            ┌────────────────────────────┐
   │  bap-client :5001 │                            │  bpp-network :6002         │
   │  bap-network :5002│                            │  bpp-client  :6001         │
   │  protocol-server  │◀───────on_* callbacks──────│  protocol-server           │
   └───────────────────┘                            └──────────┬─────────────────┘
                                                               │ webhook
                                                               ▼
                                            ┌──────────────────────────────────┐
                                            │  transit-bpp  :7001   ← WE WRITE │
                                            │  TRV11 provider backend          │
                                            │  /bmtc/*      /bmrcl/*           │
                                            └──────────────────────────────────┘
```

### 5.2 One BPP process, two providers, or two processes?

**Recommendation: two BPP protocol-server pairs, one provider-backend process
serving both.**

- Two BPP protocol-server pairs means **two distinct subscriber IDs in the
  registry**, which means the gateway genuinely fans one `search` out to two
  independent participants. That is the demonstration. One BPP returning a
  catalogue with two providers inside it would be an aggregator, not a network,
  and it would quietly misrepresent the thing being argued for.
- One provider-backend process serving both, on two URL prefixes, because they
  are the same code with different fixtures and different fare rules. Two
  processes would be honest topology and wasted RAM. The BPPs are separate
  *network participants*; that separation lives in the registry and the protocol
  servers, which is where it is observable.

If the machine cannot carry two BPP protocol-server pairs (four containers) under
amd64 emulation, cut to one BPP and say so in the demo. See section 12's cut
list. **Do not** fake the fan-out.

### 5.3 Identities

| Participant | Subscriber ID | Subscriber URI | Role |
|---|---|---|---|
| BAP | `bap.transit.localhost` | `http://host.docker.internal:5002` | Buyer app |
| BMTC BPP | `bmtc.bpp.transit.localhost` | `http://host.docker.internal:6002` | Bus operator |
| BMRCL BPP | `bmrcl.bpp.transit.localhost` | `http://host.docker.internal:6102` | Metro operator |
| Gateway | `gateway.transit.localhost` | `http://gateway:4000` | Broadcast |
| Registry | - | `http://registry:3030/subscribers` | Directory |

`.localhost` is reserved by RFC 6761 and cannot resolve on the public internet.
This is deliberate: no identity in this stack can collide with, or be mistaken
for, a real ONDC participant. **Do not** use a real operator's domain, and do not
use `bmtc.gov.in` or `bmrcl.co.in` in any form.

Ed25519 keypairs are generated by the installer
(`install/generate-ed25519-keys.go`) and registered with the local registry. They
are local test keys and must never be reused anywhere else.

### 5.4 The finding that removes the consuming app's callback surface

The ONIX BAP protocol server's client configuration offers three delivery modes,
in documented priority order:[^onix-bap-config]

```yaml
# Priority order will be
# 1. Synchronous
# 2. webhook
# 3. pubSub
client:
  synchronous:
    mongoURL: "mongodb://.../ps?authSource=admin"
  #webhook:
  #  url: "https://.../clientURL"
  #messageQueue:
  #  amqpURL: "amqp://guest:guest@localhost:5672"
```

**In `synchronous` mode the BAP protocol server holds the caller's HTTP request
open, collects the asynchronous callbacks that arrive from the BPPs, and returns
them in the response body.** The consuming app POSTs `search` to
`bap-client:5001/search` and gets the `on_search` results back on that same
call.

This is the single largest simplification in the whole design. Without it, the
consuming app needs six inbound callback endpoints, a correlation store keyed by
`transaction_id` + `message_id`, a timeout policy, and a way for its own UI to
learn that a callback arrived - and it needs all of that to be publicly
reachable from the BPP containers. With it, the app makes five ordinary
request/response calls.

**It costs one thing: the synchronous mode needs MongoDB**, per the config
sample's `client.synchronous.mongoURL`. Add a `mongo` service to the Compose
stack. That is a far better trade than building an async correlation layer.

`UNRESOLVED:` whether synchronous mode aggregates **multiple** `on_search`
callbacks from **two** BPPs into one response, or returns only the first to
arrive within the `search` TTL (`PT15S` in the shipped config). This is the one
open question that can materially change the consuming app's code, and it is
settled in fifteen minutes by bringing the stack up and firing one `search` at
two registered BPPs. **Do this on day one.** If it returns only one, fall back to
webhook mode with `beckn/BAP-sync-adapter` (section 4.5), or issue one `search`
per BPP with `bpp_id` pinned. Budget for it in section 12.

---

[^bmrcl]: BMRCL enables QR ticketing via ONDC on nine apps, July 2025. https://www.theweek.in/wire-updates/national/2025/07/08/srg8-ka-metro-tickets.html
[^uber]: "Now buy Metro Tickets on Uber powered by ONDC". https://www.uber.com/en-IN/newsroom/now-buy-metro-tickets-on-uber-powered-by-ondc-b2b-logistics-next
[^navi]: "Bengaluru's Namma Metro QR tickets now on Navi UPI", Deccan Herald. https://www.deccanherald.com/india/karnataka/bengaluru/bengalurus-namma-metro-qr-tickets-now-on-navi-upi-3807355
[^ondc-300k]: "Govt-backed ONDC enables over 300,000 daily bus, metro ticket bookings", Business Standard, 1 June 2026. https://www.business-standard.com/industry/news/ondc-enables-three-lakh-daily-bus-and-metro-ticket-bookings-126060101212_1.html
[^ondc-resources]: ONDC Mobility resources and knowledge base. https://resources.ondc.org/mobility
[^onix-readme]: Beckn ONIX README, "Key Concepts". https://github.com/beckn/beckn-onix/blob/main/README.md
[^trv11-flow]: TRV11 intracity purchase journey flow. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/flows/intracity___purchase_journey_flow_code_based_/index.yaml
[^mockserver-readme]: ONDC Mock & Sandbox README. https://github.com/ONDC-Official/ondc-mock-server/blob/main/README.md
[^trv11-search]: TRV11 metro `search` by station code. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/search/Search_for_public__transit_via_station_code_and_vehicle_type_43.yaml
[^onix-bap-config]: ONIX BAP protocol-server config sample. https://github.com/beckn/beckn-onix/blob/main/install/protocol-server-data/bap-client.yaml-sample
[^onix-schemas]: `schemas.zip` in beckn-onix, containing `schemas/core/v1.1.0/` and `schemas/ondc_trv10/v2.0.0/`. https://github.com/beckn/beckn-onix/blob/main/schemas.zip
[^trv-domains]: TRV domain branches in the ONDC mobility specification repository. https://github.com/ONDC-Official/mobility-specification/branches
[^ondc-mobility-repo]: https://github.com/ONDC-Official/mobility-specification
[^trv11-readme]: TRV11 2.0.1 README. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/README.md
[^trv11-on-search]: TRV11 metro `on_search`, station-code / GPS based. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/on_search/Return_a_metro_catalog_of_fare_products_based_on_station_code_or_gps_based_search_53.yaml
[^trv11-on-select]: TRV11 metro `on_select`. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/on_select/Return_a_quote_offered_by_a_public_transit_service_provider_54.yaml
[^trv11-on-confirm]: TRV11 metro `on_confirm`. https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/on_confirm/Return_confirmed_ticket_order_with_payment_confirmation_56.yaml
[^trv11-select]: https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/select/Get_a_quote_for_a_fare_product_selected_from_a_public_transit_catalog_44.yaml
[^trv11-init]: https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/init/Initialize_the_order_by_providing_billing_details_45.yaml
[^trv11-confirm]: https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/confirm/Confirm_ticket_booking_46.yaml
[^trv11-status]: https://github.com/ONDC-Official/mobility-specification/blob/release-TRV11-2.0.1/api/components/examples/metro/status/Get_latest_status_of_a_transit_ticket_booking_49.yaml
[^ondc-signing]: ONDC signing and verification guide. https://github.com/ONDC-Official/developer-docs/blob/main/registry/signing-verification.md
[^onix-bpp-adapter]: ONIX BPP adapter configuration, `steps:` list. https://github.com/beckn/beckn-onix/blob/main/config/onix-bpp/adapter.yaml
[^mockserver-gitmodules]: `.gitmodules` in ondc-mock-server: every domain submodule is retail, services, logistics, MEC or agri. https://github.com/ONDC-Official/ondc-mock-server/blob/main/.gitmodules
[^mockserver-nolicense]: Repository root, no `LICENSE` file present. https://github.com/ONDC-Official/ondc-mock-server
[^onix-installer]: `install/beckn-onix.sh`, top-level menu. https://github.com/beckn/beckn-onix/blob/main/install/beckn-onix.sh
[^onix-installer-opt4]: Same file, the `choice -eq 4` branch.
[^onix-bpp-routing]: ONIX BPP receiver routing rules, naming `ONDC:TRV11`. https://github.com/beckn/beckn-onix/blob/main/config/onix-bpp/bppTxnReciever-routing.yaml
[^onix-installer-bpp]: Same installer, the `"BPP"` branch, which prompts `Enter Webhook URL:`.
[^onix-bpp-client-config]: BPP protocol-server client config sample, `client.webhook.url`. https://github.com/beckn/beckn-onix/blob/main/install/protocol-server-data/bpp-client.yaml-sample
[^onix-licence]: https://github.com/beckn/beckn-onix/blob/main/LICENSE
[^onix-setup]: Beckn ONIX setup guide, "The Fastest Path: NFH Fabric Starter Kit". https://github.com/beckn/beckn-onix/blob/main/SETUP.md
[^starterkit-readme]: https://github.com/beckn/starter-kit/blob/main/README.md
[^starterkit-nolicense]: Repository root, no `LICENSE` file present. https://github.com/beckn/starter-kit
[^beckn-sandbox-readme]: https://github.com/beckn/beckn-sandbox/blob/main/README.md
[^beckn-sandbox-licence]: https://github.com/beckn/beckn-sandbox/blob/main/LICENSE
[^beckn-sandbox-umtc]: https://github.com/beckn/beckn-sandbox/blob/main/src/umtc/response/response.search.json
[^bap-sync-adapter]: https://github.com/beckn/BAP-sync-adapter/blob/main/README.md
