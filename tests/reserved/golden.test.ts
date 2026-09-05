import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createReservedValidator } from "../../src/reserved/schema.js";
import { runGoldenLifecycle } from "./lifecycle.js";

/**
 * Nine payloads, checked into the repository, regenerated on every run and
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

test("a domain refusal carries an error and no order at all", () => {
  // This stack's equivalent of a negative acknowledgement for a domain error.
  // What rides beside it is the current seat map, so a client refused a berth
  // can re-render without a second round trip, and it is not an order, because
  // a refused select produced none.
  const refusal = produced.on_select_unavailable as any;
  assert.equal(refusal.error.code, "SEAT-UNAVAILABLE");
  assert.equal(refusal.message.order, undefined);
  assert.equal(refusal.message.tags[0].descriptor.code, "SEAT_MAP");
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
