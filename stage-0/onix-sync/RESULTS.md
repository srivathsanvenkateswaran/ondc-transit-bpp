# beckn-onix two-BPP synchronous search spike

This file records the Stage 0 experiment as run with `PT15S`. Phase 1 later
changed the tracked templates to `PT4S`; see
[`../../phase-1/RESULTS.md`](../../phase-1/RESULTS.md) for that measurement and
its dropped-response cost.

## Result

The BAP protocol server's synchronous client mode **aggregates callbacks from
both BPPs**. One `POST /search` returned HTTP 200 after 15.073867 seconds with
two entries in `responses`: one from `bmtc.bpp.transit.localhost` and one from
`bmrcl.bpp.transit.localhost`.

This resolves SPEC section 15 question 1 in favor of the synchronous design.
The consuming app does not need Beckn callback endpoints, and the planned
two-operator scope can remain. No provider backend was implemented in this
spike.

## Installed topology

beckn-onix revision `6f5aaede1994d4293a6bc992e6ee14f63cc63d29` was
installed from `install/beckn-onix.sh` by selecting option 4. That option
installed the registry, gateway, BAP protocol-server configuration, and BPP
protocol-server configuration. The installer command was:

```console
bash install/beckn-onix.sh
# selection: 4
```

The current option-4 script starts the registry and gateway but only renders
the protocol-server configuration. The six protocol-server processes were
therefore started from the published image using
[`docker-compose.yml`](docker-compose.yml) and the sanitized files under
[`config/`](config/). `prepare-runtime.sh` substitutes fresh private/public
keys into ignored runtime copies; private keys are not committed.

| Role | Subscriber ID | Client | Network |
| --- | --- | ---: | ---: |
| BAP | `bap.transit.localhost` | 5001 | 5002 |
| BMTC BPP | `bmtc.bpp.transit.localhost` | 6001 | 6002 |
| BMRCL BPP | `bmrcl.bpp.transit.localhost` | 6101 | 6102 |

The protocol-server image is pinned to
`fidedocker/protocol-server@sha256:4f15b3a82c32a0a9b7aac79cc692a029b85d8b845f2b0b6c10fbefd0327b8e23`
with `platform: linux/amd64`. Each service runs one `node dist/app.js` process;
the image's default PM2 configuration starts three workers per container and
exhausted Docker Desktop memory with six protocol-server containers.

The installer-provided RabbitMQ 3.8 amd64 image segfaulted under Apple Silicon
emulation. The test harness uses the wire-compatible, multi-arch
`rabbitmq:3.13-management-alpine`; MongoDB remains `mongo:4.4` on amd64 and
Redis remains `redis:6.2.5-alpine`.

The BAP client configuration is synchronous, backed by MongoDB, with a 15
second search collection window:

```yaml
client:
  synchronous:
    mongoURL: mongodb://beckn:beckn123@sync-mongo:27017/protocol_server?authSource=admin
app:
  actions:
    requests:
      search:
        ttl: PT15S
    responses:
      on_search:
        ttl: PT15S
```

## Two registered sellers

The registry contains two independent, `SUBSCRIBED` BPP roles for
`ONDC:TRV11` / `IND` / `std:080`, pointing to different BPP network servers.
The exact lookup was:

```console
curl -sS -H 'Content-Type: application/json' \
  --data '{"type":"BPP","domain":"ONDC:TRV11","country":"IND","city":"std:080"}' \
  http://localhost:3030/subscribers/lookup
```

Its unmodified response is
[`evidence/registry-bpp-lookup.raw.json`](evidence/registry-bpp-lookup.raw.json).

## Experiment

The published sandbox image does not recognize `ONDC:TRV11`; its bundled
domain switch accepts only `mobility:ridehailing:0.8.0`,
`mobility:publictransport:0.8.0`, and `nic2004:60221`. It returns HTTP 404
`Domain not found` for a TRV11 request. To test the protocol-server behavior
without implementing a provider backend, the gateway broadcast the TRV11
search to both registered BPP network servers, then two minimal callbacks were
submitted through the two BPP protocol-server client APIs.

The request was started first and remained blocked while the callbacks were
submitted:

```console
curl -sS -o runtime/search-response.raw.json \
  -w '%{http_code} %{time_total}\n' \
  -H 'Content-Type: application/json' \
  --data-binary @evidence/search-request.json \
  http://localhost:5001/search

curl -sS -H 'Content-Type: application/json' \
  --data-binary @evidence/bmtc-on-search.json \
  http://localhost:6001/on_search

curl -sS -H 'Content-Type: application/json' \
  --data-binary @evidence/bmrcl-on-search.json \
  http://localhost:6101/on_search
```

The precise inputs are:

- [`evidence/search-request.json`](evidence/search-request.json)
- [`evidence/bmtc-on-search.json`](evidence/bmtc-on-search.json)
- [`evidence/bmrcl-on-search.json`](evidence/bmrcl-on-search.json)

Both callback submissions returned HTTP 202/ACK. The single blocking search
returned `200 15.073867`. Its unmodified response body is
[`evidence/search-response.raw.json`](evidence/search-response.raw.json).
The BAP response preserves the common transaction/message IDs and contains
both distinct BPP IDs, even though BMTC arrived at `04:05:51.329Z` and BMRCL
arrived later at `04:05:53.945Z`.

## Design decision

Use BAP protocol-server synchronous client mode for discovery. Keep BMTC and
BMRCL as separate BPP subscriber identities, let the supplied gateway
broadcast to both, and consume the aggregated `responses` array. Do not add an
application-owned async callback/correlation layer.
