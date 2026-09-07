import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The three module-boundary guards of `docs/reserved-intercity.md` section 2.
 *
 * They are greps rather than review discipline because the mistake they catch
 * is a copy-paste, and a copy-paste is exactly what a reviewer's eye slides
 * over. Each direction is a different failure:
 *
 *   - a reserved payload acquiring a namespace claim it is not entitled to,
 *     by being modelled on the path next door;
 *   - a locally invented vocabulary leaking into payloads that do claim
 *     conformance to a published specification;
 *   - the two schema trees merging through a `$ref` nobody edited a source
 *     file to create.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(path) : [path];
    }),
  );
  return nested.flat();
}

async function offendingLines(
  directory: string,
  tokens: readonly string[],
): Promise<string[]> {
  const files = await filesUnder(join(repoRoot, directory));
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, index) => {
      const token = tokens.find((candidate) => line.includes(candidate));
      if (token) {
        hits.push(`${file.slice(repoRoot.length)}:${index + 1} contains ${token}`);
      }
    });
  }
  return hits;
}

test("both guarded directories exist and hold something to guard", async () => {
  // Without this, an empty or renamed directory would make the two greps
  // below pass by having nothing to read, which is the one way a grep test
  // can be worse than no test.
  assert.ok((await filesUnder(join(repoRoot, "src/reserved"))).length >= 5);
  assert.ok((await filesUnder(join(repoRoot, "src/trv11"))).length >= 5);
});

test("the reserved module claims no namespace it is not entitled to", async () => {
  assert.deepEqual(await offendingLines("src/reserved", ["ONDC", "TRV11"]), []);
});

test("the published-conformance module carries none of the local vocabulary", async () => {
  assert.deepEqual(
    await offendingLines("src/trv11", [
      "TRANSIT.LOCALHOST",
      "RESERVED",
      "INTERCITY",
    ]),
    [],
  );
});

test("the reserved schema tree refs nothing in the published-conformance tree", async () => {
  // `common.json`'s shared shapes are genuinely tempting to reuse - a
  // descriptor, a price and a tag are the same shapes in both trees - and
  // reusing them would mean a change made for one domain silently altering
  // what the other accepts. The duplication is the point.
  const files = await filesUnder(join(repoRoot, "schemas/transit_local_intercity"));
  assert.ok(files.length > 0, "the reserved schema tree exists");
  for (const file of files) {
    const document = JSON.parse(await readFile(file, "utf8")) as unknown;
    const refs: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node === null || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") refs.push(value);
        walk(value);
      }
    };
    walk(document);
    const foreign = refs.filter((ref) => !ref.startsWith("#") && !ref.includes("/transit-local-intercity/"));
    assert.deepEqual(
      foreign,
      [],
      `${file.slice(repoRoot.length)} refs outside its own tree`,
    );
  }
});
