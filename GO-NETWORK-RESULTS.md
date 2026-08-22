# Go network round-two results

Measured on 21 August 2026 on the same Apple M3 Max ARM host running Docker
Desktop. The Go stack ran native `linux/arm64`. The beckn-onix images ran as
`linux/amd64` under emulation.

## Headline

`deploy/verify.sh` printed `VERIFICATION PASSED` against the Go network. It
returned two fresh, automatically generated `on_search` callbacks from two BPP
identities in 7.7 ms on the first measured run. A second run after restoring the
stack from stopped containers also passed in 35.9 ms.

The existing stack was subsequently restored and repaired enough to produce one
passing verification in 4.10 s. It then returned zero callbacks for every load
request and its next verification failed. The Go result was therefore both
faster and repeatable on this host.

## Correctness

| Test | Result |
| --- | --- |
| Separate in-memory replicas | Cannot share callbacks, as expected |
| Two application instances with separate PostgreSQL connections | PASS, two callbacks returned to instance A through instance B |
| NATS work survives producer restart | PASS |
| BMTC select, init, confirm, status replay | 4 of 4 match |
| BMRCL select, init, confirm, status replay | 4 of 4 match |
| Gateway absent from all eight post-search replays | PASS |
| Phase 1 captured signature | PASS |
| Phase 1 one-byte tamper | Rejected |
| Entire Go test suite under the race detector | PASS |
| `go vet ./...` | PASS |

The evidence replay compares every callback field except `timestamp`,
`created_at`, `updated_at`, and `signature`. Transaction, message, order, ticket,
quote, payment, fulfillment, and subscriber identifiers remain part of the
comparison.

The replay found a real implementation defect. A formatted JSON request was
signed before being placed in a JSON transport envelope, whose encoding then
compacted the body and invalidated its signature. Transport envelopes now store
the body as bytes, preserving exactly what was signed.

## Measurements

### Collapsed Go versus beckn-onix

| Measurement | beckn-onix observed | Go collapsed observed |
| --- | ---: | ---: |
| Network processes | registry, gateway, 6 protocol servers | 1 |
| Total containers including unchanged provider and backing services | 12 | 2 |
| Network resident memory | about 3,701 MiB | 7.2 MiB |
| Unchanged provider resident memory | 36.4 MiB | 20.9 MiB |
| Total resident memory | about 3,863 MiB | 28.1 MiB |
| Unique image size on disk | 1,949,301,795 bytes | 174,175,061 bytes |
| `docker save` size | 1,975,261,696 bytes | 179,097,600 bytes |
| Search round trip | 4.10 s for its one successful fresh run | 7.7 ms first verification, 35.9 ms after restart |
| Cold start to first working search | No unattended result, startup failed on broker ordering | 0.572 s |
| Fresh search load | 0 valid two-callback responses of 64 | 1,000 of 1,000 valid |
| HTTP response rate at concurrency 16 | 3.77/s, but all were invalid empty results | 937.57 valid transactions/s |
| p99 at concurrency 16 | 4,370.9 ms, invalid empty results | 37.4 ms, valid two-callback results |

The recorded historical baseline was about 2.1 GB resident. This live restored
run was materially worse at about 3.86 GiB. JVM memory was 555.9 MiB for the
registry and 606.7 MiB for the gateway. Each emulated protocol server used
between 390.2 and 422.1 MiB. MongoDB used 110.3 MiB, RabbitMQ 136.3 MiB, and
Redis 11.5 MiB.

The existing stack did complete one fresh search after manual registry render,
key seeding, and a second protocol-server restart after RabbitMQ became ready.
The next 64 fresh concurrent searches all returned HTTP 200 after about four
seconds but none contained two callbacks. A following `deploy/verify.sh` also
returned zero callbacks. Its load figure is reported as zero valid
transactions/s rather than presenting HTTP 200 empty responses as throughput.

The container reduction is a property of the collapsed deployment shape. It is
not a property of Go by itself.

### Distributed shape

No distributed end-to-end throughput or memory number is reported. PostgreSQL
and NATS implementations exist and pass their integration and restart tests,
but the binary still exposes only the collapsed role launcher. Reporting the
component tests as a distributed network measurement would be misleading.

The intended distributed topology would require the participant processes,
PostgreSQL, NATS, and the unchanged provider. It retains the distributed-system
cost that collapsed mode removes. The role-isolated launcher and deployment
manifest remain release blockers.

## Reproduction

Collapsed load result:

```console
python3 deploy/measure-load.py --requests 1000 --concurrency 16
```

Collapsed cold start result:

```console
python3 deploy/measure-cold-start.py
```

Correctness:

```console
go test -race ./...
go vet ./...
deploy/verify.sh
```

The load tool creates a fresh transaction ID, message ID, and timestamp for
every request and counts a request as successful only when it returns HTTP 200
with exactly two callbacks.

## Remaining release blockers

- The distributed role launcher and role-isolated deployment do not exist.
- Distributed p99, memory, container, and cold-start measurements do not exist.
- Aggregate coverage is below the required 80 percent floor. Package coverage
  in this run ranged from 32.7 to 84.0 percent outside `main`.
- The current Compose replacement changes the root topology, so the legacy
  `deploy/bring-up.sh` can no longer start its backing services without being
  pointed explicitly at `stage-0/onix-sync/docker-compose.yml`.

## Recommendation

Use the collapsed Go network for the local ONDC demonstration. It is the first
topology measured here that starts reliably on ARM, repeatedly passes the live
two-seller verification, and sustains fresh two-callback searches under load.

Do not yet approve it as the national-scale replacement for beckn-onix. The
shared-state and durable-transport components are credible and their critical
failure modes are tested, but the distributed role isolation has not been wired
or measured and coverage remains below the agreed floor. The correct decision
is to continue the Go implementation, not abandon it and not claim production
readiness early.
