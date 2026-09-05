/**
 * Rewrites the golden payloads in `tests/fixtures/reserved-golden/`.
 *
 * Run it when a payload legitimately changes, read the diff, and commit it
 * with the change that caused it. Not a `.test.ts` file, so the runner does
 * not pick it up as a suite, and deliberately separate from the test that
 * compares: a golden file that rewrote itself whenever it disagreed with the
 * code would assert nothing at all.
 *
 *   npx tsx tests/reserved/golden-write.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runGoldenLifecycle } from "./lifecycle.js";

const root = fileURLToPath(
  new URL("../fixtures/reserved-golden", import.meta.url),
);
mkdirSync(root, { recursive: true });
const payloads = await runGoldenLifecycle();
for (const [name, payload] of Object.entries(payloads)) {
  writeFileSync(join(root, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${name}\n`);
}
