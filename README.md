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
  default, so it runs standalone; an HTTP source lets any planner that can
  satisfy one JSON contract supply real routes and fares. Nothing here depends
  on any particular transit app.

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
- **The transit data is real; the transaction is not.** Routes, stops, fare
  rules and journey times come from published open data. The order, the payment
  and the ticket are fabricated locally.
- **BMTC is not on ONDC**, and no output of this software should be presented as
  showing that it is. The claim is "here is what it would look like", and that
  claim is worth making honestly.

`SPEC.md` section 9 is a full table of what is faithful to the real protocol and
what is stubbed, field by field. It is meant to be read by anyone assessing
this, and it is published rather than buried.

## Status

Specification complete, implementation not started. See [`SPEC.md`](SPEC.md).

## Licence

MIT. See [`LICENSE`](LICENSE).

Built on [`beckn-onix`](https://github.com/beckn/beckn-onix) (MIT) and against
[ONDC's mobility specification](https://github.com/ONDC-Official/mobility-specification),
branch `release-TRV11-2.0.1`.
