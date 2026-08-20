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
  default, so it runs standalone. The optional HTTP adapter accepts real
  planner routes and integer-paise fares behind the same interface. Nothing
  here depends on any particular transit app.

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

Phase 1 discovery and the provider-side Phase 2 lifecycle are complete. A
single service answers `search`, `select`, `init`, `confirm` and `status` for
BMTC and BMRCL through two independent signed BPP identities. Confirmed orders
contain clearly marked specimen QR tickets, and status returns the stored order
unchanged. See [`phase-1/RESULTS.md`](phase-1/RESULTS.md) for discovery evidence
and [`phase-2/RESULTS.md`](phase-2/RESULTS.md) for the lifecycle evidence and
the audit of acceptance criteria 1 through 17.

The optional HTTP journey source is documented in
[`docs/journey-source-http.md`](docs/journey-source-http.md). The consuming BAP
client and ticket mapping in Tatak remain outside this repository.

## Run locally

The registry and gateway from beckn-onix option 4 must already be on the
external `beckn_network` Docker network. Stage 0 records the exact installation
and registration topology in
[`stage-0/onix-sync/RESULTS.md`](stage-0/onix-sync/RESULTS.md).

To bring all of that up from nothing, including the registry, the gateway, the
Docker network and the registry seeding, see
[Deploying to a server](#deploying-to-a-server). Those scripts work on a
laptop too and remove the manual installer step.

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

Phase 2 request and response pairs are under [`phase-2/evidence/`](phase-2/evidence/).
Later actions must be sent directly to the selected response's `bpp_uri`; they
must not be sent to the gateway.

## Deploying to a server

[Run locally](#run-locally) above assumes the registry and gateway are already
on the machine. They got there through beckn-onix's installer menu, and
[`stage-0/onix-sync/RESULTS.md`](stage-0/onix-sync/RESULTS.md) records the step
honestly as `bash install/beckn-onix.sh` followed by "selection: 4". A server
has nobody sitting at a menu. The scripts under [`deploy/`](deploy/) do the
same work without one.

```console
./deploy/bring-up.sh     # network, registry, gateway, keys, seeding, whole stack
./deploy/verify.sh       # the proof: one search, two on_search callbacks
./deploy/teardown.sh     # stop everything and remove the volumes
```

`bring-up.sh` prompts before anything that changes system packages; pass
`--yes` to run it unattended. `teardown.sh` is destructive and always lists
what it will remove before asking. Every script says what it is about to do and
stops on the first thing that is wrong rather than continuing.

### What a human must supply before the first run

A host, and nothing else. There is no key to paste, no account to create and no
secret to configure:

- **A `.env` is not required.** `bring-up.sh` copies `.env.example` if `.env` is
  missing, and leaves an existing one alone. Only edit it if you want to move
  a port or point `JOURNEY_SOURCE` at a planner.
- **Signing keys are generated on the host.** `prepare-runtime.sh` makes a
  fresh Ed25519 pair per identity; the private keys never leave the ignored
  `stage-0/onix-sync/runtime/` directory and are never committed.
- **The registry admin credentials are beckn-onix's defaults**, `root`/`root`,
  which is what its own installer logs in with. They are local test
  credentials for a `.localhost` network that cannot resolve on the public
  internet. Set `REGISTRY_ADMIN_USER` and `REGISTRY_ADMIN_PASSWORD` before
  putting any of this anywhere reachable, and read the port table below first.

### One thing to fix before the first deploy

`package-lock.json` resolves every one of its 88 tarballs from
`artifactory.global.mgmt.moveworks.io`, a private registry. The provider image
is built by `npm ci` inside a container that has only public internet, so on
any host outside that network the build hangs for npm's five minute fetch
timeout and then fails with `npm error Exit handler never called!`, naming no
host at all.

Regenerate the lockfile once, on a machine that can reach the public registry:

```console
rm package-lock.json
npm install --registry=https://registry.npmjs.org
```

and commit the result. `bring-up.sh` checks for this before it starts anything
and names the offending host rather than letting the build discover it five
minutes in.

Until that is done, build the provider image yourself and run
`deploy/bring-up.sh --no-build`.

### Prerequisites

| Requirement | Note |
| --- | --- |
| **x86_64 Linux** | Ubuntu 22.04 or 24.04. See [why x86_64 only](#x86_64-only-and-why). |
| Docker Engine with the Compose v2 plugin | `docker compose version` must work, and the deploying user must be in the `docker` group. |
| `curl`, `tar`, `python3` | Ubuntu ships all three. |
| `yq` and `jq` | The **python** yq, [`kislyuk/yq`](https://github.com/kislyuk/yq), which is what `apt-get install yq` gives you. `prepare-runtime.sh` calls `yq -yi --arg`, which the Go yq of the same name does not understand. `bring-up.sh` checks the flavour and offers to install it. |
| Outbound access to Docker Hub | For the pinned images. |
| Outbound access to `codeload.github.com` | For the pinned beckn-onix revision, from which the registry and gateway configuration is rendered. Set `ONIX_SRC=/path/to/beckn-onix` to use a local checkout instead and skip the fetch. |
| About 4 GB free disk | Images alone are roughly 1.4 GB. |
| A `package-lock.json` that resolves from the public npm registry | See [the previous section](#one-thing-to-fix-before-the-first-deploy). |

### x86_64 only, and why

Every image in this topology is pinned `platform: linux/amd64`, following
beckn-onix upstream. On x86_64 that pinning is native and costs nothing. On
Apple Silicon or any other ARM host it means emulation, and the message queue
does not survive it:

- The installer's RabbitMQ 3.8 amd64 image **segfaulted** under emulation.
  `stage-0/onix-sync/docker-compose.yml` moved to the multi-arch
  `rabbitmq:3.13-management-alpine` for that reason.
- 3.13 later **died with an Erlang `{badmap,provided_by}`** on the same kind of
  host.

Without a working queue the BPP protocol servers never receive anything, the
search returns nothing, and the failure surfaces several layers away from its
cause. So the target is x86_64 Linux, where none of this happens.

`bring-up.sh` refuses to start on a non-x86_64 host. Pass `--allow-non-x86` if
you are developing on one and accept that the queue may die.

### Memory and images

Per-container resident memory from a real run:

| Container | Resident |
| --- | ---: |
| `protocol-server` x6 | 92 MB each |
| `mongo:4.4` | 109 MB |
| `redis` | 12 MB |
| **Six protocol servers, Mongo and Redis** | **about 1.5 GB** |
| `registry` (JVM) | about 540 MB |
| `gateway` (JVM) | about 550 MB |
| **Whole topology including registry and gateway** | **about 2.6 GB** |

The registry and gateway are Java services started with `-Xmx4g`. They are not
in the 1.5 GB figure, which covers the protocol servers and their backing
stores; count them separately when sizing a host.

Image sizes: protocol-server 446 MB, mongo 594 MB, rabbitmq 277 MB, redis
46 MB, registry 747 MB, gateway of a similar order.

**Every figure above was measured under ARM emulation, not on x86.** Emulation
adds overhead rather than removing it, so a native x86_64 host should be the
same or lower. They are not presented as x86 numbers.

`bring-up.sh` warns below 3 GB of host RAM. **4 GB is the practical floor** and
more is better once the provider image build is included.

### Ports

| Port | Service | Published by default |
| ---: | --- | --- |
| 3030 | Registry, admin and `POST /subscribers/lookup` | `127.0.0.1` only |
| 4030 | Gateway | `127.0.0.1` only |
| 5001 | BAP synchronous client, `POST /search` | all interfaces |
| 5002 | BAP network | all interfaces |
| 6001 / 6002 | BMTC BPP client / network | all interfaces |
| 6101 / 6102 | BMRCL BPP client / network | all interfaces |
| 7001 | Provider, `GET /healthz` | all interfaces |

Two notes on that table.

beckn-onix's own Compose files also publish **3000 and 4000**. Those are the
JVM's JDWP debug ports, wired up in each image's `bin/service-start` as
`-agentlib:jdwp=...address=${dport}`. An open JDWP port is remote code
execution. [`deploy/network.compose.yml`](deploy/network.compose.yml)
deliberately does not publish them; they remain reachable from inside
`beckn_network` if anyone needs to attach a debugger.

The registry and gateway are bound to `127.0.0.1`. Override with
`REGISTRY_BIND_ADDR` and `GATEWAY_BIND_ADDR` if you know why you want to. The
six ONIX ports and the provider port come from
`stage-0/onix-sync/docker-compose.yml` and are published on all interfaces;
put a firewall in front of the host rather than editing that file.

### Registry seeding, and why it is the step that eats an evening

All six ONIX client and network configurations run with `auth: true`. Every
request between participants is signed, and every receiver checks the signature
against the sender's public key **as held by the registry**. If the two differ
by a byte, every request is rejected and nothing works.

`prepare-runtime.sh` generates a fresh key pair per identity on each run. So on
a fresh host the registry starts empty, and on a rerun the registry holds keys
that no longer exist. Both cases produce the same symptom: 401s everywhere.
[`phase-2/RESULTS.md`](phase-2/RESULTS.md) records acceptance criterion 1 as
PARTIAL for exactly this reason, in the author's own words: there is no
`make seed`.

[`deploy/seed-registry.sh`](deploy/seed-registry.sh) is that missing step. It:

1. logs in to the registry admin API and takes an ApiKey;
2. creates the `ONDC:TRV11` network domain, without which the registry rejects
   every registration with `Invalid domain ONDC:TRV11`;
3. registers the BAP and both BPP subscribers with the public keys
   `prepare-runtime.sh` just generated, or rotates the stored key if the
   subscriber already exists, because the registry refuses to change a key
   through `register` once a record is there;
4. moves those three and the gateway's own self-registered record from
   `INITIATED` to `SUBSCRIBED`, because the registry creates every record
   `INITIATED` and a lookup only returns subscribed ones;
5. proves, through the same `POST /subscribers/lookup` the gateway itself uses,
   that all four are `SUBSCRIBED` and that every signing public key matches the
   generated runtime key exactly.

It is idempotent. Running it again is a no-op; running it after regenerating
keys rotates the registry's copy to match.

### What the bring-up deliberately does not start

beckn-onix's option 4 installs more than a registry and a gateway. It also
renders a BAP and a BPP protocol-server topology of its own, each with its own
Mongo, Redis and RabbitMQ, and offers to install the ONIX adapter with another
Redis and a Vault. `install/docker-compose-bpp-with-sandbox.yml` additionally
starts `fidedocker/sandbox-api` as a stub provider backend.

`deploy/bring-up.sh` starts **only the registry and the gateway** from
beckn-onix. Everything else in the topology is
`stage-0/onix-sync/docker-compose.yml`, which brings its own Mongo, Redis and
RabbitMQ and its own six protocol servers.

That removes two duplications without editing anything:

- **One set of backing services, not two.** Roughly 240 MB and three containers
  that would otherwise sit idle. No change was needed in
  `stage-0/onix-sync/docker-compose.yml`; the saving comes from not starting
  beckn-onix's set in the first place.
- **No `sandbox-api`.** It would be dead weight even if it ran:
  `stage-0/onix-sync/RESULTS.md` records that the published sandbox image does
  not recognise `ONDC:TRV11` at all and answers HTTP 404 `Domain not found`.
  The provider in this repository is the BPP's business logic.

One leftover is worth naming rather than changing. The two BPP **network**
configurations still carry `client.webhook.url: http://bmtc-sandbox:3000/...`
and `.../bmrcl-sandbox:3000/...`, hostnames that no longer exist. In network
mode the protocol server hands work to the queue and the **client** process is
the one that calls a webhook, so those two lines are inert. They are left
untouched.

### Two gateway settings that are not written down anywhere

beckn-onix ships `gateway_data/config/networks/onix.json-sample` with no
`domains` in it and `core_version` at `1.1.0`. Neither is usable for
`ONDC:TRV11` 2.0.1, and neither failure announces itself. `bring-up.sh` renders
both correctly; they are recorded here because the symptoms are misleading.

**No matching entry in `domains`.** `POST /bg/search` throws, before the
gateway looks anything up:

```text
java.lang.NullPointerException: Cannot invoke
  "in.succinct.onet.core.adaptor.NetworkAdaptor$Domain.getExtensionPackage()"
  because the return value of "...NetworkAdaptor$Domains.get(String)" is null
```

The BAP still receives HTTP 200 with an empty `responses` array, so from the
caller's side it looks like "no sellers answered".

**`core_version` left at `1.1.0`.** With `domains` present but the version
unchanged, the gateway does the registry lookup, finds both BPPs, logs the
outbound `curl` for each of them, and then never opens the connection. No error
is logged on either side. Setting `core_version` to the domain's version puts
the fan-out on the wire. That was established by pointing a BPP's registered
`subscriber_url` at a bare HTTP sink and watching the request arrive or not.

### Verifying

`bring-up.sh` finishing means the stack started. It does not mean the network
works. [`deploy/verify.sh`](deploy/verify.sh) is the script that proves the
thing a demonstration actually depends on:

> One `POST /search`, routed through the **gateway**, returns **two**
> `on_search` callbacks from **two distinct BPP subscriber IDs**, under one
> `transaction_id`.

Anything less than that is a failure and the script exits non-zero. It does not
invent a request: it reuses
[`phase-2/evidence/stack-smoke-search-request.json`](phase-2/evidence/stack-smoke-search-request.json),
the broad search already captured in Phase 2, with a fresh `transaction_id`,
`message_id` and `timestamp` so the run is genuinely new rather than served
from a cached response. It refuses to run at all if that request names a
`bpp_id`, since a request that names one bypasses the gateway and proves
nothing about fan-out.

Raw request and response bodies land in `deploy/runtime/verify/<timestamp>/`,
which is ignored by git. Nothing under `phase-1/` or `phase-2/` is written to.

### When it does not come up

| Symptom | Where to look |
| --- | --- |
| `bring-up.sh` stops at the yq check | The `yq` on `PATH` is the Go one. `apt-get install -y yq jq` gives you the python one; put it first on `PATH`. |
| `network beckn_network declared as external, but could not be found` | `bring-up.sh` creates it. If you ran `docker compose up` by hand first, run `docker network create beckn_network`. |
| Registry never answers `POST /subscribers/lookup` | `docker logs registry`. On a cold host the JVM takes a minute or more. If the container is restarting, check `docker inspect registry --format '{{.RestartCount}}'`. |
| Seeding fails with `Invalid domain ONDC:TRV11` | The network domain was not created. Re-run `deploy/seed-registry.sh`; it creates the domain before registering anyone. |
| Seeding reports a key mismatch | The registry holds a key from an earlier run. Re-run `deploy/seed-registry.sh`, which rotates it, or `deploy/teardown.sh` for a clean start. |
| The gateway registered itself as the literal string `SUBSCRIBER_ID` | Its `swf.properties` was rendered without substituting the placeholder. `deploy/teardown.sh` then `deploy/bring-up.sh`; the gateway's identity is written into its own database on first boot and cannot be edited afterwards. |
| `verify.sh` returns HTTP 200 with **one** callback | One BPP did not answer inside the collection window. `SEARCH_TTL` is `PT4S`; `phase-1/RESULTS.md` documents a callback arriving late being dropped. Check `docker compose logs bmtc-bpp-client bmrcl-bpp-client`. |
| `verify.sh` returns **zero** callbacks | Read the gateway window in the run directory first. A `NullPointerException` on `getExtensionPackage()` means the gateway network config has no `domains` entry. An outbound `curl` logged with no response and nothing at the BPP means `core_version` is wrong. Otherwise it is signing: check `deploy/runtime/registry-lookup.raw.json` against `stage-0/onix-sync/runtime/public-keys.tsv`. |
| The gateway logs the fan-out `curl` but the BPP never logs the request | The gateway is not opening the connection. Check `core_version` in `deploy/runtime/gateway-config/networks/onix.json`. This was also seen unresolved under ARM emulation with the config correct; see [what was verified](#what-was-verified-and-what-was-not). |
| Callbacks come back as 401 / `Authentication failed` | Same cause. Re-run `deploy/seed-registry.sh`. |
| The provider image build fails with `npm error Exit handler never called!` after about five minutes | npm's fetch timeout. `package-lock.json` points at a private registry the build container cannot reach. See [One thing to fix before the first deploy](#one-thing-to-fix-before-the-first-deploy). |
| RabbitMQ keeps dying | You are on ARM. See [x86_64 only](#x86_64-only-and-why). |
| A protocol server exits 0 shortly after starting, with `MQ_ConnectionFailed` in its log | It started before RabbitMQ was accepting connections. `depends_on` in `stage-0/onix-sync/docker-compose.yml` orders the start but does not wait for readiness. `bring-up.sh` brings the queue up first and waits for it; if you ran `docker compose up` by hand, run it again. |
| Everything is slow and the provider build times out | Under 3 GB of RAM, or an emulated host. |

### What was verified, and what was not

The deployment scripts were written and exercised on an **arm64 macOS host
under amd64 emulation**, which is the machine that was available and is the
architecture this section tells you not to deploy on. Being precise about that:

**Verified by running, more than once:**

- preflight, `beckn_network` creation, and rendering the registry and gateway
  config from the pinned beckn-onix templates;
- the registry and gateway starting, answering, and the gateway registering
  itself;
- `prepare-runtime.sh` generating keys behind its new dependency check;
- the whole of `deploy/seed-registry.sh` on an empty registry, and again on a
  rerun after every key had been regenerated, which exercised the key-rotation
  path;
- both lookup assertions, including the narrow BPP lookup the gateway issues;
- `docker compose up` bringing all six protocol servers and the provider to
  listening, and `GET /healthz` returning 200;
- `deploy/verify.sh` sending its search through the BAP and the gateway,
  capturing raw evidence, asserting, and failing loudly with the right
  diagnosis when the network was not ready;
- `deploy/teardown.sh` removing both Compose projects, the network, the
  volumes, the generated keys, the rendered config and the pulled registry and
  gateway images, leaving no container, no volume and no `beckn_network`
  behind;
- the ordering fix that this shook out: a protocol server started alongside a
  recreated RabbitMQ logs `MQ_ConnectionFailed` and exits 0, which looks like a
  clean shutdown, so `bring-up.sh` brings the queue up first and waits for it.

**Verified as gateway behaviour, by experiment:** that a missing `domains`
entry causes the `getExtensionPackage()` NullPointerException, and that
`core_version: 1.1.0` causes the gateway to log an outbound request it never
sends. The second was pinned down by replacing a BPP with a bare HTTP sink at
the same host and port and watching the request arrive.

**NOT verified: the green result.** On this host `deploy/verify.sh` never
passed. Two blockers were hit, both of them properties of the machine rather
than of these scripts:

1. **RabbitMQ.** The locally cached `rabbitmq:3.13-management-alpine` was the
   amd64 image, and under emulation it died with the Erlang
   `{badmap,provided_by}` this section describes. Pulling the **native arm64**
   variant of the same tag started cleanly, first try, which is direct evidence
   that the crash is an emulation artifact and not an image defect. On x86_64
   the amd64 image is native and this does not arise.
2. **The last hop.** With the gateway configured correctly it fans the search
   out, and a bare HTTP sink standing in for a BPP receives the request,
   including when the sink is given the BPP's own hostname and port. The real
   ONIX BPP protocol server never sees it. Neither side logs anything: the
   gateway logs the outbound `curl` and completes its task, and the protocol
   server's first middleware, which logs every request it does receive, records
   nothing. That same protocol server accepts and processes a byte-similar
   request sent by hand from inside the gateway container, with all three
   signature headers and `Expect: 100-continue`, and answers 401 on the bad
   signature as it should. Restarting the gateway after the protocol servers,
   to rule out a stale DNS entry, changes nothing. This was not root-caused. It
   is recorded as an open question rather than a solved one, and it is the one
   thing to watch for on the first x86_64 run.

**Also not verified:** the provider image build. `package-lock.json` resolves
from a private registry (see
[One thing to fix before the first deploy](#one-thing-to-fix-before-the-first-deploy)).
For local testing the image was built against the public registry outside these
scripts and `bring-up.sh --no-build` was used.

**Not verified on x86_64 Linux at all.** No x86_64 host was available, and no
remote machine was contacted. Treat the first run on a real target as a first
run, and run `deploy/verify.sh` before believing it.

Anything in `deploy/` that could not be verified says so in the file itself.

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
| `JOURNEY_SOURCE` | `fixture` | Journey source selector: `fixture` or `http` |
| `JOURNEY_SOURCE_URL` | empty | Required planner endpoint when `JOURNEY_SOURCE=http` |
| `JOURNEY_SOURCE_RESPONSE_SCHEMA` | `/app/schemas/journey-source-response.json` | Planner response JSON Schema |
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
| `BMTC_WEBHOOK_URL` | `http://transit-bpp:7001/bmtc/inbound` | BPP client webhook seam into the provider |
| `BMTC_CALLBACK_DELAY_MS` | `0` | Test-only artificial callback delay |
| `BMRCL_BPP_ID` | `bmrcl.bpp.transit.localhost` | BMRCL BPP subscriber ID |
| `BMRCL_BPP_URI` | `http://bmrcl-bpp-network:6102` | BMRCL BPP network subscriber URI |
| `BMRCL_BPP_CLIENT_PORT` | `6101` | BMRCL BPP client port |
| `BMRCL_BPP_NETWORK_PORT` | `6102` | BMRCL BPP network port |
| `BMRCL_CALLBACK_URL` | `http://bmrcl-bpp-client:6101/on_search` | Provider callback destination |
| `BMRCL_WEBHOOK_URL` | `http://transit-bpp:7001/bmrcl/inbound` | BPP client webhook seam into the provider |
| `BMRCL_CALLBACK_DELAY_MS` | `0` | Test-only artificial callback delay |
| `SEARCH_TTL` | `PT4S` | ONIX synchronous discovery collection window |

The pinned ONIX protocol server exposes one `client.webhook.url` per BPP, not a
separate configurable webhook URL per action. This contradicts the per-action
webhook assumption in SPEC section 6.1. The running ONIX clients therefore post
all inbound actions to `/{operator}/inbound`, where the provider dispatches by
`context.action`. The action-specific `/{operator}/search`, `/select`, `/init`,
`/confirm` and `/status` routes remain available for direct provider tests.

The published ONIX image does not bundle a schema that can validate TRV11
2.0.1 payments. Its core 1.1 schema uses `PRE-ORDER` and `NOT-PAID`, while the
TRV11 contract uses `PRE_ORDER` and `NOT_PAID`. Compose therefore mounts the
official generated OpenAPI artifact from ONDC's `release-TRV11-2.0.1` branch.
The unmodified file is
`stage-0/onix-sync/schemas/upstream-release-TRV11-2.0.1.yaml`. ONIX mounts
`core_2.0.1.yaml`, a compatibility copy that additionally permits the
`core_version`, `country` and `city` fields its own context builder adds, plus
local-name tags on stops. The provider also performs its action-specific subset
validation at its own boundary. `openAPIValidator.cachedFileLimit` is four so
ONIX compiles the mounted 2.0.1 schema before opening its port, instead of
spending roughly 14 seconds compiling it during the first action.

## TRV11 schema provenance and scope

The JSON Schemas under `schemas/ondc_trv11/2.0.1/` are locally authored,
purpose-built subsets. They are not copies of ONDC's published schemas. They
were derived from the examples and contract on ONDC's
[`release-TRV11-2.0.1`](https://github.com/ONDC-Official/mobility-specification/tree/release-TRV11-2.0.1)
release branch.

The separate
`stage-0/onix-sync/schemas/upstream-release-TRV11-2.0.1.yaml` file is the
unmodified generated upstream OpenAPI artifact. The adjacent
`core_2.0.1.yaml` is its documented ONIX compatibility copy. Neither is one of
the provider's local JSON Schema subsets.

The local schemas enforce the boundary this service currently implements:

- Required `context` and `message` envelopes, TRV11 domain, action and version.
- Required BAP and BPP correlation fields for each applicable callback.
- Search endpoints, stop locations, and `BUS` or `METRO` vehicle categories.
- Catalogue provider, fare-product item, `TRIP` fulfillment, stop, vehicle and
  payment structure.
- INR rupee-string prices, including at most two decimal places.

They do not enforce the entire upstream contract. In particular, they omit:

- Most URI, UUID, RFC 3339 timestamp and full ISO 8601 duration formats.
- Unknown-field rejection and many nested cardinality constraints.
- Full tag-group code and enumeration validation.
- Cross-reference integrity, uniqueness, stop ordering and parent-stop chain
  rules.
- Complete quantity, payment, settlement and domain business rules.
- Actions other than the schema files present in that directory.

Application tests cover important omitted cross-field rules such as stable
paise conversion and fulfillment references. A local validation pass therefore
means "valid against this implemented TRV11 subset", not certification against
the complete published ONDC schema.

## Licence

MIT. See [`LICENSE`](LICENSE).

Built on [`beckn-onix`](https://github.com/beckn/beckn-onix) (MIT) and against
[ONDC's mobility specification](https://github.com/ONDC-Official/mobility-specification),
branch `release-TRV11-2.0.1`.
