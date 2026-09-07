import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openReservedDatabase } from "../../src/reserved/db.js";
import { FixtureReservedSource } from "../../src/reserved/fixture.js";
import { ReservedOrderService } from "../../src/reserved/order.js";
import { ReservedStore } from "../../src/reserved/store.js";
import {
  reservedCancelRequest,
  reservedOrderRequest,
  reservedSearchRequest,
  reservedStatusRequest,
} from "../helpers.js";

/**
 * A full search-select-init-confirm-status-cancel run on Bengaluru-Mangaluru
 * (KA-BNG-MNG), the second corridor this provider can sell end to end after
 * Bengaluru-Hampi. "0700BNGMNG" is a real, non-ambiguous KSRTC service
 * number, Airavat Club Class, generated from Tatak's own corridor data by
 * scripts/generate-ksrtc-fixtures.ts - see that script and
 * fixtures/ksrtc/fares/FT-BNGMNG.json for provenance.
 */

const fixtureRoot = fileURLToPath(new URL("../../fixtures", import.meta.url));
const migrationRoot = fileURLToPath(new URL("../../migrations/reserved", import.meta.url));

const TRAVEL_DATE = "2026-09-30";
const SERVICE_ID = "0700BNGMNG";
const ITEM = `RSV-${SERVICE_ID}-${TRAVEL_DATE}-AIRAVAT_CLUB_CLASS`;

async function makeOrders() {
  const source = await FixtureReservedSource.load(fixtureRoot, "ksrtc");
  const store = new ReservedStore(openReservedDatabase({ url: ":memory:", migrationRoot }));
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
      now: () => new Date(Date.parse("2026-09-20T10:00:00.000Z")),
    },
  );
  return { orders, store };
}

test("Bengaluru-Mangaluru: search finds the real Airavat Club Class working", async () => {
  const { orders, store } = await makeOrders();
  try {
    const message = await orders.search(
      reservedSearchRequest({
        fromTownCode: "BLR",
        toTownCode: "MNG",
        travelDate: TRAVEL_DATE,
      }) as never,
    );
    const items = (message.catalog as { providers: Array<{ items: Array<{ id: string }> }> })
      .providers[0].items;
    assert.ok(items.some((item) => item.id === ITEM), `expected ${ITEM} among ${JSON.stringify(items.map((i) => i.id))}`);
  } finally {
    store.close();
  }
});

test("Bengaluru-Mangaluru: select, init, confirm, status and cancel all succeed", async () => {
  const { orders, store } = await makeOrders();
  try {
    const seatIds = ["13A", "13B"];
    const manifest = [
      { seatId: "13A", name: "A Passenger", age: 30, gender: "male" },
      { seatId: "13B", name: "B Passenger", age: 28, gender: "female" },
    ];

    const selected = await orders.select(
      reservedOrderRequest("select", {
        itemId: ITEM,
        seatIds,
        fromBoardingPointId: "BP-BLR-MAJESTIC",
        toBoardingPointId: "BP-MNG-MANGALURU",
      }) as never,
    );
    assert.ok(selected.order, "select did not return an order quote");

    const inited = await orders.init(
      reservedOrderRequest("init", {
        itemId: ITEM,
        seatIds,
        manifest,
        fromBoardingPointId: "BP-BLR-MAJESTIC",
        toBoardingPointId: "BP-MNG-MANGALURU",
      }) as never,
    );
    assert.ok(inited.order, "init did not return an order");

    const confirmed = await orders.confirm(
      reservedOrderRequest("confirm", {
        itemId: ITEM,
        seatIds,
        manifest,
        fromBoardingPointId: "BP-BLR-MAJESTIC",
        toBoardingPointId: "BP-MNG-MANGALURU",
      }) as never,
    );
    const orderId = (confirmed.order as { id: string }).id;
    assert.ok(orderId, "confirm did not return an order id");

    const status = orders.status(reservedStatusRequest({ orderId }) as never);
    assert.equal((status.order as { id: string }).id, orderId);

    const quoted = await orders.cancel(
      reservedCancelRequest({ orderId, code: "SOFT_CANCEL" }) as never,
    );
    const quoteId = (
      (quoted.tags as Array<{
        descriptor: { code: string };
        list: Array<{ descriptor: { code: string }; value: string }>;
      }>)[0].list.find((entry) => entry.descriptor.code === "REFUND_QUOTE_ID")!
    ).value;
    const cancelled = await orders.cancel(
      reservedCancelRequest({ orderId, code: "CONFIRM_CANCEL", quoteId }) as never,
    );
    assert.ok(cancelled.order, "cancel did not return an order");
  } finally {
    store.close();
  }
});
