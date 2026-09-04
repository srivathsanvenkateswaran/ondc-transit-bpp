import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeBase32,
  encodeBase32,
  mintPassSecret,
  totpCode,
  verifyTotpCode,
  TOTP_PARAMETERS,
  TOTP_SECRET_BYTES,
} from "../../src/trv11/totp.js";

test("base32 matches RFC 4648 section 10 test vectors, unpadded", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(encodeBase32(Buffer.from(plain, "utf8")), encoded);
    assert.equal(decodeBase32(encoded).toString("utf8"), plain);
  }
});

test("base32 decoding tolerates padding and round-trips arbitrary bytes", () => {
  assert.equal(decodeBase32("MZXW6YTBOI======").toString("utf8"), "foobar");
  const bytes = Buffer.from([0, 1, 127, 128, 255, 42, 17]);
  assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
});

test("the token the brief prints is a real, decodable base32 string", () => {
  // `JBSWY3DPEHPK3PXP` from ondc-02-sell-passes.md, decoding to
  // "Hello!" followed by 0xDEADBEEF.
  assert.equal(
    decodeBase32("JBSWY3DPEHPK3PXP").toString("hex"),
    "48656c6c6f21deadbeef",
  );
});

test("a non-base32 secret is refused without echoing the offending value", () => {
  assert.throws(
    () => decodeBase32("NOT-BASE32-secret-1"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /RFC 4648 alphabet/);
      assert.doesNotMatch(error.message, /secret-1/);
      return true;
    },
  );
});

test("TOTP reproduces RFC 6238 appendix B SHA1 test vectors", () => {
  // RFC 6238's shared secret is the ASCII string "12345678901234567890".
  const secret = encodeBase32(Buffer.from("12345678901234567890", "utf8"));
  assert.equal(secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"],
  ];
  for (const [unixSeconds, expected] of vectors) {
    assert.equal(
      totpCode(secret, unixSeconds * 1000, {
        algorithm: "SHA1",
        digits: 8,
        periodSeconds: 30,
      }),
      expected,
      `RFC 6238 vector at T=${unixSeconds}`,
    );
    // A pass uses six digits, which is the same dynamic truncation taken
    // modulo a smaller power of ten - the low six digits of the same value.
    assert.equal(
      totpCode(secret, unixSeconds * 1000, TOTP_PARAMETERS),
      expected.slice(-6),
    );
  }
});

test("the shipped parameters are RFC 6238's own defaults", () => {
  assert.deepEqual(TOTP_PARAMETERS, {
    algorithm: "SHA1",
    digits: 6,
    periodSeconds: 30,
  });
});

test("a minted secret is 160 random bits in 32 base32 characters", () => {
  assert.equal(TOTP_SECRET_BYTES, 20);
  const secret = mintPassSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(decodeBase32(secret).length, 20);
  // No padding is needed, so no `=` ever reaches the wire.
  assert.doesNotMatch(secret, /=/);
});

test("no two minted secrets are the same", () => {
  const secrets = new Set(Array.from({ length: 200 }, () => mintPassSecret()));
  assert.equal(secrets.size, 200);
});

test("a secret shorter than 160 bits is refused", () => {
  assert.throws(
    () => mintPassSecret(undefined, 10),
    /at least 20 bytes \(160 bits\)/,
  );
});

test("a code holds for its own window and one step either side", () => {
  const secret = mintPassSecret();
  const now = 1_800_000_000_000;
  const code = totpCode(secret, now);
  assert.equal(verifyTotpCode(secret, code, now), true);
  assert.equal(verifyTotpCode(secret, code, now + 30_000), true);
  assert.equal(verifyTotpCode(secret, code, now - 30_000), true);
  // Two steps out is a different code and is not accepted.
  assert.equal(verifyTotpCode(secret, code, now + 90_000), false);
  assert.equal(verifyTotpCode(secret, code, now - 90_000), false);
});

test("a code from another secret never verifies", () => {
  const now = 1_800_000_000_000;
  const mine = mintPassSecret();
  const theirs = mintPassSecret();
  assert.equal(verifyTotpCode(mine, totpCode(theirs, now), now), false);
});

test("a malformed code is rejected rather than parsed", () => {
  const secret = mintPassSecret();
  const now = 1_800_000_000_000;
  for (const presented of ["", "12345", "1234567", "12345a", " 123456", "abcdef"]) {
    assert.equal(verifyTotpCode(secret, presented, now), false, presented);
  }
});
