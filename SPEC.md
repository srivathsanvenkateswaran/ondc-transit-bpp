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
had to build, test and debug. See section 13 for the staged estimate and the cut
list.

**On whether this repository should exist at all:** yes, but smaller than the
name suggests, and the name should change. See section 14.

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
   something to do on an assumption. See section 14.3.

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
budget for that in the demo. See section 13's risk list.

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
amd64 emulation, cut to one BPP and say so in the demo. See section 13's cut
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
per BPP with `bpp_id` pinned. Budget for it in section 13.

---

---

## 6. What we build, and in which repository

Two pieces of work, on opposite sides of a boundary that must not be crossed.

| Piece | Repository | Depends on |
|---|---|---|
| **A. The TRV11 provider backend** and the Compose stack that runs the network around it | **this repository** | Nothing outside itself. No transit app, no planner library. |
| **B. The BAP client** - the code that speaks to the network | **the consuming transit application** | This repository only as a running service on a URL. No source dependency in either direction. |

**This repository must never import from, vendor, or require a consuming
application.** It is a standalone Beckn provider platform for Bengaluru public
transport that happens to have been written alongside one. Any BAP - written in
any language, by anyone - must be able to transact against it by following this
document.

Section 7 defines the interface that keeps that true. Section 8 is work item B
and is marked as such throughout.

### 6.1 Piece A: the provider backend (this repository)

A single small HTTP service. Node 22 + TypeScript, matching the tooling most
likely to be on the machine and matching `beckn-sandbox`'s shape (section 4.4).

**It receives** a POST from the BPP protocol server for every inbound action.
The protocol server delivers to whatever URL is configured as
`client.webhook.url`.[^onix-bpp-client-config]

**It replies** twice: an immediate `ACK` on the open connection, and then a
separate POST of the `on_*` payload back to the **BPP client** endpoint
(`http://bpp-client:6001/on_search` and so on), which signs it and dispatches it
onto the network. This two-step is exactly how `beckn-sandbox` works and is why
its README asks for both a webhook URL *and* a BPP Client URL.[^beckn-sandbox-readme]

Endpoints, one set per operator prefix:

| Method | Path | Receives | Then POSTs to bpp-client |
|---|---|---|---|
| POST | `/{operator}/search` | TRV11 `search` | `/on_search` |
| POST | `/{operator}/select` | TRV11 `select` | `/on_select` |
| POST | `/{operator}/init` | TRV11 `init` | `/on_init` |
| POST | `/{operator}/confirm` | TRV11 `confirm` | `/on_confirm` |
| POST | `/{operator}/status` | TRV11 `status` | `/on_status` |
| GET | `/healthz` | - | - |
| GET | `/orders/{order_id}` | Bearer token | - (optional debug/inspection only, not protocol) |

`{operator}` is `bmtc` or `bmrcl`. Two BPP protocol-server pairs, two webhook
URLs, one process.

**Every response body is validated against the TRV11 schema before it is sent.**
Not optional. A provider backend that emits payloads the network would `NACK` is
worse than no provider backend, because it looks like it works. See section 11.3.

### 6.2 Piece B: the BAP client (the consuming application)

**This section describes work in the consuming transit application, not in this
repository.** It is written against a Next.js App Router backend with existing
routes under `app/api/`, because that is the first consumer; the shape
generalises.

Given synchronous mode (section 5.4), the consuming app needs **no inbound
callback endpoints** for the happy path. It needs one new module and a small
number of routes.

New module, `src/ondc/`:

| File | Responsibility |
|---|---|
| `context.ts` | Build a TRV11 `context` for an action. Owns `transaction_id` continuity and `message_id` freshness. |
| `client.ts` | POST an action to the BAP protocol server and return the parsed callback. One function per action. |
| `types.ts` | TypeScript types for the TRV11 subset in play: `Context`, `Order`, `Item`, `Fulfillment`, `Quote`, `Payment`, `Authorization`. |
| `order.ts` | Drive one order through `search → select → init → confirm → status` and return the confirmed order. |
| `journey.ts` | Drive the two per-operator orders for one multimodal journey (section 6.4). |
| `config.ts` | `ONDC_BAP_CLIENT_URL`, `ONDC_BAP_ID`, `ONDC_ENABLED`. |

New routes under `app/api/ondc/`:

| Route | Purpose |
|---|---|
| `POST /api/ondc/quote` | Takes a chosen itinerary, runs `search → select` per operator, returns the quotes. |
| `POST /api/ondc/book` | Runs `init → confirm` per operator, issues the specimen ticket, returns it. |
| `GET /api/ondc/status/[transactionId]` | Runs `status`, returns `on_status`. |
| `GET /api/ondc/health` | Reports whether the local network is reachable. Drives the UI's "ONDC network: connected" indicator. |

**`ONDC_ENABLED` defaults to false and the app must work identically with the
network absent.** The network is a development and demonstration dependency, not
a runtime one. A journey planner that stops planning journeys because a Docker
stack is down has been made worse, not better.

**If synchronous mode turns out not to aggregate two BPPs** (the `UNRESOLVED:`
in section 5.4), add these under `app/api/ondc/callback/`, one per action, and a
correlation store keyed by `transaction_id` + `message_id`:
`on_search`, `on_select`, `on_init`, `on_confirm`, `on_status`. That is roughly
a day of extra work and it is the largest single schedule risk in the project.

### 6.3 The call sequence, end to end

```
consuming app                bap-client   gateway   registry   bmtc-bpp   bmrcl-bpp   transit-bpp
     │                            │          │          │          │          │            │
     │ POST /search ─────────────▶│          │          │          │          │            │
     │                            │─ search ─▶          │          │          │            │
     │                            │          │─ lookup ─▶          │          │            │
     │                            │          │◀── 2 BPPs ─         │          │            │
     │                            │          │─ search ────────────▶          │            │
     │                            │          │─ search ───────────────────────▶            │
     │                            │          │                     │ webhook  │            │
     │                            │          │                     ├──────────┼───────────▶│
     │                            │          │                     │          ├───────────▶│
     │                            │◀── on_search ────────────────────          │            │
     │                            │◀── on_search ───────────────────────────────            │
     │◀─ on_search × 2 (sync) ────│          │          │          │          │            │
     │                            │          │          │          │          │            │
     │ POST /select (bpp_id set) ─▶─ select ──────────────────────▶│ ─────────────────────▶│
     │◀─ on_select ───────────────│◀─────────────────────────────── ◀──────────────────────│
     │                    ... init, confirm, status: same shape, no gateway ...
```

Note the gateway appears **once**. Everything after `on_search` is addressed
directly using the `bpp_id` and `bpp_uri` the BPP stamped into its own
`on_search` context.

### 6.4 One journey is two orders

A BPP can only sell what its operator runs. A bus leg and a metro leg are sold
by two different operators, so a multimodal journey produces **two independent
Beckn transactions**, each with its own `transaction_id`, its own order id, and
its own ticket.

This is not a limitation of the mock. It is how the real network works today,
and it is the reason ONDC's multimodal ambition is hard. The consuming app is
what makes two orders read as one journey, and saying so out loud is a stronger
demonstration than hiding it.

Consequences the builder must handle:

- **Partial failure is real.** If the bus order confirms and the metro order
  does not, the traveller holds half a journey. In scope for this build: detect
  it and surface it honestly ("1 of 2 legs booked"). Out of scope: compensating
  cancellation, which needs `cancel` (section 2.2).
- **Walk legs are not sold by anyone.** They appear in the itinerary and in no
  order.
- **Two `transaction_id`s per journey.** The consuming app needs a journey-level
  identifier of its own that groups them. Do not reuse a `transaction_id` across
  operators; it is the network's correlation key, not ours.

---

## 7. How the provider backend produces its answers

This is the section that decides whether the project is a standalone thing or a
satellite of one application. The answer is a **two-layer design with a
documented interface between them**.

### 7.1 The `JourneySource` interface

The protocol layer knows nothing about Bengaluru, buses, or any planner. It
knows one interface:

```ts
/** Where a provider backend gets journeys and fares from. */
export interface JourneySource {
  /** Static facts about the operator this source speaks for. */
  readonly operator: OperatorProfile

  /** Answer one TRV11 search. Returns zero or more sellable offers. */
  search(query: SearchQuery): Promise<TransitOffer[]>
}

export interface OperatorProfile {
  /** Provider id in the catalogue, e.g. "bmtc" -> P1. */
  id: string
  /** Display name, e.g. "Bengaluru Metropolitan Transport Corporation". */
  name: string
  /** TRV11 vehicle category: "BUS" or "METRO". */
  vehicleCategory: 'BUS' | 'METRO'
  /** Operating window, used for provider.time.range. */
  serviceWindow: { startHHMM: string; endHHMM: string }
}

export interface SearchQuery {
  /** Present when the BAP searched by station/stop code. */
  fromCode?: string
  toCode?: string
  /** Present when the BAP searched by GPS. Decimal degrees. */
  fromGps?: { lat: number; lon: number }
  toGps?: { lat: number; lon: number }
  /** Absolute departure instant, ISO 8601. Defaults to now. */
  departAt?: string
  /** Echoed from context.location.city.code, e.g. "std:080". */
  cityCode: string
}

export interface TransitOffer {
  /** Stable within one search response; becomes Item.id (I1, I2, ...). */
  offerId: string
  /** Becomes Item.descriptor: SJT for a single journey ticket. */
  productCode: 'SJT'
  productName: string
  /** Integer paise. The protocol layer converts to a rupee string. */
  farePaise: number
  /** How long the ticket stays valid once issued, ISO 8601 duration. */
  validity: string
  /** The ride this offer sells, in travel order. */
  route: RouteStop[]
  /** Human route identity: BMTC "500D", metro "Purple Line". */
  routeId: string
  routeName: string
  /** Optional colour for the line, hex. Metro only. */
  routeColor?: string
}

export interface RouteStop {
  /** Stable stop identifier; becomes location.descriptor.code where known. */
  code?: string
  name: string
  /** Optional local-script name. Carried through as a tag, not dropped. */
  nameLocal?: string
  lat: number
  lon: number
  /** True at an interchange; becomes stop type TRANSIT_STOP. */
  isInterchange?: boolean
  /** Rendered into instructions.short_desc at a TRANSIT_STOP. */
  changeHint?: string
}
```

Everything downstream of `TransitOffer` is pure protocol shaping and lives in
this repository. Everything upstream is somebody's transit data.

### 7.2 Two implementations ship, and the default is fixtures

**`FixtureJourneySource` - the default, and the right boundary for a standalone
project.**

Reads `TransitOffer[]` from JSON under `fixtures/{operator}/`, matching on
origin and destination code (or nearest-stop for a GPS search, by plain
haversine). No planner, no graph, no GTFS, no 1.5 GB of memory, no cold start.
The repository is cloneable, runnable and testable by anyone in under five
minutes with no other project present.

This is the honest default for an open-source provider platform, and it is what
makes this repository worth publishing at all. A stranger who clones it gets a
working Bengaluru TRV11 BPP.

**`HttpJourneySource` - the optional adapter that makes a demo real.**

Calls an external planner over HTTP and maps the response into `TransitOffer[]`.
Configured by one environment variable:

```
JOURNEY_SOURCE=http
JOURNEY_SOURCE_URL=http://host.docker.internal:3000/api/ondc/offers
```

The contract it expects is published in this repository as
`docs/journey-source-http.md` and as a JSON Schema in
`schemas/journey-source-response.json`, so that **any** planner can satisfy it:

```
POST {JOURNEY_SOURCE_URL}
Content-Type: application/json

{ "operator": "bmtc",
  "from": { "code": "…", "lat": 12.9784, "lon": 77.6408 },
  "to":   { "code": "…", "lat": 12.9774, "lon": 77.5726 },
  "departAt": "2026-08-27T09:00:00.000Z" }

200 OK
{ "offers": [ TransitOffer, … ] }
```

Timeout 5 seconds; on timeout or error, fall back to fixtures and log that it
did. A demo must not die because a planner is cold.

### 7.3 Worked example: a transit planner as the HTTP journey source

**This subsection describes work in a consuming application.** It uses the Tatak
journey planner as the worked example because it is the first consumer; nothing
in this repository depends on it.

That application already computes everything `TransitOffer` needs. Its planner
entry point is:

```ts
planJourney(graph, req: PlanRequest, lineColors, zones, lineNetworks): PlanResponse
```

returning `{ itineraries: Itinerary[], earliestServiceSeconds: number | null }`,
where an `Itinerary` is `{ legs: LegInfo[], totalDurationSeconds, totalFarePaise,
transfers, tags }`. Fares are integer paise, computed per leg by
`busFarePaise(metres, tier, city)` for bus and `metroRunFarePaise({bands, metres},
rules)` for a maximal same-network metro run.

The adapter is one new route in that application - `POST /api/ondc/offers` - that
calls `planJourney`, filters the itinerary's legs to the requested operator's
mode, and maps each contiguous run onto one `TransitOffer`. The mapping:

| `TransitOffer` field | Source in that planner |
|---|---|
| `farePaise` | `LegInfo.farePaise` for a bus run; the metro run's fare from `metroRunFarePaise` for a metro run. Already integer paise; no conversion, no rounding. |
| `routeId`, `routeName` | `LegInfo.routeShortName` (bus: `500D`); the line name for metro. |
| `routeColor` | `LegInfo.lineColor`, already the official line colour. |
| `route[]` | `LegInfo.stopPoints`, which is `{lat, lon, name}` per called stop, in travel order. **Not** `LegInfo.path`, which is road geometry from `shapes.txt` and has a vertex wherever the road bends, not one per stop. Confusing the two would publish a catalogue with hundreds of fictional stops. |
| `route[].nameLocal` | `LegInfo.fromStopNameLocal` / `toStopNameLocal` carry Kannada names for the endpoints. |
| `route[].isInterchange` | True where a metro run changes line. |
| `validity` | Derived from `Itinerary.totalDurationSeconds` plus a grace window. |
| `productCode` | Always `SJT`. |

Two facts about that planner that the mapping must respect, both documented in
its own source:

1. **`LegInfo.durationSeconds` already includes the wait before boarding.**
   Accumulate durations across legs from the journey's departure; never add
   `departureSeconds + durationSeconds` for a leg in isolation. Getting this
   wrong produces a catalogue whose times drift later with every leg.
2. **`LegInfo.waitIsEstimated`** is true when the wait is `headway / 2` rather
   than a published departure - always true for metro, since the feed carries no
   metro timetable. If a `TransitOffer` ever grows a departure time, that flag
   must travel with it. Publishing an estimate as a timetable in a catalogue
   would be exactly the kind of quiet dishonesty the honesty contract exists to
   prevent.

### 7.4 Which source for which purpose

| Purpose | Source | Why |
|---|---|---|
| This repository's own tests | `fixture` | Deterministic, fast, no external service. |
| A stranger cloning this repository | `fixture` | It works immediately. |
| The demo video | `http` | The catalogue then carries real BMTC route numbers, real Kannada station names and real fares, which is the whole point. |
| CI | `fixture` | No network, no planner. |

---

## 8. The ticket, and the honesty contract in force

**This section describes work in a consuming application.** The provider backend
mints the ONDC-shaped ticket; the consuming app renders it.

### 8.1 What the BPP returns

Per section 3.5, `on_confirm` carries one `TICKET`-type fulfillment per ticket,
each with `stops[0].authorization` holding `type: QR`, a base64 `token`, a
`valid_to` expiry and `status: UNCLAIMED`, plus a `TICKET_INFO` tag whose
`NUMBER` is the human-readable ticket number.

The provider backend generates that token itself. Two acceptable choices:

- **Preferred:** encode a plainly-marked specimen string as a real QR PNG, e.g.
  `SPECIMEN|TRV11|{order_id}|{ticket_number}|NOT VALID FOR TRAVEL`. Anyone who
  scans it reads a disclaimer.
- **Acceptable:** a deterministic placeholder image derived from the order id.

**Never** encode anything that could be mistaken for a real operator's ticket
payload, and never reproduce a real BMRCL or BMTC QR format.

### 8.2 Turning an order into a specimen ticket

In the consuming application, a new pure function alongside the existing ticket
issuer:

```ts
ticketFromOndcOrder(order: OndcOrder, opts?): Ticket
```

- `id` ← `order.id` from `on_confirm`.
- `totalFarePaise` ← `order.quote.price.value` rupee string → paise.
  **Parse to integer paise, do not carry a float.** `"120"` → `12000`.
- `validUntilMs` ← `authorization.valid_to`, parsed. The BPP's expiry wins over
  any locally computed one; that is what makes it an ONDC ticket rather than a
  local one wearing a costume.
- `legs` ← the `TRIP` fulfillment's `START` and `END` stops.
- `qrPayload` ← the `authorization.token`.
- The existing local issuer stays exactly as it is and remains the path when
  `ONDC_ENABLED` is false. Two producers, one `Ticket` type, one renderer.

### 8.3 It stays a specimen

Non-negotiable, and the reviewer will look for it:

- **The SPECIMEN mark stays on every render.** Coming from an ONDC-shaped
  `on_confirm` does not make a ticket valid; it makes it a well-formed invalid
  ticket. If anything, the mark matters *more* now, because the artefact is more
  convincing.
- **The ticket surface must say where it came from** - something like "issued by
  a local mock ONDC network, not by BMRCL" - in the ticket UI itself, not only
  in a README a judge will not read.
- **`payments[].status: PAID` is a protocol field, not a claim.** No gateway is
  called. The consuming app must never render "Paid" from it without the
  specimen framing.
- **`authorization.status: UNCLAIMED` must not be presented as "ready to
  scan".** It is ready to scan at a gate that does not exist.
- Existing tests that assert the SPECIMEN mark appears must be extended to cover
  the ONDC-sourced ticket, not merely left passing on the local one.

---

---

## 9. Fidelity, stated honestly

The submission will be judged partly on transparent disclosure, so this table is
an asset. It is also the table to put on screen in the demo.

**Faithful to the real protocol:**

| Aspect | What is real | Evidence |
|---|---|---|
| Domain and version | `ONDC:TRV11` version `2.0.1`, the published specification for metro and intracity bus ticketing | §3.4 |
| Payload shapes | `context`, `catalog`, `Provider`, `Item`, `Fulfillment`, `Quote`, `Order`, `Payment`, `authorization` - all copied from ONDC's own examples, none invented | §3.5, §3.6 |
| Transaction lifecycle | `search → on_search → select → on_select → init → on_init → confirm → on_confirm → status → on_status` | §3.1 |
| Async callback model | Every call is answered with `ACK`, and the real answer arrives as a separate inbound POST | §3.2 |
| ACK / NACK envelope and error codes | As documented by ONDC's own mock server | §3.2 |
| Gateway broadcast | A real gateway process performs a real registry lookup and fans one `search` out to two independent BPPs | §5.1 |
| Registry | A real registry process holds subscriber IDs, URIs, domains and public keys, and is queried at runtime | §5.1 |
| Ed25519 signing and verification | Performed by the ONIX adapter as pipeline steps `validateSign → addRoute → validateSchema → signAck`, against keys held in the registry. Signatures are genuinely computed and genuinely verified. | §3.7 |
| Schema validation | Real JSON Schema validation on both sides; a malformed payload is `NACK`ed exactly as the network would | §3.2 |
| TTLs | `PT30S` in payloads; `PT15S` for `search` and `PT10S` for other actions in the BAP protocol server's config, and enforced | §3.3 |
| Two independent providers | Two subscriber IDs, two protocol-server pairs, two registry entries. Not one BPP pretending to be two. | §5.2 |
| Fares and routes | Real BMTC and Namma Metro routes, stops, Kannada names, line colours and published fare rules | §7.3 |

**Stubbed, simulated, or absent:**

| Aspect | What is not real | Consequence |
|---|---|---|
| Network participant identities | Subscriber IDs are `*.transit.localhost`, an RFC 6761 reserved name that cannot resolve publicly. Not ONDC-issued. | Nothing here can transact with, or be mistaken for, the real network. |
| Registry trust chain | The local registry self-signs its participants. There is no ONDC-issued subscriber certificate, no whitelisting, no NP onboarding. | Signature verification proves the message was not tampered with in transit; it proves nothing about who the sender is in the real world. |
| BMTC as a network participant | BMTC does not sell tickets over ONDC. The BMTC BPP here is a demonstration of what it would look like if it did. | This is the point of the project, not a flaw, but it must never be stated as "BMTC on ONDC". |
| BMRCL as a network participant | BMRCL *is* live on ONDC, but this stack does not talk to it. The BMRCL BPP here is a local stand-in. | "Namma Metro is on ONDC" is true. "This is talking to Namma Metro" is not. |
| Payment | No gateway, no UPI, no collection, no settlement. `status: PAID` is written because the field is required. | No money moves. Ever. |
| Settlement terms | `BUYER_FINDER_FEES`, `SETTLEMENT_WINDOW`, `SETTLEMENT_BASIS`, `COURT_JURISDICTION` are carried with plausible values so the payloads validate. They bind nobody. | Structurally present, commercially meaningless. |
| The ticket | A specimen. Not accepted at any gate, by any operator, ever. | §8.3 |
| The QR token | Generated locally, encoding a specimen disclaimer. Not an operator ticket format. | §8.1 |
| Real-time data | `SCHEDULED_INFO`/`GTFS` tags point at nothing live. No vehicle positions, no live occupancy. | Journey times are computed estimates. |
| Cancellation, refunds, updates | Not implemented. `cancellation_terms` is present in payloads and honoured by nothing. | §2.2 |
| Catalogue scale | Two providers, a handful of offers. The real network paginates thousands. | §2.2 |
| Seat/quantity inventory | No inventory model. Every `select` succeeds. | No out-of-stock path. |
| ONIX images on Apple Silicon | `linux/amd64` under emulation | Slow starts. An operational fact, not a protocol one. |

**The one-sentence version, for a slide:** *the protocol, the signing, the
registry, the gateway fan-out and the payloads are real; the network
participants, the payment and the ticket are not, and the ticket says so on its
face.*

---

## 10. File and directory layout

### 10.1 This repository

```
.
├── README.md                       # what this is, why a mock, how to run it
├── LICENSE                         # MIT
├── SPEC.md                         # this document
├── docker-compose.yml              # the whole network, including our backend
├── docker-compose.override.yml.example
├── .env.example                    # every variable, documented, with defaults
├── Makefile                        # up / down / logs / demo / test / seed
├── package.json
├── tsconfig.json
├── vitest.config.ts
│
├── network/                        # everything that configures beckn-onix
│   ├── README.md                   # what we changed from upstream and why
│   ├── registry/
│   │   └── subscribers.seed.json   # BAP + 2 BPPs + gateway, with public keys
│   ├── keys/
│   │   └── .gitkeep                # generated Ed25519 keypairs, git-ignored
│   ├── bap-client.yaml             # synchronous mode, mongo URL
│   ├── bap-network.yaml
│   ├── bmtc-bpp-client.yaml        # webhook -> transit-bpp:7001/bmtc
│   ├── bmtc-bpp-network.yaml
│   ├── bmrcl-bpp-client.yaml       # webhook -> transit-bpp:7001/bmrcl
│   ├── bmrcl-bpp-network.yaml
│   └── gateway/
│       └── networks.json           # the local network definition
│
├── schemas/
│   ├── ondc_trv11/2.0.1/           # generated from the TRV11 build.yaml
│   │   ├── search.json  on_search.json
│   │   ├── select.json  on_select.json
│   │   ├── init.json    on_init.json
│   │   ├── confirm.json on_confirm.json
│   │   └── status.json  on_status.json
│   └── journey-source-response.json
│
├── src/
│   ├── index.ts                    # HTTP server, one route per action
│   ├── config.ts                   # env parsing, fail-fast on missing vars
│   ├── protocol/
│   │   ├── context.ts              # build and echo a TRV11 context
│   │   ├── ack.ts                  # ACK / NACK envelopes
│   │   ├── validate.ts             # JSON Schema validation, both directions
│   │   ├── dispatch.ts             # POST an on_* back to the bpp-client
│   │   └── errors.ts               # ONDC error codes
│   ├── trv11/                      # TransitOffer -> TRV11, the only mapping layer
│   │   ├── catalog.ts              # -> on_search
│   │   ├── quote.ts                # -> on_select
│   │   ├── draft.ts                # -> on_init
│   │   ├── ticket.ts               # -> on_confirm, incl. authorization/QR
│   │   ├── status.ts               # -> on_status
│   │   └── ids.ts                  # P1/I1/F1 id allocation, deterministic
│   ├── sources/
│   │   ├── types.ts                # JourneySource, TransitOffer, ...
│   │   ├── fixture.ts              # FixtureJourneySource (default)
│   │   ├── http.ts                 # HttpJourneySource
│   │   └── index.ts                # selection by JOURNEY_SOURCE
│   ├── orders/
│   │   └── store.ts                # in-memory order store, keyed by order_id
│   ├── qr.ts                       # specimen QR generation
│   └── log.ts                      # structured logs keyed by transaction_id
│
├── fixtures/
│   ├── bmtc/
│   │   ├── stops.json
│   │   └── offers.json
│   └── bmrcl/
│       ├── stations.json
│       └── offers.json
│
├── tests/
│   ├── protocol/{context,ack,validate}.test.ts
│   ├── trv11/{catalog,quote,draft,ticket,status}.test.ts
│   ├── sources/{fixture,http}.test.ts
│   ├── contract/trv11-examples.test.ts   # against ONDC's own example files
│   └── e2e/happy-path.test.ts            # requires the stack up
│
├── docs/
│   ├── journey-source-http.md      # the contract any planner can satisfy
│   ├── fidelity.md                 # section 9, standalone and linkable
│   └── demo.md                     # the 90-second script
│
└── scripts/
    ├── generate-keys.sh
    ├── seed-registry.sh
    ├── fetch-trv11-schemas.sh      # pull + convert TRV11 build.yaml -> JSON Schema
    └── demo.sh                     # fires the whole flow, prints each hop
```

**`beckn-onix` is not vendored.** `scripts/` clones it to a git-ignored
directory at a pinned tag, or the Compose file references the published
`fidedocker/*` images directly. Copying someone else's MIT-licensed installer
into this tree creates a maintenance obligation for no benefit. What lives here
is *our configuration of it*, in `network/`, with `network/README.md` recording
exactly what differs from upstream defaults.

### 10.2 The consuming application

**Work in the consuming transit app, not here.** Given a Next.js App Router
project with existing routes under `app/api/` and libraries under `src/`, and a
test tree mirroring `src/`:

```
src/ondc/
  types.ts  context.ts  client.ts  order.ts  journey.ts  config.ts
src/tickets/
  fromOndc.ts                       # ticketFromOndcOrder (new, alongside issue.ts)
app/api/ondc/
  quote/route.ts
  book/route.ts
  status/[transactionId]/route.ts
  health/route.ts
tests/ondc/
  context.test.ts  client.test.ts  order.test.ts  journey.test.ts
tests/tickets/
  fromOndc.test.ts
```

Nothing in the existing planner, fares, ingest or lookup code changes. The one
addition on that side beyond `src/ondc/` is the optional
`POST /api/ondc/offers` route of §7.3, which serves the `HttpJourneySource`
contract.

---

---

## 11. Acceptance criteria, and the tests

### 11.1 What a passing run looks like

Bring the stack up and run `make demo`. It must produce, in order, with one line
per hop and a single `transaction_id` threaded through all of them:

```
[T:9f2c…] → search           bap-client:5001            ACK
[T:9f2c…]   gateway          lookup → 2 subscribers     bmtc.bpp.transit.localhost,
                                                        bmrcl.bpp.transit.localhost
[T:9f2c…]   gateway → bmtc   search                     ACK
[T:9f2c…]   gateway → bmrcl  search                     ACK
[T:9f2c…] ← on_search        bmtc     1 provider, 1 item, ₹27.00
[T:9f2c…] ← on_search        bmrcl    1 provider, 1 item, ₹20.00
[T:9f2c…] → select   bmtc                               ACK
[T:9f2c…] ← on_select        quote ₹27.00  BASE_FARE
[T:9f2c…] → init     bmtc                               ACK
[T:9f2c…] ← on_init          draft order, settlement terms present
[T:9f2c…] → confirm  bmtc                               ACK
[T:9f2c…] ← on_confirm       order 4a7b1e02  status ACTIVE
                             fulfillment F2 type TICKET, authorization QR,
                             status UNCLAIMED, valid_to 2026-08-27T23:59:59Z
[T:9f2c…] → status   bmtc                               ACK
[T:9f2c…] ← on_status        order 4a7b1e02  status ACTIVE
[T:c31d…]   … the same nine hops again for bmrcl …

PASS  2 orders, 2 tickets, ₹47.00 total, 0 NACKs
```

**Nine observable calls per operator, eighteen for the journey, and the gateway
appears exactly twice - once per BPP - and only during `search`.** If the
gateway appears during `select`, the routing is wrong. If it never appears, the
BAP is talking to a BPP directly and the demonstration is void.

### 11.2 The criteria

Numbered so they can be ticked off.

**Network**

1. `docker compose up` brings the stack to healthy with no manual step beyond
   `make seed` on first run.
2. The registry returns all four subscribers on `GET /subscribers`.
3. `GET /healthz` on the provider backend returns 200.

**Protocol**

4. A `search` from the BAP produces **two** distinct `on_search` callbacks, one
   per BPP, correlated by a single `transaction_id`.
5. Both `on_search` bodies validate against the TRV11 `on_search` schema.
6. Every `on_*` body validates against its TRV11 schema. Zero exceptions.
7. A deliberately malformed `search` (drop `context.domain`) returns `NACK` with
   `error.type: JSON-SCHEMA-ERROR`, and no `on_search` follows.
8. A `select` carrying an unknown `item.id` returns an error, not a quote.
9. `transaction_id` is byte-identical across all nine hops of one order.
10. `message_id` differs between `select` and `init` within one order, and
    matches between a request and its own callback.
11. `on_confirm` carries `order.id`, `order.status: ACTIVE`, a `TICKET`-type
    fulfillment with `stops[0].authorization.type: QR`, a non-empty `token`, a
    parseable `valid_to`, and a `TICKET_INFO` tag with a `NUMBER`.
12. `on_status` for that `order.id` returns the same order.
13. The gateway log shows a registry lookup and a fan-out to two subscriber URIs
    during `search`, and no gateway involvement in any later action.
14. Every request between participants carries an `Authorization` header, and
    tampering with a body in flight causes the receiver to reject it.

**Pricing**

15. `quote.price.value` on `on_select` equals the sum of
    `breakup[].price.value`.
16. The quoted fare matches the source's fare exactly. With the fixture source,
    the fixture's `farePaise`; with the HTTP source, the planner's `farePaise`.
    **Assert integer paise in and rupee string out with no rounding drift** -
    `2700` paise must render as `"27"`, never `"27.000000000000004"`.
17. The two orders' totals sum to the journey total shown by the consuming app.

**Ticket** (in the consuming application)

18. `ticketFromOndcOrder` produces a `Ticket` whose `validUntilMs` equals the
    parsed `authorization.valid_to`.
19. The rendered ticket carries the SPECIMEN mark and a "not issued by BMRCL or
    BMTC" line.
20. With `ONDC_ENABLED=false` the app behaves exactly as it does today, and the
    entire existing test suite passes unchanged.

### 11.3 The tests

This project tests heavily, and so must this one. Four layers.

**A. Unit tests on the mapping layer** - `tests/trv11/`. Pure functions, no
network, no containers. Given a `TransitOffer[]`, assert the produced `catalog`
has one provider with the right `descriptor.name`, one item per offer with
`price.value` as the correct rupee string, one `TRIP` fulfillment whose `stops`
are `START`, `INTERMEDIATE_STOP`…, `END` in travel order with `parent_stop_id`
chained correctly, and `vehicle.category` matching the operator. The highest
value per minute of any test here, because this is where a spec is most easily
misread.

**B. Contract tests against ONDC's own examples** -
`tests/contract/trv11-examples.test.ts`. **This is the test that stops the build
drifting into something that merely looks like Beckn.**

- Vendor ONDC's example YAML files from `release-TRV11-2.0.1` into
  `tests/fixtures/trv11-examples/` at a pinned commit, with the source URL and
  commit SHA recorded in a sibling `SOURCE.md`.
- Assert every generated `on_*` body has **the same key structure** as the
  corresponding official example: same required keys at every level, same enum
  values for `type`, `category`, `status`, `title`. Values differ - our fares
  and stops are Bengaluru's - but shape must not.
- Assert ONDC's own examples pass our schema validator. If they do not, the
  schemas were generated wrong, and that is worth knowing on day one rather than
  during the demo.

**C. Schema-validation tests** - `tests/protocol/validate.test.ts`. Every
generated payload validates. A payload with a required field removed does not.
The `NACK` body matches the documented envelope, including
`error.type: JSON-SCHEMA-ERROR`.

**D. One end-to-end test** - `tests/e2e/happy-path.test.ts`, tagged so it is
skipped unless `E2E=1` and the stack is up. Drives the full eighteen hops and
asserts criteria 4, 9, 11, 12 and 17. **One** such test, not a suite: they are
slow, they need Docker, and everything else is better tested at layer A or B.

**In the consuming application:** unit tests for `context.ts` (transaction-id
continuity, message-id freshness), `client.ts` against a stubbed protocol server,
`ticketFromOndcOrder`, and an extension of the existing SPECIMEN-mark assertions
to the ONDC-sourced ticket. No container required for any of them.

### 11.4 What must be logged

Every hop, structured, with `transaction_id`, `message_id`, `action`,
`subscriber_id` and outcome. ONIX already threads `transaction_id` and
`message_id` through its logs as context keys.[^onix-bpp-adapter] The provider
backend must use the same key names so a single `grep` follows one order across
seven containers. This is what makes the demo legible and what makes debugging
possible at all.

---

## 12. The demo sequence

Ninety seconds. `docs/demo.md` holds the script; `scripts/demo.sh` drives it so
that nothing depends on typing accurately on the day.

| Time | Screen | Said |
|---|---|---|
| 0:00-0:12 | The app: a journey from Indiranagar to Majestic. Bus leg, metro leg, fare per leg. | "One journey, two operators. A BMTC bus and a Namma Metro ride." |
| 0:12-0:25 | Cut to a headline: BMRCL QR ticketing live on ONDC, July 2025. Then a list of intracity bus operators on ONDC - DTC, CRUT, BEST - with Bengaluru absent. | "Namma Metro already sells tickets over ONDC. BMTC does not. Bengaluru's buses are not on the network its metro is already on." |
| 0:25-0:35 | `docker compose ps`: registry, gateway, two BPP pairs, the provider backend. | "So we stood the network up locally. A real registry, a real gateway, and two operator platforms - one for the metro, one for the bus." |
| 0:35-0:55 | Split screen. Left: tap Book. Right: the log, scrolling. The **gateway fan-out line highlighted**. | "One search goes to the gateway. The gateway looks both operators up in the registry and asks them both. Two catalogues come back, independently." |
| 0:55-1:12 | The log continues: `select`, `init`, `confirm` per operator. `on_confirm` expanded to show `authorization.type: QR`, `status: UNCLAIMED`. | "Select, initialise, confirm - the Beckn lifecycle, signed and schema-validated at every hop. The metro operator returns a QR ticket in the field the specification says a QR ticket goes in." |
| 1:12-1:25 | The ticket in the app. **SPECIMEN mark clearly legible.** Hold on it. | "And it is a specimen. Not valid for travel, no money moved, and it says so on its face." |
| 1:25-1:30 | The fidelity table, the real column and the stubbed column side by side. | "The protocol is real. The participants are not. Here is exactly which is which." |

Three rules for the recording:

1. **The gateway fan-out is the money shot.** It is the one frame that proves
   this is a network and not two HTTP calls. Highlight it, slow it, hold it.
2. **Do not say "BMTC on ONDC".** Say "what BMTC joining ONDC would look like".
   Every time. The claim is the argument; overstating it destroys it.
3. **Do not cut away from the SPECIMEN mark quickly.** Hold it long enough to
   read.

---

## 13. Effort, risk, and what to cut

### 13.1 The estimate

Engineering days, one person, at the pace this project has been moving.

| Stage | Work | Days |
|---|---|---|
| **0. Spike** | Bring `beckn-onix` up via option 4. Fire one `search`. **Settle the synchronous-mode question of §5.4.** Confirm the amd64 images run acceptably. | **0.5** |
| **1. Schemas** | Generate TRV11 2.0.1 JSON Schemas from the specification's `build.yaml`; verify ONDC's own examples validate. | **0.5** |
| **2. Provider backend, happy path** | The five actions, the mapping layer, the fixture source, the order store, the QR. Layer A and C tests alongside. | **1.0** |
| **3. Network configuration** | Two BPP pairs, registry seeding, key generation, one Compose file, `Makefile`. | **0.5** |
| **4. BAP client** *(consuming app)* | `src/ondc/`, four routes, unit tests. | **0.5** |
| **5. Ticket** *(consuming app)* | `ticketFromOndcOrder`, extend the SPECIMEN assertions. | **0.25** |
| **6. Contract tests + E2E** | Layer B against ONDC's examples; one end-to-end test. | **0.5** |
| **7. Repo furniture** | README, LICENCE, `docs/`, `demo.sh`, fidelity page. | **0.25** |
| | **Total** | **4.0** |

**With a following wind, 2.5 days**, if stage 0 confirms synchronous mode
aggregates both BPPs and the amd64 images behave. **Comfortably 4** otherwise.

**This is down from 7-9 days** for the from-scratch build this document
originally set out to specify. Three things account for the drop, in order of
size:

1. **Synchronous BAP mode deletes the async callback layer** in the consuming
   app - five endpoints, a correlation store, a timeout policy, a reachability
   problem, and the tests for all of it. Roughly 1.5 days.
2. **`beckn-onix` supplies the registry, gateway and both protocol servers.**
   Writing a credible gateway with registry lookup and Ed25519 signing is 2-3
   days on its own, and it would be a worse gateway.
3. **TRV11's examples remove all payload design work.** Every shape is copied,
   which is faster *and* correct, where inventing them would be slower and
   wrong.

**The smallest shippable increment, named:** *stages 0, 1, 2 and 3, with one BPP
(BMRCL), the fixture source, and `curl` as the BAP.* That is **two days** and it
already demonstrates a real gateway, a real registry, real signing, the full
five-action lifecycle and a TRV11 QR ticket. It has no app integration and no
second operator, so it loses the fan-out - which is the best part - but it is a
genuine ONDC transaction and it is defensible on its own.

### 13.2 Is it achievable before 27 August?

**Yes, and here is the honest caveat.**

Eight calendar days remain. Four engineering days of work fits, with slack - but
only if this is not the only outstanding deliverable, which the brief says it is
not. The realistic read:

- **Stages 0-3 (the network and the provider backend, 2.5 days): high
  confidence.** The dependencies are installed and configured, not written.
- **Stages 4-5 (the app integration, 0.75 days): high confidence *if* stage 0
  resolves synchronous mode favourably. Medium if not** - add a day, and it
  becomes the piece most likely to slip.
- **Stages 6-7: cuttable to half.**

**The single decision that governs the schedule is stage 0, and it must happen
first.** Half a day, on day one. If synchronous mode does not aggregate two
BPPs' callbacks, the honest response is to cut to one operator rather than to
build the async layer under deadline pressure.

**Where this could genuinely go wrong**, ranked:

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Synchronous mode returns only the first `on_search` | Medium | High | Cut to one BPP, or one `search` per BPP with `bpp_id` pinned. Decide on day one. |
| amd64 emulation makes the stack too slow to demo | Medium | High | Pre-record the terminal half of the demo. Not a compromise: it is a video. |
| TRV11 schema generation from `build.yaml` is fiddly | Medium | Medium | Fall back to hand-written JSON Schemas covering only the five actions in scope. Half a day. |
| Registry seeding or key registration fights back | Medium | Medium | The installer script does it; drive the script rather than reimplementing it. |
| ONIX images change under us | Low | High | **Pin every image by digest, not by tag, on day one.** |
| Two BPP pairs exceed available memory | Low | Medium | Cut to one BPP. Do not fake the fan-out. |

**The thing that would make this not worth doing** is if it consumes days that
the rest of the submission needs. It is an addition, not a foundation. If by
**24 August** stages 0-3 are not done, ship the smallest increment, record the
demo against it, and say plainly in the write-up that app integration is next.
An honest partial is worth more than a rushed whole, and it is consistent with
everything else this project says about itself.

### 13.3 The cut list, in the order to cut

1. The second BPP. Costs the fan-out - the best part - so cut it last among the
   demo-visible items.
2. The `HttpJourneySource`. Demo runs on fixtures. Costs realism, not protocol.
3. The end-to-end test. Layers A, B and C already cover the logic.
4. `status` / `on_status`. `on_confirm` already returns the ticket.
5. The app-side ticket integration. Show the `on_confirm` JSON instead.
6. The consuming app's BAP client entirely. `curl` is a perfectly good BAP and
   the protocol is what is being demonstrated.

Never cut: schema validation, the signing pipeline, the SPECIMEN mark, or the
fidelity table.

---

## 14. This repository: shape, name and licences

### 14.1 Does it still deserve to exist?

**Yes - but it is a provider platform, not a mock network, and the difference is
the whole reason it is worth publishing.**

The network comes from `beckn-onix`. If this repository were only a Compose file
plus a stub, the honest answer would be "fold it into the consuming app and move
on". It is not. What it holds is a **TRV11 provider platform for Bengaluru
public transport**: the mapping from journeys and fares onto ONDC's metro and
intracity-bus specification, with fixtures, schemas and tests. That is a real,
reusable artefact. It is roughly the thing BMTC would have to build.

It is also **useful to someone who has never heard of the consuming app**: a
runnable Bengaluru TRV11 BPP, a worked example of the specification, and a
documented `JourneySource` contract any planner can implement. There are very
few public TRV11 provider implementations. That is a genuine contribution.

What it should **not** contain: a hand-rolled gateway, a hand-rolled registry, a
copy of `beckn-onix`, or anything that only makes sense in the presence of one
particular transit app.

### 14.2 The name

**Settled: `ondc-transit-bpp`.** The repository was initialised as
`mock-ondc-server` and renamed before any of it was published.

The old name described something this is not. Nothing here is a mock: the
registry, gateway and protocol servers are Beckn's own reference
implementations run locally, and what this repository adds is a real TRV11 BPP.
The only thing standing in for the world is the transit data behind it, and
section 12 states exactly which parts those are.

Names considered and passed over: `trv11-transit-bpp` (most precise, least
legible to anyone who does not already know the domain codes),
`bengaluru-transit-bpp` (names the city, hides the protocol), `namma-ondc-bpp`
(local flavour, less clear to a reader outside Karnataka).

### 14.3 Licences and what follows from them

| Project | Licence | Obligation on us |
|---|---|---|
| `beckn/beckn-onix` | **MIT**, "Copyright (c) 2024 Beckn Protocol"[^onix-licence] | We run its published Docker images and write our own configuration. No source is copied, so no notice obligation arises. **If any ONIX file is ever vendored** - an installer script, a Compose file, a schema - the MIT notice must travel with it in a `THIRD_PARTY_NOTICES.md`. Note the README badge claims Apache 2.0 while the `LICENSE` file says MIT; the file governs, and the discrepancy is worth an upstream issue. |
| `ONDC-Official/mobility-specification` | See the repository; it is a published specification, and the examples this document quotes are quoted as specification, with attribution. | Cite the repository, branch and commit wherever an example is vendored into `tests/fixtures/trv11-examples/`. Record it in `SOURCE.md` alongside. |
| `beckn/beckn-sandbox` | **MIT**, "Copyright (c) 2022 Beckn"[^beckn-sandbox-licence] | Used as prior art only; nothing is copied. If any code ever is, carry the notice. |
| `ONDC-Official/ondc-mock-server` | **No `LICENSE` file**[^mockserver-nolicense] | Default is all rights reserved. **Copy nothing from it.** It is cited for documented behaviour, which is fine, and that is the extent of the relationship. |
| `beckn/starter-kit`, `beckn/BAP-sync-adapter` | **No `LICENSE` file**[^starterkit-nolicense] | Same. Do not vendor. If `BAP-sync-adapter` becomes necessary, run its published image or ask upstream to add a licence first. |

**This repository: MIT.** It is the licence of the ecosystem it sits in, it
imposes nothing on anyone who wants to run a BPP, and it is what a public-good
piece of infrastructure should carry.

The `README.md` must state, above the fold, that this is not affiliated with
BMTC, BMRCL or ONDC, and that nothing it issues is valid for travel.

---

## 15. Open questions

Collected from the sections above so they can be worked in one sitting. The
first is the only one that affects the schedule.

| # | Question | How to settle it | Blocks |
|---|---|---|---|
| 1 | Does the BAP protocol server's synchronous mode aggregate `on_search` from **two** BPPs, or return only the first within the `search` TTL? | Stage 0. Bring the stack up, register two BPPs, fire one `search`, read the response. Fifteen minutes. | §6.2, the whole estimate |
| 2 | The exact enumeration of `authorization.status`. `UNCLAIMED` is the only value in the metro examples. | Read `api/components/enum/index.yaml` on `release-TRV11-2.0.1`. | An assertion in §11.2 criterion 11 |
| 3 | The canonical required/optional field list for Beckn core 1.1.0 `Context`. The old developer docs now redirect to `docs.nfh.global`, which documents a different generation. | Read `schemas/core/v1.1.0/definitions.json#/$defs/Context` inside `beckn-onix`'s `schemas.zip`. | Nothing; TRV11's examples are sufficient to build from |
| 4 | Whether ONDC publishes generated JSON Schemas for TRV11, or whether they must be built from `api/build/build.yaml`. | Check `api/components/ondc-build-utility` and `api/build/build.yaml` on the release branch. | Stage 1 |
| 5 | Whether the gateway needs per-domain configuration to route `ONDC:TRV11`, or whether it fans out on subscriber domain alone. | `install/gateway_data/config/networks/onix.json-sample`. | Stage 3 |
| 6 | Whether `fidedocker/*` images publish digests to pin against, and which tags are current. | `docker manifest inspect`, day one. | The pinning risk in §13.2 |

Each of these is a lookup, not a research project. None of them is a reason to
delay starting.

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
