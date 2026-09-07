import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReservedDatabase } from "../../src/reserved/db.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import {
  HttpFleetManifestPublisher,
  InertFleetManifestPublisher,
} from "../../src/reserved/fleetManifest.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { ReservedStore } from "../../src/reserved/store.js";
import { loadConfig } from "../../src/config.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
} from "../helpers.js";
import {
  FLEET_SIM_ABSENT_MESSAGE,
  fleetSimRepoPath,
  fleetSimRepoPresent,
  startFleetSim,
  type RunningFleetSim,
} from "./fleetSimHarness.js";

/**
 * The seam `docs/intercity-coaches.md` §7.4 specifies and, before this
 * change, nothing in this repository ever crossed: a confirm or a
 * cancellation publishing a seat count to the sibling fleet simulator's
 * `PUT`/`DELETE /fleet/manifest`. This test drives the real publisher against
 * the real simulator - not a belief about either - the way
 * `Tatak/tests/reservations/integration.test.ts` drives this provider against
 * the real BPP from the other side of a comparable seam.
 *
 * It needs no network beyond the loopback interface and no Docker, and it
 * skips with a message naming the path it looked in when the sibling
 * repository is not checked out. A machine holding one checkout still runs a
 * green suite.
 *
 * ## Why the clocks are frozen, and to two different instants
 *
 * `GET /fleet/resolve?code=<bin>` - the only endpoint that actually carries
 * `duty.reservation.manifest` (see the note below the harness) - only
 * attaches a duty to a BIN while the query instant falls inside that duty's
 * own `[departureAt, scheduledArrivalAt)` window (`coachWorld.ts`'s
 * `runForBin`). This provider's own booking window closes
 * `RESERVATION_CLOSE_MINUTES` before departure. Those two windows do not
 * overlap, so one frozen instant cannot satisfy both sides at once:
 *
 *  - This provider's own clock (`ReservedOrderOptions.now`) is frozen well
 *    before departure, so a confirm and both cancellations stay inside the
 *    booking window for the whole test.
 *  - The simulator's clock (`SIM_CLOCK`) is frozen partway through the
 *    journey, so every manifest read-back lands inside the active-run
 *    window.
 *
 * The manifest's own `asOf` travels from the first clock to the second in the
 * push itself, and `INTERCITY_MANIFEST_MAX_AGE_SECONDS` is raised on the
 * simulator so the gap between the two frozen instants is never mistaken for
 * staleness - this test is about the push arriving and being read back, not
 * about the age rule `docs/intercity-coaches.md` §7.6 already covers
 * elsewhere.
 */

const REPO = fleetSimRepoPath();
const PRESENT = fleetSimRepoPresent();

if (!PRESENT) {
  // Printed rather than swallowed: a suite that quietly skips its only
  // cross-repository check reads as a suite that ran it.
  console.warn(FLEET_SIM_ABSENT_MESSAGE(REPO));
}

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(new URL("../../migrations/reserved", import.meta.url));
const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");

const SERVICE_ID = "2259BNGHMP";
const TRAVEL_DATE = "2026-09-15";
const ITEM = `RSV-${SERVICE_ID}-${TRAVEL_DATE}-PALLAKKI`;
/** This provider's own clock: 08:00Z, well inside the booking window for a 17:29Z departure. */
const BPP_NOW = Date.parse("2026-09-15T08:00:00.000Z");
/** The simulator's clock: 30 minutes after departure, inside the active-run window. */
const SIM_CLOCK_INSTANT = "2026-09-15T18:00:00.000Z";
const MANIFEST_TOKEN = "fleet-manifest-integration-test-token";

const PASSENGERS = [
  { seatId: "L2B", name: "A Passenger", age: 34, gender: "female" as const },
  { seatId: "L3B", name: "B Passenger", age: 36, gender: "male" as const },
];

/**
 * `clock.at` is mutable and advanced between lifecycle stages rather than
 * held at one instant for the whole test. The manifest's own `asOf` is its
 * version (`docs/intercity-coaches.md` §7.4: "a push whose `asOf` is not
 * strictly newer than the stored one is accepted, discarded"), so three
 * pushes at one identical instant would have the simulator keep only the
 * first and silently discard the other two as out of order - correct
 * behaviour on the simulator's side, and a real trap for a test that wants
 * to observe all three.
 */
function harness(
  clock: { at: number },
  fleetManifest?: InstanceType<typeof HttpFleetManifestPublisher> | InertFleetManifestPublisher,
  events: Record<string, unknown>[] = [],
) {
  let counter = 0;
  const idFactory = () => `${String((counter += 1)).padStart(8, "0")}-fixed`;
  const store = new ReservedStore(openReservedDatabase({ url: ":memory:", migrationRoot }), {
    idFactory,
  });
  const orders = new ReservedOrderService(
    "ksrtc",
    source,
    {
      subscriberId: "ksrtc.provider.example.test",
      subscriberUri: "https://ksrtc-network.example.test",
    },
    store,
    {
      publicBaseUrl: "https://provider.example.test",
      reservation: {
        closeMinutes: 45,
        horizonDays: 30,
        occupancySeed: 20_260_905,
        holdTtlSeconds: 600,
        manifestRetentionDays: 30,
      },
      now: () => new Date(clock.at),
      idFactory,
      ...(fleetManifest ? { fleetManifest } : {}),
      eventLogger: (fields) => events.push(fields),
    },
  );
  return { orders, store, events };
}

/**
 * `GET /fleet/duty` (§10.3, the join key this provider's own
 * `docs/reserved-intercity.md` §18 commits to) never carries a
 * `reservation` key in this build - only the assignment envelope around it.
 * `duty.reservation.manifest` is carried on `GET /fleet/resolve`, keyed by
 * BIN, and only while the query instant falls inside the duty's own active
 * window. This is not what the join-key endpoint's own purpose would
 * suggest, and it is called out in the report rather than worked around
 * silently: a caller that only holds `(serviceId, travelDate)` - which is
 * this provider's own position, by design (§18: "this provider never
 * invents a plate, and never names a vehicle") - cannot read a manifest back
 * from this simulator build without first resolving a BIN through
 * `/fleet/duty`'s `assignment`. This helper does exactly that, because a
 * test is allowed to know a fact the production publisher deliberately does
 * not need.
 */
async function readManifest(
  simUrl: string,
  serviceId: string,
  travelDate: string,
): Promise<{ seatsBooked: number; seatsTotal: number } | undefined> {
  const duty = (await (
    await fetch(`${simUrl}/fleet/duty?service=${serviceId}&date=${travelDate}`)
  ).json()) as {
    assignment: { status: string };
    vehicle: { bin: string } | null;
  };
  assert.ok(
    duty.vehicle?.bin,
    `expected /fleet/duty to disclose a vehicle for ${serviceId}/${travelDate}; got assignment ${JSON.stringify(duty.assignment)}`,
  );
  const resolved = (await (
    await fetch(`${simUrl}/fleet/resolve?code=${duty.vehicle.bin}&entry=manual`)
  ).json()) as {
    duty: { reservation?: { required: boolean; manifest?: { seatsBooked: number; seatsTotal: number } } };
  };
  return resolved.duty.reservation?.manifest;
}

/* ------------------------------------------------------------------ *
 * The round trip against the real simulator
 * ------------------------------------------------------------------ */

test(
  "confirm, partial cancel and whole cancel each publish to the real fleet simulator",
  { skip: PRESENT ? false : FLEET_SIM_ABSENT_MESSAGE(REPO) },
  async () => {
    let sim: RunningFleetSim | null = null;
    try {
      sim = await startFleetSim({
        env: {
          MANIFEST_TOKEN,
          SIM_CLOCK: SIM_CLOCK_INSTANT,
          INTERCITY_MANIFEST_MAX_AGE_SECONDS: "604800",
        },
      });
      assert.ok(sim, "the fleet simulator did not start");

      const publisher = new HttpFleetManifestPublisher({
        url: sim.url,
        token: MANIFEST_TOKEN,
        ttlSeconds: 3600,
      });
      const clock = { at: BPP_NOW };
      const { orders, events } = harness(clock, publisher);

      /* 1. Confirm names both passengers and both seats. */
      await orders.select(
        reservedOrderRequest("select", { itemId: ITEM, seatIds: ["L2B", "L3B"] }) as never,
      );
      const confirmed = await orders.confirm(
        reservedOrderRequest("confirm", {
          itemId: ITEM,
          seatIds: ["L2B", "L3B"],
          manifest: PASSENGERS,
        }) as never,
      );
      const orderId = (confirmed.order as { id: string }).id;

      const afterConfirm = await readManifest(sim.url, SERVICE_ID, TRAVEL_DATE);
      assert.ok(afterConfirm, "expected a manifest after confirm");
      assert.equal(afterConfirm!.seatsBooked, 2);
      assert.equal(afterConfirm!.seatsTotal, 30);
      assert.deepEqual(
        events.filter((event) => event.outcome === "FAILED"),
        [],
        "the confirm push must not fail against a running simulator",
      );

      /* 2. Cancel one passenger: the remaining one is still there, the cancelled one is gone. */
      // Advanced so this stage's push carries a strictly newer `asOf` than
      // the confirm's - see the harness's own note on why.
      clock.at += 60 * 60 * 1000;
      const partialQuote = await orders.cancel(
        reservedCancelRequest({ orderId, code: "SOFT_CANCEL", seatIds: ["L2B"] }) as never,
      );
      const partialQuoteId = (
        (partialQuote.tags as Array<{ descriptor: { code: string }; list: Array<{ descriptor: { code: string }; value: string }> }>)
          .find((tag) => tag.descriptor.code === "REFUND_SLAB")!
          .list.find((entry) => entry.descriptor.code === "REFUND_QUOTE_ID")!.value
      );
      await orders.cancel(
        reservedCancelRequest({
          orderId,
          code: "CONFIRM_CANCEL",
          seatIds: ["L2B"],
          quoteId: partialQuoteId,
        }) as never,
      );

      const afterPartialCancel = await readManifest(sim.url, SERVICE_ID, TRAVEL_DATE);
      assert.ok(afterPartialCancel, "a partial cancel must publish the remaining passenger, not clear the manifest");
      assert.equal(afterPartialCancel!.seatsBooked, 1);

      /* 3. Cancel the rest: the manifest is cleared, not left holding an empty count. */
      clock.at += 60 * 60 * 1000;
      const wholeQuote = await orders.cancel(
        reservedCancelRequest({ orderId, code: "SOFT_CANCEL", seatIds: ["L3B"] }) as never,
      );
      const wholeQuoteId = (
        (wholeQuote.tags as Array<{ descriptor: { code: string }; list: Array<{ descriptor: { code: string }; value: string }> }>)
          .find((tag) => tag.descriptor.code === "REFUND_SLAB")!
          .list.find((entry) => entry.descriptor.code === "REFUND_QUOTE_ID")!.value
      );
      await orders.cancel(
        reservedCancelRequest({
          orderId,
          code: "CONFIRM_CANCEL",
          seatIds: ["L3B"],
          quoteId: wholeQuoteId,
        }) as never,
      );

      const afterWholeCancel = await readManifest(sim.url, SERVICE_ID, TRAVEL_DATE);
      assert.equal(
        afterWholeCancel,
        undefined,
        "a whole-booking cancellation must clear the manifest rather than leave a stale or empty one",
      );
    } finally {
      await sim?.stop();
    }
  },
);

/* ------------------------------------------------------------------ *
 * The two ways the seam stays silent rather than guessing
 * ------------------------------------------------------------------ */

test(
  "an unset MANIFEST_TOKEN answers PUT /fleet/manifest with the simulator's documented 404, never a 401",
  { skip: PRESENT ? false : FLEET_SIM_ABSENT_MESSAGE(REPO) },
  async () => {
    let sim: RunningFleetSim | null = null;
    try {
      // No MANIFEST_TOKEN at all - §10.5's absent-by-default case.
      sim = await startFleetSim();
      assert.ok(sim, "the fleet simulator did not start");
      const response = await fetch(`${sim.url}/fleet/manifest`, {
        method: "PUT",
        headers: {
          authorization: "Bearer whatever-a-caller-happens-to-send",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          serviceId: SERVICE_ID,
          travelDate: TRAVEL_DATE,
          seats: { total: 30, booked: 1, held: 0, simulated: 0 },
          asOf: new Date(BPP_NOW).toISOString(),
          ttlSeconds: 3600,
        }),
      });
      // Not 401: a bearer token was presented and there is nothing configured
      // to check it against, so this is the same 404 any unknown path gets.
      assert.equal(response.status, 404);
    } finally {
      await sim?.stop();
    }
  },
);

test("this provider's own publisher is inert with no FLEET_MANIFEST_URL configured, and dials nothing", async () => {
  const config = loadConfig({
    PROVIDER_HOST: "0.0.0.0",
    PROVIDER_PORT: "7001",
    PROVIDER_PUBLIC_BASE_URL: "https://provider.example.test",
    CALLBACK_TIMEOUT_MS: "3000",
    CONTEXT_TTL: "PT30S",
    BMTC_BPP_ID: "bmtc.example.test",
    BMTC_BPP_URI: "https://bmtc-network.example.test",
    BMTC_CALLBACK_URL: "https://bmtc-client.example.test/on_search",
    BMTC_CALLBACK_DELAY_MS: "0",
    BMRCL_BPP_ID: "bmrcl.example.test",
    BMRCL_BPP_URI: "https://bmrcl-network.example.test",
    BMRCL_CALLBACK_URL: "https://bmrcl-client.example.test/on_search",
    BMRCL_CALLBACK_DELAY_MS: "0",
  });
  // No default: the trap `journeySourceUrl` and `reservedSourceUrl` already
  // document is a hardcoded fallback that turns "nobody configured this"
  // into a guess at a port nobody asked this provider to reach.
  assert.equal(config.fleetManifestUrl, undefined);

  const originalFetch = globalThis.fetch;
  let dialled = 0;
  globalThis.fetch = (() => {
    dialled += 1;
    throw new Error("the inert publisher must never call fetch");
  }) as typeof fetch;
  try {
    const { orders } = harness({ at: BPP_NOW }, new InertFleetManifestPublisher());
    await orders.select(
      reservedOrderRequest("select", { itemId: ITEM, seatIds: ["L2B"] }) as never,
    );
    const confirmed = await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds: ["L2B"],
        manifest: [PASSENGERS[0]],
      }) as never,
    );
    const orderId = (confirmed.order as { id: string }).id;
    const wholeQuote = await orders.cancel(
      reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
    );
    const quoteId = (
      (wholeQuote.tags as Array<{ descriptor: { code: string }; list: Array<{ descriptor: { code: string }; value: string }> }>)
        .find((tag) => tag.descriptor.code === "REFUND_SLAB")!
        .list.find((entry) => entry.descriptor.code === "REFUND_QUOTE_ID")!.value
    );
    await orders.cancel(
      reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(dialled, 0, "an inert publisher must never attempt a network call");
});

test("a confirm still succeeds, and reports the failure, when the fleet simulator does not answer", async () => {
  // Port 1 is a privileged port nothing in this test can be listening on, so
  // the connection is refused rather than merely slow - a booking must not
  // become unconfirmed because a peer service is down.
  //
  // The publisher's own `eventLogger` is where a transport failure is
  // actually reported (`send()` catches it before it ever reaches
  // `ReservedOrderService`), so this test wires it to the same sink
  // `app.ts` wires it to in production, rather than the order service's own
  // defensive `eventLogger` - which exists for a *different* failure, a
  // synchronous one resolving the service or its seat map, and would stay
  // empty here.
  const events: Record<string, unknown>[] = [];
  const publisher = new HttpFleetManifestPublisher({
    url: "http://127.0.0.1:1",
    token: "irrelevant",
    ttlSeconds: 3600,
    timeoutMs: 2_000,
    eventLogger: (fields) => events.push(fields),
  });
  const { orders } = harness({ at: BPP_NOW }, publisher, events);
  await orders.select(
    reservedOrderRequest("select", { itemId: ITEM, seatIds: ["L2B"] }) as never,
  );
  const confirmed = await orders.confirm(
    reservedOrderRequest("confirm", {
      itemId: ITEM,
      seatIds: ["L2B"],
      manifest: [PASSENGERS[0]],
    }) as never,
  );
  // The sale went through regardless of the peer being unreachable.
  assert.equal((confirmed.order as { status: string }).status, "ACTIVE");
  assert.equal(
    events.filter((event) => event.action === "fleet_manifest_publish" && event.outcome === "FAILED").length,
    1,
    "a publish failure must be reported, not silently dropped",
  );
});
