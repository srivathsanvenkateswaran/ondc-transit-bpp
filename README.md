# ondc-transit-bpp

An ONDC provider platform for Bengaluru public transport, and a local Beckn
network to exercise it against.

> **Not affiliated with BMTC, BMRCL or ONDC.** Nothing this software issues is
> valid for travel. No money moves through it. See [Honesty](#honesty).

**The specification is [`SPEC.md`](SPEC.md).** It is complete enough to build
from and cites a source for every protocol claim. This file is the short
version.

---

## What this is

ONDC is India's open network for digital commerce. On it, a buyer app (a **BAP**)
and a seller platform (a **BPP**) transact over the Beckn protocol without
either being locked to the other. Bengaluru's metro operator already sells
tickets this way; you can buy a Namma Metro QR ticket inside Uber, Navi UPI,
Namma Yatri and about thirty other apps, and every one of those purchases is a
Beckn transaction against BMRCL's BPP.

This repository holds two things:

1. **A TRV11 provider platform** - a service that answers ONDC's
   `ONDC:TRV11` calls (`search`, `select`, `init`, `confirm`, `status`) with
   Bengaluru bus and metro journeys, priced, routed, and returning a QR ticket
   in the field the specification says a QR ticket goes in. `ONDC:TRV11` is
   ONDC's published domain for unreserved metro and intracity-bus ticketing.

2. **The configuration to run a whole Beckn network locally** - a registry, a
   gateway and both protocol servers - so that the provider platform can be
   developed and demonstrated end to end without onboarding to the real network.

The network itself is not ours. It is [`beckn-onix`](https://github.com/beckn/beckn-onix),
FIDE's MIT-licensed reference implementation, which installs a registry,
gateway, BAP adapter and BPP adapter over Docker Compose. What lives here is our
configuration of it and the provider platform that plugs into it.

## Why a local network rather than the real one

Joining the real ONDC network requires a legal entity, a registered domain, a
subscriber key registered with ONDC's registry, and participant onboarding. None
of that is available to someone developing a transit app on a laptop, and none
of it should be short-circuited.

The precedent is ordinary: you run a local object-storage container instead of
reaching for a cloud bucket during development. Real protocol, real client,
stand-in server. Here the protocol, the signing, the registry lookup, the
gateway fan-out and the payload shapes are all real. The network participants
are local test identities under a reserved `.localhost` name that cannot resolve
on the public internet.

## Why bus as well as metro

Namma Metro is live on ONDC. **BMTC is not.** ONDC's intracity bus ticketing
runs for Delhi Transport Corporation, Odisha's CRUT, and Mumbai's BEST -
Bengaluru's bus operator is absent.

So this repository ships two provider identities: a metro one that mirrors an
operator already on the network, and a bus one that demonstrates what BMTC
joining it would look like. A rider in Bengaluru can already buy the metro half
of a multimodal journey from a third-party app over an open network. They cannot
buy the bus half. That gap is the reason this exists.

## Who it is for

- **Anyone building a BAP** who wants something real to transact against. The
  provider platform is a working TRV11 BPP; point your buyer app at the local
  network and run the full lifecycle.
- **Anyone implementing TRV11** who wants a worked example alongside ONDC's
  specification.
- **Anyone with a journey planner.** The provider platform gets its journeys
  through a small documented `JourneySource` interface. Fixtures are the
  current default, so it runs standalone. A real source can be added later
  behind the same interface. Nothing here depends on any particular transit
  app.

## Honesty

This governs everything in the repository.

- **No ticket issued here is valid for travel.** Every rendered ticket must
  carry a visible SPECIMEN mark.
- **No money moves.** `payment.status` is set to `PAID` because the protocol
  requires a value in that field. Nothing is charged, no payment gateway is
  contacted, no settlement happens.
- **No real network participant is contacted or impersonated.** Subscriber IDs
  are local `.localhost` names. Nothing here is registered with ONDC's staging
  or production registry.
- **The transit fixture is plausible; the transaction is not.** The fixture
  uses real Bengaluru place and station names with illustrative routes and
  placeholder whole-route fares. No output is live operator data.
- **Fixture fares are not distance-based.** `wholeRouteFarePaise` is a
  placeholder for one complete fixture journey. Slicing that route for a
  shorter search does not reprice it, so sliced fixture offers must not be
  demonstrated as accurately priced journeys. Distance-correct fares come
  from the optional HTTP journey source, which consumes integer paise from a
  planner.
- **BMTC is not on ONDC**, and no output of this software should be presented as
  showing that it is. The claim is "here is what it would look like", and that
  claim is worth making honestly.

`SPEC.md` section 9 is a full table of what is faithful to the real protocol and
what is stubbed, field by field. It is meant to be read by anyone assessing
this, and it is published rather than buried.

## Status

Phase 1 discovery is complete. A single fixture-backed service answers
`search` for BMTC and BMRCL, validates every incoming `search` and generated
`on_search`, and returns the callback through each BPP protocol server. One
synchronous BAP request aggregates both catalogues without an application-side
callback endpoint. See [`phase-1/RESULTS.md`](phase-1/RESULTS.md) for the raw
evidence.

Phase 2, including `select`, `init`, `confirm`, `status`, and QR ticket
issuance, has not started. This is the required stop point after Phase 1.

## Run Phase 1

The registry and gateway from beckn-onix option 4 must already be on the
external `beckn_network` Docker network. Stage 0 records the exact installation
and registration topology in
[`stage-0/onix-sync/RESULTS.md`](stage-0/onix-sync/RESULTS.md).

```console
cp .env.example .env
./stage-0/onix-sync/prepare-runtime.sh
docker compose up -d --build
curl http://127.0.0.1:7001/healthz
```

`prepare-runtime.sh` generates fresh protocol-server key pairs. If the local
registry already contains subscriber records, either keep the matching ignored
runtime files or update the registry records with the newly generated public
keys in `stage-0/onix-sync/runtime/public-keys.tsv`.

All six ONIX client and network configurations have authentication enabled.
The registry public keys must match the generated runtime keys or signed
requests will be rejected. Phase 1 includes a raw wire capture of the
`Authorization` header and a controlled one-byte body-tampering rejection in
[`phase-1/RESULTS.md`](phase-1/RESULTS.md#authentication-and-tamper-rejection).

Run the automated checks with:

```console
npm ci
npm test
npm run build
docker compose config --quiet
```

The reproducible request through the synchronous BAP client is
[`phase-1/evidence/search-request.json`](phase-1/evidence/search-request.json).
The command is:

```console
curl -sS -H 'Content-Type: application/json' \
  --data-binary @phase-1/evidence/search-request.json \
  http://127.0.0.1:5001/search
```

## Configuration

Docker Compose reads `.env` and supplies local defaults when it is absent.
Copy [`.env.example`](.env.example) to change any deployment value. The
provider application itself does not embed subscriber IDs, callback addresses,
public URLs, or ports.

| Variable | Local default | Purpose |
| --- | --- | --- |
| `PROVIDER_HOST` | `0.0.0.0` | Provider HTTP bind address |
| `PROVIDER_PORT` | `7001` | Provider container and host port |
| `PROVIDER_PUBLIC_BASE_URL` | `http://transit-bpp:7001` | Public base used in protocol URLs such as static terms |
| `JOURNEY_SOURCE` | `fixture` | Journey source selector; Phase 1 accepts only `fixture` |
| `FIXTURE_ROOT` | `/app/fixtures` | Fixture data directory |
| `TRV11_SCHEMA_ROOT` | `/app/schemas/ondc_trv11/2.0.1` | Input and output schema directory |
| `CALLBACK_TIMEOUT_MS` | `3000` | Provider-to-BPP-client HTTP timeout |
| `CONTEXT_TTL` | `PT30S` | TTL put on generated provider callbacks before ONIX normalization |
| `BAP_ID` | `bap.transit.localhost` | Local BAP subscriber ID |
| `BAP_URI` | `http://bap-network:5002` | BAP network subscriber URI |
| `BAP_CLIENT_PORT` | `5001` | Synchronous BAP client port |
| `BAP_NETWORK_PORT` | `5002` | BAP network port |
| `BMTC_BPP_ID` | `bmtc.bpp.transit.localhost` | BMTC BPP subscriber ID |
| `BMTC_BPP_URI` | `http://bmtc-bpp-network:6002` | BMTC BPP network subscriber URI |
| `BMTC_BPP_CLIENT_PORT` | `6001` | BMTC BPP client port |
| `BMTC_BPP_NETWORK_PORT` | `6002` | BMTC BPP network port |
| `BMTC_CALLBACK_URL` | `http://bmtc-bpp-client:6001/on_search` | Provider callback destination |
| `BMTC_WEBHOOK_URL` | `http://transit-bpp:7001/bmtc/search` | BPP client webhook seam into the provider |
| `BMTC_CALLBACK_DELAY_MS` | `0` | Test-only artificial callback delay |
| `BMRCL_BPP_ID` | `bmrcl.bpp.transit.localhost` | BMRCL BPP subscriber ID |
| `BMRCL_BPP_URI` | `http://bmrcl-bpp-network:6102` | BMRCL BPP network subscriber URI |
| `BMRCL_BPP_CLIENT_PORT` | `6101` | BMRCL BPP client port |
| `BMRCL_BPP_NETWORK_PORT` | `6102` | BMRCL BPP network port |
| `BMRCL_CALLBACK_URL` | `http://bmrcl-bpp-client:6101/on_search` | Provider callback destination |
| `BMRCL_WEBHOOK_URL` | `http://transit-bpp:7001/bmrcl/search` | BPP client webhook seam into the provider |
| `BMRCL_CALLBACK_DELAY_MS` | `0` | Test-only artificial callback delay |
| `SEARCH_TTL` | `PT4S` | ONIX synchronous discovery collection window |

The published ONIX image does not bundle a file named for Beckn core `2.0.1`.
Compose exposes its bundled core `1.1.0` schema under that filename so the
protocol server can transport `version: 2.0.1`; the provider performs the
TRV11-specific 2.0.1 validation at its own boundary.

## Licence

MIT. See [`LICENSE`](LICENSE).

Built on [`beckn-onix`](https://github.com/beckn/beckn-onix) (MIT) and against
[ONDC's mobility specification](https://github.com/ONDC-Official/mobility-specification),
branch `release-TRV11-2.0.1`.
