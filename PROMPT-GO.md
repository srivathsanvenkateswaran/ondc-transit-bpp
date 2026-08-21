# Codex prompt: a Go Beckn network, as an experiment

Copy everything below the line into Codex. It is written to be pasted whole.

This is **exploratory work on a branch**. `main` ships as it is. Nothing here
changes what is deployed unless it demonstrably wins.

---

You are running an experiment in `ondc-transit-bpp`: replacing the `beckn-onix`
network layer with a single Go implementation, and measuring whether it is worth
having.

Work on a branch named `go-network`. **Do not touch `main`.**

## Read first

- `SPEC.md` sections 5.2, 5.3, 5.4 and 6.3. Section 6.3's diagram is the call
  sequence you must reproduce exactly.
- `phase-1/RESULTS.md` and `phase-2/RESULTS.md`, and every file under
  `phase-1/evidence/` and `phase-2/evidence/`. **These are the acceptance bar.**
- `deploy/bring-up.sh`, `deploy/verify.sh`, `deploy/network.compose.yml`.
- `stage-0/onix-sync/config/*.yml` - six files that describe six processes.

## The scope, and what it excludes

**Replace `beckn-onix` only:** the registry, the gateway, and the six protocol
servers.

**Do not touch `src/`.** The TypeScript provider backend works, has 42 passing
tests and captured evidence, and answers on two URL prefixes. It stays exactly
as it is, and your network must call it through the same webhook interface it
uses today. Rewriting it would gain about 80 MB and put working code at risk.

## Why this is worth trying, measured

Current stack, measured on an emulated ARM host:

```
registry (JVM)         619.8 MB      -Xmx4g, JDWP agent, swf.env=development
gateway  (JVM)         613.1 MB      same
6 x protocol-server    552 MB        92 MB each, Node
MongoDB                109 MB
RabbitMQ               ~120 MB       crashes under emulation, two versions now
Redis                  12 MB
                     ─────────
12 containers          ~2.1 GB
```

The registry commits 248 MB of heap to hold 146. The gateway commits 200 to
hold 70. Neither is doing heavy work: the registry stores subscriber records
and answers a lookup, the gateway looks up sellers and fans a request out.

A Go implementation should land near **50 MB total across two or three
containers**, with no broker and no external database. That is the hypothesis
you are testing. **Measure it; do not assert it.**

## What the six protocol servers are, and why they might become one

Each participant runs the same image twice: `gateway.mode: client` faces the
application, `gateway.mode: network` faces the wire, and the two halves pass
messages through RabbitMQ queues. That split exists so the internet-facing and
application-facing processes can be firewalled and scaled separately.

On one box it buys nothing. **In Go, one process can serve all three
participants** - BAP, BMTC BPP, BMRCL BPP - on separate ports or paths, with no
broker, because two goroutines need no message bus to talk. Establish whether
that holds and say so.

## The parts that must be right, or the experiment is worthless

**Ed25519 signing over the Beckn authorization scheme.** Every request carries
an `Authorization: Signature` header. `phase-1/evidence/auth-wire-request.txt`
has a real captured header; `auth-tampered-response.raw.txt` shows a tampered
body rejected with HTTP 401. **Both must reproduce.** Signing is the one thing
this network exists to demonstrate, and a Go version that skips or fakes it has
proved nothing.

**The gateway appears exactly once**, during `search`. Everything after
`on_search` is addressed directly using the `bpp_id` and `bpp_uri` the BPP
stamped into its own `on_search` context. `phase-2/evidence/gateway-phase2.raw.txt`
is the gateway log for the captured lifecycles and contains no `/select`,
`/init`, `/confirm` or `/status` URL. Reproduce that property.

**Synchronous collection.** SPEC 5.4: the BAP client blocks and returns both
`on_search` callbacks in one HTTP response. That finding is why the consuming
application needs no callback endpoints at all. Keep it.

**The registry is the trust anchor.** It holds the public keys every signature
check depends on. A subtle bug here does not crash, it silently accepts
something it should not. Test it accordingly.

## Acceptance: the same bar, not a new one

`deploy/verify.sh` defines success and does not change: one `POST /search`
through the gateway returns two `on_search` callbacks from two distinct BPP
subscriber ids under one transaction id.

Beyond that, **replay the committed evidence**. For each of `select`, `init`,
`confirm` and `status`, in both operators' captured request files, your network
must carry the message to the provider and return a callback that matches the
recorded one in every field that is not a timestamp, a fresh id or a signature.
Write the comparison as a test, not as a manual check.

Note one live caveat recorded in `deploy/verify.sh`'s own header: **it has never
printed a pass on ARM**, because RabbitMQ dies under emulation and the gateway's
last hop is unresolved. Your Go version has neither of those dependencies, so it
may be the first thing to make that script go green. If it does, say so plainly,
because it is a real result.

## Measure honestly

Report, side by side and measured the same way on the same host:

- resident memory, per container and total
- container count
- image size on disk, and as a `docker save` file
- cold start to a working `search`
- the `search` round trip, against Phase 1's recorded 4.68 s

If the Go version is not materially better, **say so**. A negative result that
is measured is worth more than a rewrite that ships on a hunch.

## Constraints

Go, standard library first. Every dependency you add, justify in the commit.
No database, no broker, no cache, unless you can show the design needs one.
x86_64 and arm64 both, since that constraint is half of why this is being tried.
One `docker compose up`, no external network to create by hand.

## Working rules

- Branch `go-network`. Never commit to `main`.
- Keep the `AI-Assisted-By: OpenAI Codex` trailer on your commits.
- Commit at every working state; do not accumulate a large uncommitted tree.
- No em-dashes in prose, comments or commit messages.
- Report: the measurements above, what you could not reproduce, and your own
  recommendation on whether this should replace `beckn-onix` or be abandoned.
