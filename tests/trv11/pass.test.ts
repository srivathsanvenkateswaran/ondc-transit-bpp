import assert from "node:assert/strict";
import { test } from "node:test";

import type { SearchRequest } from "../../src/protocol/types.js";
import { createProtocolValidator } from "../../src/protocol/validate.js";
import { FixtureJourneySource } from "../../src/sources/fixture.js";
import {
  buildPassOnSearch,
  concessionDiscountPaise,
  concessionRatePercent,
  isPassItemId,
  isPassSearch,
  passCatalogueFor,
  passCovers,
  passItemById,
  passValidityWindow,
  signedPaiseToRupees,
  MONTHLY_DAY_MULTIPLE,
  PASS_CATALOGUE,
  PASS_CEILING_MULTIPLE,
  WEEKLY_DAY_MULTIPLE,
} from "../../src/trv11/pass.js";
import { passSearchRequest, testConfig } from "../helpers.js";

/** The brief's table, transcribed. The code derives these; this asserts them. */
const EXPECTED = [
  ["PASS-DAY-ORDINARY_BUS", "bmtc", "DAY", "ORDINARY_BUS", "P1D", 7_500, 25],
  ["PASS-DAY-AC_BUS", "bmtc", "DAY", "AC_BUS", "P1D", 15_000, 25],
  ["PASS-WEEKLY-ORDINARY_BUS", "bmtc", "WEEKLY", "ORDINARY_BUS", "P7D", 37_500, 25],
  ["PASS-WEEKLY-AC_BUS", "bmtc", "WEEKLY", "AC_BUS", "P7D", 75_000, 25],
  ["PASS-MONTHLY-ORDINARY_BUS", "bmtc", "MONTHLY", "ORDINARY_BUS", "P1M", 135_000, 10],
  ["PASS-MONTHLY-AC_BUS", "bmtc", "MONTHLY", "AC_BUS", "P1M", 270_000, 10],
  ["PASS-DAY-METRO", "bmrcl", "DAY", "METRO", "P1D", 22_500, 25],
  ["PASS-WEEKLY-METRO", "bmrcl", "WEEKLY", "METRO", "P7D", 112_500, 25],
  ["PASS-MONTHLY-METRO", "bmrcl", "MONTHLY", "METRO", "P1M", 405_000, 10],
] as const;

test("nine items, spelled and priced exactly as the contract states", () => {
  assert.equal(PASS_CATALOGUE.length, 9);
  PASS_CATALOGUE.forEach((item, index) => {
    const [id, operator, window, scope, duration, pricePaise, senior] =
      EXPECTED[index];
    assert.deepEqual(
      {
        id: item.id,
        operator: item.operator,
        window: item.window,
        scope: item.scope,
        duration: item.duration,
        pricePaise: item.pricePaise,
        senior: item.seniorDiscountPercent,
        student: item.studentDiscountPercent,
      },
      {
        id,
        operator,
        window,
        scope,
        duration,
        pricePaise,
        senior,
        student: 33,
      },
    );
  });
});

test("no combined bus-and-metro item exists on anybody's catalogue", () => {
  // Neither operator sells the other's network. A buyer app composes that
  // product from two orders under one checkout id of its own.
  assert.equal(
    PASS_CATALOGUE.some((item) => /BUS_AND_METRO|BUS_METRO|COMBINED/.test(item.id)),
    false,
  );
  assert.equal(passCatalogueFor("bmtc").length, 6);
  assert.equal(passCatalogueFor("bmrcl").length, 3);
});

test("prices are the named multiples of the scope's ceiling single fare", () => {
  assert.equal(PASS_CEILING_MULTIPLE, 2.5);
  assert.equal(WEEKLY_DAY_MULTIPLE, 5);
  assert.equal(MONTHLY_DAY_MULTIPLE, 18);
  for (const scope of ["ORDINARY_BUS", "AC_BUS", "METRO"] as const) {
    const day = PASS_CATALOGUE.find(
      (item) => item.window === "DAY" && item.scope === scope,
    )!;
    const weekly = PASS_CATALOGUE.find(
      (item) => item.window === "WEEKLY" && item.scope === scope,
    )!;
    const monthly = PASS_CATALOGUE.find(
      (item) => item.window === "MONTHLY" && item.scope === scope,
    )!;
    assert.equal(weekly.pricePaise, day.pricePaise * WEEKLY_DAY_MULTIPLE);
    assert.equal(monthly.pricePaise, day.pricePaise * MONTHLY_DAY_MULTIPLE);
  }
});

test("item names read the way the contract prints them", () => {
  assert.equal(
    passItemById("bmtc", "PASS-MONTHLY-AC_BUS")?.name,
    "AC bus monthly pass",
  );
  assert.equal(
    passItemById("bmtc", "PASS-DAY-ORDINARY_BUS")?.name,
    "Ordinary bus day pass",
  );
  assert.equal(passItemById("bmrcl", "PASS-WEEKLY-METRO")?.name, "Metro weekly pass");
});

test("an operator sells only its own items", () => {
  assert.ok(passItemById("bmtc", "PASS-DAY-AC_BUS"));
  assert.equal(passItemById("bmrcl", "PASS-DAY-AC_BUS"), undefined);
  assert.ok(passItemById("bmrcl", "PASS-DAY-METRO"));
  assert.equal(passItemById("bmtc", "PASS-DAY-METRO"), undefined);
  assert.equal(isPassItemId("PASS-DAY-AC_BUS"), true);
  assert.equal(isPassItemId("I1"), false);
  assert.equal(isPassItemId("PASS-DAY-BUS_AND_METRO"), false);
});

test("a higher class is honoured on a lower service, never the reverse", () => {
  assert.equal(passCovers("AC_BUS", "AC_BUS"), true);
  assert.equal(passCovers("AC_BUS", "ORDINARY_BUS"), true);
  assert.equal(passCovers("ORDINARY_BUS", "ORDINARY_BUS"), true);
  assert.equal(passCovers("ORDINARY_BUS", "AC_BUS"), false);
  assert.equal(passCovers("METRO", "METRO"), true);
  assert.equal(passCovers("METRO", "AC_BUS"), false);
  assert.equal(passCovers("METRO", "ORDINARY_BUS"), false);
  assert.equal(passCovers("AC_BUS", "METRO"), false);
  assert.equal(passCovers("ORDINARY_BUS", "METRO"), false);
});

test("every published rate divides exactly, so both sides agree without rounding", () => {
  for (const item of PASS_CATALOGUE) {
    for (const concession of ["SENIOR", "STUDENT"] as const) {
      const percent = concessionRatePercent(item, concession);
      const exact = (item.pricePaise * percent) / 100;
      assert.equal(Number.isInteger(exact), true, `${item.id}/${concession}`);
      assert.equal(concessionDiscountPaise(item.pricePaise, percent), exact);
    }
  }
});

test("the worked example in the contract computes to the rupee", () => {
  const item = passItemById("bmtc", "PASS-MONTHLY-AC_BUS")!;
  const discount = concessionDiscountPaise(
    item.pricePaise,
    concessionRatePercent(item, "STUDENT"),
  );
  assert.equal(item.pricePaise, 270_000);
  assert.equal(discount, 89_100);
  assert.equal(item.pricePaise - discount, 180_900);
  assert.equal(signedPaiseToRupees(-discount), "-891");
});

test("a negative rupee string keeps two decimal places when it needs them", () => {
  assert.equal(signedPaiseToRupees(0), "0");
  assert.equal(signedPaiseToRupees(-891_00), "-891");
  assert.equal(signedPaiseToRupees(-2_475), "-24.75");
});

test("a pass window is the calendar day in Asia/Kolkata, not a rolling day", () => {
  // 22:30 UTC on 2 September is 04:00 IST on 3 September, so the window is
  // the third, not the second.
  const window = passValidityWindow(new Date("2026-09-02T22:30:00.000Z"), "DAY");
  assert.equal(window.validFrom, "2026-09-03T00:00:00.000+05:30");
  assert.equal(window.validTo, "2026-09-04T00:00:00.000+05:30");
  assert.equal(window.validToMs - window.validFromMs, 24 * 60 * 60 * 1000);
});

test("a pass bought late in the IST evening still starts that same day", () => {
  // 23:00 IST on 2 September is 17:30 UTC the same day.
  const window = passValidityWindow(new Date("2026-09-02T17:30:00.000Z"), "DAY");
  assert.equal(window.validFrom, "2026-09-02T00:00:00.000+05:30");
  assert.equal(window.validTo, "2026-09-03T00:00:00.000+05:30");
});

test("weekly and monthly windows advance in calendar terms", () => {
  const weekly = passValidityWindow(new Date("2026-09-03T06:00:00.000Z"), "WEEKLY");
  assert.equal(weekly.validFrom, "2026-09-03T00:00:00.000+05:30");
  assert.equal(weekly.validTo, "2026-09-10T00:00:00.000+05:30");

  const monthly = passValidityWindow(new Date("2026-09-03T06:00:00.000Z"), "MONTHLY");
  assert.equal(monthly.validTo, "2026-10-03T00:00:00.000+05:30");
});

test("a monthly window that lands on a day the next month lacks covers that month", () => {
  // 31 January has no 31 February. The pass covers the whole of February
  // rather than being cut short inside it or spilling past it.
  const january = passValidityWindow(new Date("2026-01-31T06:00:00.000Z"), "MONTHLY");
  assert.equal(january.validFrom, "2026-01-31T00:00:00.000+05:30");
  assert.equal(january.validTo, "2026-03-01T00:00:00.000+05:30");

  // A leap February does have a 29th.
  const leap = passValidityWindow(new Date("2028-01-29T06:00:00.000Z"), "MONTHLY");
  assert.equal(leap.validTo, "2028-02-29T00:00:00.000+05:30");
});

test("a monthly window crosses a year boundary", () => {
  const december = passValidityWindow(new Date("2026-12-15T06:00:00.000Z"), "MONTHLY");
  assert.equal(december.validFrom, "2026-12-15T00:00:00.000+05:30");
  assert.equal(december.validTo, "2027-01-15T00:00:00.000+05:30");
});

test("a PASS-category intent is recognised, a stop-pair intent is not", () => {
  assert.equal(isPassSearch(passSearchRequest() as unknown as SearchRequest), true);
  assert.equal(
    isPassSearch({
      context: {},
      message: { intent: { fulfillment: { stops: [] } } },
    } as unknown as SearchRequest),
    false,
  );
  assert.equal(
    isPassSearch({
      context: {},
      message: { intent: { category: { descriptor: { code: "TICKET" } } } },
    } as unknown as SearchRequest),
    false,
  );
});

for (const [operatorKey, expectedIds] of [
  [
    "bmtc",
    [
      "PASS-DAY-ORDINARY_BUS",
      "PASS-DAY-AC_BUS",
      "PASS-WEEKLY-ORDINARY_BUS",
      "PASS-WEEKLY-AC_BUS",
      "PASS-MONTHLY-ORDINARY_BUS",
      "PASS-MONTHLY-AC_BUS",
    ],
  ],
  ["bmrcl", ["PASS-DAY-METRO", "PASS-WEEKLY-METRO", "PASS-MONTHLY-METRO"]],
] as const) {
  test(`${operatorKey} answers a pass search with a valid TRV11 catalogue`, async () => {
    const config = testConfig();
    const source = await FixtureJourneySource.load(config.fixtureRoot, operatorKey);
    const response = buildPassOnSearch(
      passSearchRequest() as unknown as SearchRequest,
      source.operator,
      operatorKey,
      config.operators[operatorKey],
      {
        publicBaseUrl: config.publicBaseUrl,
        contextTtl: config.contextTtl,
        now: () => new Date("2026-09-03T05:00:00.000Z"),
      },
    );
    const validator = createProtocolValidator(config.schemaRoot);
    assert.deepEqual(validator.onSearch(response), { valid: true, errors: [] });

    const provider = response.message.catalog.providers[0] as any;
    assert.deepEqual(
      provider.items.map((item: any) => item.id),
      expectedIds,
    );
    assert.deepEqual(provider.categories, [
      { id: "C1", descriptor: { name: "Ticket", code: "TICKET" } },
      { id: "C2", descriptor: { name: "Pass", code: "PASS" } },
    ]);
    provider.items.forEach((item: any) => {
      assert.deepEqual(item.category_ids, ["C2"]);
      assert.equal(item.descriptor.code, "PASS");
      assert.equal(item.price.currency, "INR");
    });
    // A pass fulfillment carries no stops, here or anywhere else.
    provider.fulfillments.forEach((fulfillment: any) => {
      assert.equal(fulfillment.type, "PASS");
      assert.equal("stops" in fulfillment, false);
      assert.equal("vehicle" in fulfillment, false);
    });
  });
}

test("the on_search item shape matches the pinned contract byte for byte", () => {
  const config = testConfig();
  const response = buildPassOnSearch(
    passSearchRequest() as unknown as SearchRequest,
    {
      id: "P1",
      name: "Bengaluru Metropolitan Transport Corporation",
      vehicleCategory: "BUS",
      serviceWindow: { startHHMM: "05:00", endHHMM: "23:00" },
    },
    "bmtc",
    config.operators.bmtc,
    {
      publicBaseUrl: config.publicBaseUrl,
      contextTtl: config.contextTtl,
      now: () => new Date("2026-09-03T05:00:00.000Z"),
    },
  );
  const provider = response.message.catalog.providers[0] as any;
  const item = provider.items.find(
    (candidate: any) => candidate.id === "PASS-MONTHLY-AC_BUS",
  );
  assert.deepEqual(item, {
    id: "PASS-MONTHLY-AC_BUS",
    category_ids: ["C2"],
    descriptor: { name: "AC bus monthly pass", code: "PASS" },
    price: { currency: "INR", value: "2700" },
    quantity: { maximum: { count: 6 }, minimum: { count: 1 } },
    fulfillment_ids: ["F-PASS-MONTHLY-AC_BUS"],
    time: {
      label: "Validity",
      duration: "P1M",
      timestamp: "2026-09-03T05:00:00.000Z",
    },
    tags: [
      {
        descriptor: { code: "PASS_INFO" },
        list: [
          { descriptor: { code: "WINDOW" }, value: "MONTHLY" },
          { descriptor: { code: "SCOPE" }, value: "AC_BUS" },
        ],
      },
      {
        descriptor: { code: "CONCESSION_INFO" },
        display: false,
        list: [
          { descriptor: { code: "SENIOR_DISCOUNT_PERCENT" }, value: "10" },
          { descriptor: { code: "STUDENT_DISCOUNT_PERCENT" }, value: "33" },
        ],
      },
      {
        descriptor: { code: "SYNTHETIC_PASS_INFO" },
        display: true,
        list: [
          {
            descriptor: { code: "NOTICE" },
            value:
              "Modelled pass. The rules and the price are set by this specimen provider, not by BMTC or BMRCL.",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    provider.fulfillments.find(
      (candidate: any) => candidate.id === "F-PASS-MONTHLY-AC_BUS",
    ),
    {
      id: "F-PASS-MONTHLY-AC_BUS",
      type: "PASS",
      tags: [
        {
          descriptor: { code: "PASS_INFO" },
          list: [
            { descriptor: { code: "WINDOW" }, value: "MONTHLY" },
            { descriptor: { code: "SCOPE" }, value: "AC_BUS" },
          ],
        },
      ],
    },
  );
});

test("every rendered pass price carries the synthetic mark", () => {
  const config = testConfig();
  for (const operatorKey of ["bmtc", "bmrcl"] as const) {
    const response = buildPassOnSearch(
      passSearchRequest() as unknown as SearchRequest,
      {
        id: "P1",
        name: "Test Operator",
        vehicleCategory: operatorKey === "bmtc" ? "BUS" : "METRO",
        serviceWindow: { startHHMM: "05:00", endHHMM: "23:00" },
      },
      operatorKey,
      config.operators[operatorKey],
      { publicBaseUrl: config.publicBaseUrl, contextTtl: config.contextTtl },
    );
    const provider = response.message.catalog.providers[0] as any;
    provider.items.forEach((item: any) => {
      const mark = item.tags.find(
        (tag: any) => tag.descriptor.code === "SYNTHETIC_PASS_INFO",
      );
      assert.ok(mark, `${item.id} carries no synthetic mark`);
      assert.equal(mark.display, true);
      assert.match(mark.list[0].value, /not by BMTC or BMRCL/);
    });
  }
});
