/**
 * FNV-1a plus xoshiro128**, keyed so every draw is independently reproducible.
 *
 * Ported unchanged from the sibling fleet simulator's `src/sim/rand.ts`, which
 * this repository does not depend on and cannot import from. Keeping the
 * construction byte-identical rather than writing a second one means the two
 * simulations answer the same way for the same key, which is what makes a
 * cross-project golden file possible at all. The two copies are the cost of
 * not taking a dependency between two projects that must each run alone.
 *
 * Nothing here reads a clock or an unseeded source. Every value is a pure
 * function of its four inputs.
 */

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function splitMix32(value: number): number {
  let mixed = (value + 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function rotateLeft(value: number, count: number): number {
  return ((value << count) | (value >>> (32 - count))) >>> 0;
}

/** A value in [0, 1), keyed by a seed, a subject, a purpose and a bucket. */
export function rand(
  seed: number,
  subject: string,
  purpose: string,
  bucket: string | number,
): number {
  let state = fnv1a(`${seed}|${subject}|${purpose}|${bucket}`);
  const values = new Uint32Array(4);
  for (let index = 0; index < values.length; index += 1) {
    state = splitMix32(state);
    values[index] = state;
  }
  if (values.every((value) => value === 0)) values[0] = 1;
  const result = rotateLeft(Math.imul(values[1] ?? 0, 5), 7);
  return (Math.imul(result, 9) >>> 0) / 0x1_0000_0000;
}
