import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createReservedValidator } from "../../src/reserved/schema.js";
import { runGoldenLifecycle } from "./lifecycle.js";

/**
 * Twelve payloads, checked into the repository, regenerated on every run and
 * compared byte for byte.
 *
 * They are the substitute for a contract test this category cannot have, and
 * they are a weaker one: there are no published examples to assert a shared
 * key structure against, because this domain is locally owned and claims
 * conformance to nothing. What they do catch is drift from the document that
 * specified them, which is worth having and is not the same thing.
 *
 * They also carry the settlement guard. Asserting the absence of an
 * attribution against one hand-picked example would prove very little; every
 * payload the lifecycle produces is checked instead.
 */

const goldenRoot = fileURLToPath(
  new URL("../fixtures/reserved-golden", import.meta.url),
);
const schemaRoot = fileURLToPath(
  new URL("../../schemas/transit_local_intercity/0.1.0", import.meta.url),
);

const validator = createReservedValidator(schemaRoot);
const produced = await runGoldenLifecycle();

function checkedIn(name: string): unknown {
  return JSON.parse(readFileSync(join(goldenRoot, `${name}.json`), "utf8"));
}

test("every checked-in payload is one the lifecycle still produces", () => {
  const onDisk = readdirSync(goldenRoot)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
  assert.deepEqual(onDisk, Object.keys(produced).sort());
  onDisk.forEach((name) => {
    assert.deepEqual(
      produced[name],
      checkedIn(name),
      `${name} has drifted from the payload checked into this repository`,
    );
  });
});

test("every generated payload validates against its own schema", () => {
  const validate: Record<string, (value: unknown) => { valid: boolean; errors: unknown[] }> = {
    on_search: validator.onSearch,
    on_select_browse: validator.onSelect,
    on_select_seats: validator.onSelect,
    on_select_unavailable: validator.onSelect,
    on_init: validator.onInit,
    on_confirm: validator.onConfirm,
    on_status: validator.onStatus,
    on_cancel_quote: validator.onCancel,
    on_cancel_committed: validator.onCancel,
    on_cancel_whole_quote: validator.onCancel,
    on_cancel_whole_committed: validator.onCancel,
    on_status_cancelled: validator.onStatus,
  };
  Object.entries(produced).forEach(([name, payload]) => {
    const result = validate[name](payload);
    assert.equal(
      result.valid,
      true,
      `${name} failed validation: ${JSON.stringify(result.errors)}`,
    );
  });
});

test("no payload this provider sends carries a tag with nothing in it", () => {
  // The generalisation of the whole-booking cancellation bug. A tag with an
  // empty list carries no information, `tag.list` is `minItems: 1` in this
  // domain's own schema, and a callback that fails its own schema is not sent
  // at all - so an empty list is not a cosmetic flaw, it is a client waiting
  // out its timeout against silence. The schema catches it once the payload
  // exists; this catches it by walking every payload, including the ones a
  // future action adds, and it names the tag rather than an instance path.
  const empty: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const code = (record.descriptor as { code?: string } | undefined)?.code;
    if (code && Array.isArray(record.list) && record.list.length === 0) {
      empty.push(code);
    }
    Object.values(record).forEach(walk);
  };
  walk(produced);
  assert.deepEqual(empty, []);
});

test("a cancelled booking names the seats it released rather than emptying a list", () => {
  // What a cancelled booking's tags are, and why. `SEATS` is what the booking
  // still holds, so a whole cancellation publishes none; `CANCELLED_SEATS` is
  // what it let go, so a whole cancellation publishes all of them. Emptying
  // `SEATS` in place was the shape that could not be sent at all.
  const whole = produced.on_cancel_whole_committed as any;
  const order = whole.message.order;
  const codes = order.tags.map((tag: any) => tag.descriptor.code);
  assert.equal(order.status, "CANCELLED");
  assert.equal(codes.includes("SEATS"), false);
  assert.deepEqual(
    order.tags
      .find((tag: any) => tag.descriptor.code === "CANCELLED_SEATS")
      .list.map((entry: any) => entry.value),
    ["U3A", "U3B"],
  );
  // A manifest of nobody is no manifest, and the fulfillment keeps everything
  // that is still true of the booking.
  assert.deepEqual(
    order.fulfillments[0].tags.map((tag: any) => tag.descriptor.code),
    ["SEAT_MAP_REF", "BOOKING_REF", "VEHICLE_LOOKUP", "SPECIMEN_INFO"],
  );

  // A partial cancellation says both halves, which it previously did not: the
  // seats it took used to simply vanish from the order.
  const partial = (produced.on_cancel_committed as any).message.order;
  assert.equal(partial.status, "ACTIVE");
  assert.deepEqual(
    partial.tags
      .find((tag: any) => tag.descriptor.code === "SEATS")
      .list.map((entry: any) => entry.value),
    ["U3A"],
  );
  assert.deepEqual(
    partial.tags
      .find((tag: any) => tag.descriptor.code === "CANCELLED_SEATS")
      .list.map((entry: any) => entry.value),
    ["U3B"],
  );
});

test("a status read of a cancelled booking is the shape the cancel answered with", () => {
  // The rewritten order is what gets stored, so a shape `on_cancel` could not
  // publish is a shape `on_status` could not publish either, for the life of
  // the booking.
  const cancelled = (produced.on_status_cancelled as any).message.order;
  assert.equal(cancelled.status, "CANCELLED");
  assert.deepEqual(
    cancelled.tags.map((tag: any) => tag.descriptor.code),
    ["SPECIMEN_INFO", "SEAT_MAP", "SEAT_MAP_LAYOUT", "CANCELLED_SEATS"],
  );
});

test("the run says which stops can be boarded and which alighted at", () => {
  // `stop.type` is the positional axis and cannot carry the role. Flattening
  // the two lists into one typed sequence made the three Bengaluru pickups and
  // the Hosapete dropping point indistinguishable, so a buyer app offered
  // Hosapete as a pickup six hundred kilometres from the rider and could never
  // offer it as a dropping point.
  const stops = (produced.on_search as any).message.catalog.providers[0]
    .fulfillments[0].stops;
  const roleOf = (stop: any) =>
    stop.tags
      .find((tag: any) => tag.descriptor.code === "STOP_ROLE")
      .list.map((entry: any) => entry.value);
  assert.deepEqual(
    stops.map((stop: any) => [stop.location.descriptor.code, stop.type, roleOf(stop)]),
    [
      ["BP-BLR-MAJESTIC", "START", ["BOARDING"]],
      ["BP-BLR-MADIWALA", "INTERMEDIATE_STOP", ["BOARDING"]],
      ["BP-BLR-ELECTRONIC-CITY", "INTERMEDIATE_STOP", ["BOARDING"]],
      ["BP-HPT-HOSAPETE", "INTERMEDIATE_STOP", ["DROPPING"]],
      ["BP-HMP-HAMPI", "END", ["DROPPING"]],
    ],
  );
});

test("every seat state is published with the geometry it is a state of", () => {
  // A client that receives states and no layout has two ways to draw a coach:
  // reconstruct it from this document's prose, or draw a grid that is not this
  // coach. Both are unpublished contracts.
  const order = (produced.on_select_seats as any).message.order;
  const states = order.tags.find((tag: any) => tag.descriptor.code === "SEAT_MAP");
  const layout = order.tags.find(
    (tag: any) => tag.descriptor.code === "SEAT_MAP_LAYOUT",
  );
  assert.ok(states && layout, "states and layout travel together");
  const stated = states.list
    .filter((entry: any) => entry.descriptor.code !== "SEAT_MAP_ID")
    .map((entry: any) => entry.descriptor.code);
  const drawn = layout.list
    .filter((entry: any) => entry.descriptor.code === "SEAT_ID")
    .map((entry: any) => entry.value);
  assert.deepEqual(drawn, stated);
  assert.equal(drawn.length, 30);
});

test("every published instant carries the offset this category anchors to", () => {
  // India has one fixed offset and observes no daylight saving, so `+05:30` is
  // correct rather than a simplification, and a payload carrying two offsets
  // makes a client decide whether that means something. `EXPIRES_AT` and
  // `QUOTE_EXPIRES_AT` were the two that said `Z`.
  //
  // The envelope's own `context.timestamp` is out of scope and stays `Z`. That
  // field belongs to the protocol rather than to this category, the two
  // categories next door emit it the same way, and the document's own section
  // 14.1 example prints it that way. Everything inside `message` is this
  // category's to decide.
  const instants: Array<[string, string]> = [];
  const walk = (name: string, node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(name, item));
      return;
    }
    if (node === null || typeof node !== "object") return;
    Object.entries(node as Record<string, unknown>).forEach(([key, value]) => {
      if (
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
      ) {
        instants.push([name, value]);
      }
      walk(name, value);
    });
  };
  Object.entries(produced).forEach(([name, payload]) =>
    walk(name, (payload as { message?: unknown }).message),
  );
  assert.ok(instants.length > 0, "no instant was published at all");
  assert.deepEqual(
    instants.filter(([, value]) => !value.endsWith("+05:30")),
    [],
  );
});

test("a fare line carries a rider label beside the code a client keys off", () => {
  // A screen rendering `title` used to print `BASE_FARE`. Both fields travel
  // now, and the enumeration lives on the one that is not prose.
  const quote = (produced.on_confirm as any).message.order.quote;
  assert.deepEqual(
    quote.breakup.map((line: any) => [line.code, line.title]),
    [
      ["BASE_FARE", "Base fare"],
      ["RESERVATION_FEE", "Reservation fee"],
      ["TOLL", "Toll"],
    ],
  );
  const refund = (produced.on_cancel_quote as any).message.refund;
  assert.deepEqual(
    refund.breakup.map((line: any) => [line.code, line.title]),
    [
      ["BASE_FARE", "Base fare"],
      ["SLAB_DEDUCTION", "Cancellation deduction"],
      ["RESERVATION_FEE", "Reservation fee"],
      ["TOLL_REFUND", "Toll refund"],
    ],
  );
  // No line puts a wire constant where a rider reads.
  Object.entries(produced).forEach(([name, payload]) => {
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (typeof record.title === "string" && record.price) {
        assert.equal(
          /^[A-Z][A-Z0-9_]*$/.test(record.title),
          false,
          `${name} renders the code ${record.title} where a rider reads`,
        );
      }
      Object.values(record).forEach(walk);
    };
    walk(payload);
  });
});

test("a refusal names the seats it is about as data, not only in a sentence", () => {
  const refusal = produced.on_select_unavailable as any;
  const named = refusal.message.tags.find(
    (tag: any) => tag.descriptor.code === "UNAVAILABLE_SEATS",
  );
  assert.deepEqual(named.list.map((entry: any) => entry.value), ["L1A"]);
  // And the error object stays a code and a sentence, with no third field for
  // a client to wait on.
  assert.deepEqual(Object.keys(refusal.error).sort(), ["code", "message"]);
});

test("a domain refusal carries an error and no order at all", () => {
  // This stack's equivalent of a negative acknowledgement for a domain error.
  // What rides beside it is the current seat map, so a client refused a berth
  // can re-render without a second round trip, and it is not an order, because
  // a refused select produced none.
  const refusal = produced.on_select_unavailable as any;
  assert.equal(refusal.error.code, "SEAT-UNAVAILABLE");
  assert.equal(refusal.message.order, undefined);
  assert.ok(
    refusal.message.tags.some((tag: any) => tag.descriptor.code === "SEAT_MAP"),
  );
});

test("no settlement fact appears in any payload this provider sends", () => {
  // The ruling is total: an unattributed sale is exactly as invisible to a
  // rider as an attributed one. The honest null is an accounting state, not a
  // rendering state, and it must never surface as a gap on a screen the way a
  // missing fare or a missing coordinate correctly does elsewhere.
  Object.entries(produced).forEach(([name, payload]) => {
    const text = JSON.stringify(payload);
    ["settlement_corporation", "settlement_basis", "SETTLEMENT_CORPORATION"].forEach(
      (token) => {
        assert.equal(text.includes(token), false, `${name} carries ${token}`);
      },
    );
  });
});

test("the retired corporation fields have not come back under the tag they left", () => {
  // A separate assertion from the one above even though the broad text check
  // would probably also catch it, because a single test that catches two
  // different mistakes gives one failure message for both, and whoever reads
  // it should be told which promise broke.
  const disclosures: Array<{ descriptor: { code: string }; list: Array<{ descriptor: { code: string } }> }> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (
      (record.descriptor as { code?: string } | undefined)?.code ===
        "OPERATOR_DISCLOSURE" &&
      Array.isArray(record.list)
    ) {
      disclosures.push(record as never);
    }
    Object.values(record).forEach(walk);
  };
  walk(produced);
  assert.ok(disclosures.length > 0, "no operator disclosure was published at all");
  disclosures.forEach((disclosure) => {
    assert.deepEqual(
      disclosure.list.map((entry) => entry.descriptor.code),
      ["BRAND"],
    );
  });
});

test("nothing in a reserved payload mints a credential", () => {
  // No image, no rotating secret, no token. The boarding check on an intercity
  // coach is a conductor with a manifest rather than a gate with a reader.
  Object.entries(produced).forEach(([name, payload]) => {
    const text = JSON.stringify(payload);
    ["authorization", "TOTP", "\"QR\""].forEach((token) => {
      assert.equal(text.includes(token), false, `${name} carries ${token}`);
    });
  });
});
