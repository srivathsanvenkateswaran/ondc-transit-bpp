# Codex prompt: the Beckn network in Go, built to scale

Copy everything below the line into Codex. It is written to be pasted whole.

Work happens on a branch. `main` ships as it is until this demonstrably wins.

---

You are reimplementing the `beckn-onix` network layer in Go, in
`ondc-transit-bpp`, on a branch named `go-network`. **Do not touch `main`.**

This is not a mock and not a toy. It must run a real ONDC transaction today on
one machine, and it must be an architecture that would survive a national
deployment. Those two goals are in tension and the design below resolves them.

## Read first

- `SPEC.md` sections 5.2, 5.3, 5.4 and 6.3. The diagram in 6.3 is the call
  sequence you must reproduce exactly.
- `phase-1/RESULTS.md`, `phase-2/RESULTS.md`, and **every file** under
  `phase-1/evidence/` and `phase-2/evidence/`. That is your acceptance bar.
- `deploy/verify.sh`, `deploy/bring-up.sh`, `deploy/network.compose.yml`.
- `stage-0/onix-sync/config/*.yml` - six files describing six processes.

## Scope

Replace what `beckn-onix` provides: **the registry, the gateway, and the
protocol-server layer** for all three participants (BAP, BMTC BPP, BMRCL BPP).

**Do not touch `src/`.** The TypeScript provider backend works, has 42 passing
tests and captured evidence, and answers on two URL prefixes. Your network calls
it through the same webhook interface it uses today. Rewriting it would gain
about eighty megabytes and put working code at risk.

## The architecture: one binary, two deployment modes

Ship **one Go binary** that can run in either of two shapes, chosen by
configuration, with **the same code paths** in both:

**Collapsed.** Every role in one process. Registry, gateway, and all three
participants' client and network faces. In-process channels between faces, an
in-memory store with TTLs, no broker, no database. This is what `docker compose
up` gives you and what the demo runs on.

**Distributed.** Each role a separate process, horizontally replicated, with a
real broker between the faces and a real shared store behind them.

The point is that these are **the same program with different wiring**, not two
codebases. Every seam below must be an interface with at least two
implementations, both tested.

## What "built for scale" actually requires, and why

These are not optional extras. Each one is a thing that breaks the moment there
is a second replica, and the existing stack has each for a reason.

**1. In-flight request state must be shareable.** The BAP holds a `search` open
until both `on_search` callbacks arrive. With one process a map works. With two
replicas the request lands on pod A and the callbacks arrive at pod B, and A's
map never sees them. That is exactly why `client.synchronous.mongoURL` exists in
the current config: it is **shared state across replicas**, not a cache.

Define a `PendingStore` interface: claim a correlation id, append a callback,
await N or a TTL, release. Ship an in-memory implementation and a Redis or
Postgres one. Test both against the same suite.

**2. Message handoff must be able to be durable.** ONDC's contract is ACK now,
callback later. If the provider is slow or restarting, the work must survive; an
ACK you cannot honour is a lie. An in-process channel is bounded and dies with
the process.

Define a `Transport` interface: publish, subscribe, ack, nack. Ship an
in-process channel implementation and one over a real broker, with at-least-once
delivery, retry with backoff, and a dead-letter path. Test both. **Prove the
durable one survives a restart with work in flight** - that is the test that
matters.

**3. The client/network split is a security boundary, not plumbing.** The
network face verifies signed requests from the whole internet against untrusted
input. The client face talks to internal systems. In production they sit in
different zones so a compromised network process cannot reach your database.

Keep them as distinct roles with distinct entry points even when collapsed into
one process, so the distributed mode is a configuration change rather than a
refactor. Do not let application-facing code become reachable from a
network-facing handler.

**4. The registry needs durability, not just storage.** It holds the public keys
every signature check depends on, so it needs persistence, key-rotation history
and an audit trail. Losing it is not a cache miss. Ship a file-backed
implementation for collapsed mode and a Postgres one for distributed, behind one
interface.

**5. Nothing may hold per-request state in a package-level variable.** That is
the single mistake that makes a program look correct on one instance and corrupt
on two.

## The parts that must be right, or none of it counts

**Ed25519 signing over the Beckn authorization scheme.** Every request carries an
`Authorization: Signature` header. `phase-1/evidence/auth-wire-request.txt` holds
a real captured header and `auth-tampered-response.raw.txt` shows a tampered body
rejected with HTTP 401. **Both must reproduce.** Signing is the thing this
network exists to demonstrate; a version that skips or stubs it has proved
nothing.

**The gateway appears exactly once**, during `search`. Everything after
`on_search` is addressed directly using the `bpp_id` and `bpp_uri` the BPP
stamped into its own `on_search` context.
`phase-2/evidence/gateway-phase2.raw.txt` is the gateway log across the captured
lifecycles and contains no `/select`, `/init`, `/confirm` or `/status` URL.
Reproduce that property and assert it.

**Synchronous collection.** SPEC 5.4: the BAP client blocks and returns both
`on_search` callbacks in one HTTP response. That finding is why the consuming
application needs no callback endpoints at all. Keep it, in both modes.

## Testing. This is not a section to skim

The existing stack earned trust through committed evidence and tests that parse
it. Meet that bar and exceed it.

**Unit.** Every package. Signing and verification, canonicalisation, the digest,
clock skew, an expired TTL, a malformed header, a key that is not in the
registry. Table-driven.

**The store and transport interfaces, twice.** One suite, run against both
implementations. If a test passes in memory and fails on Redis, the interface is
wrong and you have found it before production did.

**Evidence replay, and this is the acceptance bar.** For `select`, `init`,
`confirm` and `status`, for both operators, take the committed request files and
assert your network produces callbacks matching the recorded ones in every field
that is not a timestamp, a fresh id or a signature. Write it as a test that runs
in CI, not a script someone remembers to run.

**Race detection.** Every test under `-race`. A concurrency bug that only appears
under load is the failure mode this whole design is exposed to.

**Restart durability.** Kill the process with work in flight in distributed mode
and assert nothing is lost.

**Two replicas.** Run two client instances against one store. Send a `search` to
one and deliver its callbacks to the other. It must complete. **This single test
is the difference between a program that scales and one that appears to.**

**Load.** A benchmark that finds requests per second per instance at a fixed p99,
for both the collapsed and distributed shapes. Nobody has this number for the
current stack either, and it is the number every capacity estimate depends on.

Coverage above 80% on everything except `main` and generated code, reported and
enforced in CI. Coverage is a floor, not a goal; the tests above matter more than
the percentage.

## Measure honestly, and report against the current stack

Measured on the existing stack, on an emulated ARM host, idle:

```
registry (JVM)         619.8 MB       -Xmx4g, JDWP agent, swf.env=development
gateway  (JVM)         613.1 MB       same
6 x protocol-server    92 MB each     Node
MongoDB 109 MB · RabbitMQ ~120 MB · Redis 12 MB
12 containers          ~2.1 GB
search round trip      4.68 s         Phase 1, of which ~4 s is the collection TTL
```

Report, side by side and measured the same way on the same host: resident memory
per process and total, container count in both modes, image size on disk and as
a `docker save` file, cold start to a working `search`, the `search` round trip,
and requests per second per instance at a fixed p99.

**If it is not materially better, say so.** A measured negative result is worth
more than a rewrite that ships on a hunch. And be careful about one framing: the
container reduction in collapsed mode is a property of running **one instance**,
not of Go. The distributed mode needs the broker and the shared store exactly as
much as the current stack does. What Go removes is the runtime cost per process,
not the distributed-systems cost.

One live caveat, recorded in `deploy/verify.sh`'s own header: **it has never
printed a pass on ARM**, because RabbitMQ dies under emulation and the gateway's
last hop is unresolved. Your implementation has neither dependency, so it may be
the first thing to make that script go green. If it does, say so, because it is a
real result.

## Constraints

Go, standard library first; justify every dependency in the commit that adds it.
Both `linux/amd64` and `linux/arm64`, since that constraint is half of why this
is being tried. One `docker compose up` for collapsed mode with no external
network to create by hand. Structured logs. A `/healthz` and a `/readyz` that
mean something. Configuration from the environment with documented defaults and
no hardcoded host, port or credential anywhere.

## Working rules

- Branch `go-network`. Never commit to `main`.
- Keep the `AI-Assisted-By: OpenAI Codex` trailer on your commits.
- Commit at every working state; do not accumulate a large uncommitted tree.
- No em-dashes in prose, comments or commit messages.
- Report: the measurements above, the two-replica and restart test results, what
  you could not reproduce, and your own recommendation on whether this should
  replace `beckn-onix` or be abandoned.

---

# Round two: the three things that close it

Paste everything below into Codex, on the same `go-network` branch.

---

The foundation is good. Reviewed at `5257c7c`: builds clean, `go vet` clean,
**every package passes under `-race`**. One production dependency plus pgx and
nats. `pending`, `transport` and `registry` each have two implementations behind
one interface, and `TestMemoryStoreSuite` / `TestPostgresStoreSuite` run one
suite against both, which is exactly right. Signing is verified against the real
`phase-1/evidence/auth-replay-request.json` and its tampered twin rather than a
hand-written fixture, and `TestNATSSurvivesConsumerRestart` proves restart
durability.

What exists is a well-tested set of components. What is not yet demonstrated is
a **network**. Three things close that gap, and they are the three the first
brief named as acceptance rather than nice-to-have.

## 1. The two-replica test

This is the one that matters and it is not written.

> Two instances sharing one `PendingStore`. `POST /search` to instance **A**.
> Deliver both `on_search` callbacks to instance **B**. A's blocked request must
> return with both of them.

Everything needed is already there - the interface, the Postgres implementation,
the shared suite. Nobody has yet proved that a callback arriving at a *different
process* completes the request.

Write it so **the memory store fails it and Postgres passes**. That contrast is
the whole value: it is the executable statement of why the shared store exists,
and it is what stops someone deleting it later as an unnecessary dependency.

Do the same for `Transport` if the design allows a handoff to cross processes.

## 2. Lifecycle replay against the committed evidence

Today the only evidence any test reads is the signing header. So we know the
implementation signs correctly; we do not know it can carry a real `confirm`.

For **`select`, `init`, `confirm` and `status`, both operators**, take the
request files in `phase-2/evidence/` and assert your network produces callbacks
matching the recorded ones **in every field that is not a timestamp, a fresh id
or a signature.** A table-driven test over the files, running in CI, not a script
someone remembers.

While you are there, assert the property the current stack has and the log
proves: **the gateway appears exactly once**, during `search`.
`phase-2/evidence/gateway-phase2.raw.txt` contains no `/select`, `/init`,
`/confirm` or `/status` URL. Make that an assertion rather than an observation.

## 3. The measurements, which do not exist yet

There is not a single `Benchmark` function on the branch and no numbers in any
commit message. Every capacity claim anyone has made about this rests on figures
nobody has taken - including for the current stack.

**The number that matters most: requests per second per instance at a fixed
p99**, for both collapsed and distributed. Nobody has it for beckn-onix either,
so measure the current stack the same way and report both.

Then, side by side on one host, against the recorded baseline:

```
registry (JVM)         619.8 MB      gateway (JVM)   613.1 MB
6 x protocol-server    92 MB each    Mongo 109 · Rabbit ~120 · Redis 12
12 containers          ~2.1 GB
search round trip      4.68 s        of which ~4 s is the collection TTL
```

resident memory per process and total, container count in both modes, image size
on disk and as a `docker save` file, cold start to a working `search`, and the
`search` round trip.

## And the result worth having most

`deploy/verify.sh` **has never printed a pass**, on any stack, because RabbitMQ
dies under ARM emulation and the gateway's last hop is unresolved. Your
implementation has neither dependency.

Run it against the Go network. If it goes green, that is the strongest single
sentence available about this work, and it should be the headline of your report.

## Unchanged

Do not touch `main`. Do not touch `src/` - the TypeScript provider stays.
Keep the `AI-Assisted-By: OpenAI Codex` trailer. No em-dashes. Commit at every
working state.

Report: the two-replica result, how many of the eight lifecycle replays match,
the measurements, whether `verify.sh` passed, and your own recommendation on
whether this should replace `beckn-onix`.

