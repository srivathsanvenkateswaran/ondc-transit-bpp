import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The rotating credential a pass carries in place of a single-journey
 * ticket's static QR PNG.
 *
 * RFC 6238 (TOTP) is the reference, and the parameters below are its own
 * defaults used unchanged rather than varied per pass: HMAC-SHA1, six
 * digits, a thirty second period. RFC 4648 is the reference for the base32
 * encoding of the shared secret.
 *
 * What this does not solve is stated in `docs/passes.md` and must not be
 * overstated anywhere: a screenshot of a currently-valid code, shared to
 * another device, passes for the rest of its thirty second window. Rotation
 * shortens the useful life of a shared code from the whole pass period to
 * thirty seconds. It does not prevent sharing.
 */

/** RFC 4648 section 6 base32 alphabet. */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 section 4 defaults, used unchanged. */
export const TOTP_ALGORITHM = "SHA1" as const;
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * 160 bits, the shared-secret length RFC 6238's own reference implementation
 * recommends for HMAC-SHA1. Twenty bytes is also exactly thirty-two base32
 * characters, so the encoded secret never needs padding.
 */
export const TOTP_SECRET_BYTES = 20;

/**
 * RFC 6238 section 5.2 permits accepting a code from an adjacent time step to
 * absorb clock skew between the device that computed it and the party
 * checking it. One step either side of the current one is the widest window
 * that section allows to be read as reasonable.
 */
export const TOTP_STEP_DRIFT = 1;

export interface TotpParameters {
  algorithm: typeof TOTP_ALGORITHM;
  digits: number;
  periodSeconds: number;
}

export const TOTP_PARAMETERS: TotpParameters = {
  algorithm: TOTP_ALGORITHM,
  digits: TOTP_DIGITS,
  periodSeconds: TOTP_PERIOD_SECONDS,
};

export function encodeBase32(bytes: Buffer): string {
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    encoded += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  }
  return encoded;
}

export function decodeBase32(encoded: string): Buffer {
  const normalized = encoded.replace(/=+$/, "").toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      // The offending character is deliberately not echoed: this function is
      // handed pass secrets, and a secret must never reach a log line.
      throw new Error(
        "Secret is not base32: it contains a character outside the RFC 4648 alphabet",
      );
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export type SecretFactory = (byteLength: number) => Buffer;

/**
 * Mint one pass credential's secret. Called once per credential fulfillment,
 * per unit of quantity, and never reused across passes - not even for the
 * same rider buying two passes in one order.
 */
export function mintPassSecret(
  random: SecretFactory = randomBytes,
  byteLength = TOTP_SECRET_BYTES,
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < TOTP_SECRET_BYTES) {
    throw new Error(
      `A pass secret must be at least ${TOTP_SECRET_BYTES} bytes (160 bits)`,
    );
  }
  const bytes = random(byteLength);
  if (bytes.length !== byteLength) {
    throw new Error("Secret factory returned the wrong number of bytes");
  }
  return encodeBase32(bytes);
}

function hmacName(algorithm: TotpParameters["algorithm"]): string {
  if (algorithm !== TOTP_ALGORITHM) {
    throw new Error(`Unsupported TOTP algorithm ${algorithm}`);
  }
  return "sha1";
}

/** RFC 6238: `HOTP(secret, floor(unixTime / period))`, truncated to `digits`. */
export function totpCode(
  secretBase32: string,
  atMilliseconds: number,
  parameters: TotpParameters = TOTP_PARAMETERS,
): string {
  const { digits, periodSeconds } = parameters;
  if (!Number.isSafeInteger(digits) || digits < 6 || digits > 10) {
    throw new Error("TOTP digits must be an integer from 6 to 10");
  }
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) {
    throw new Error("TOTP period must be a positive whole number of seconds");
  }
  const counter = Math.floor(Math.floor(atMilliseconds / 1000) / periodSeconds);
  if (counter < 0) {
    throw new Error("TOTP counter is before the Unix epoch");
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(hmacName(parameters.algorithm), decodeBase32(secretBase32))
    .update(message)
    .digest();
  // RFC 4226 section 5.4 dynamic truncation.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Check a presented code against a stored secret. Returns a boolean and
 * nothing else: no reason string, because every reason a code could fail is
 * derived from the code itself and the code must not be reflected anywhere.
 */
export function verifyTotpCode(
  secretBase32: string,
  presented: string,
  atMilliseconds: number,
  parameters: TotpParameters = TOTP_PARAMETERS,
  stepDrift = TOTP_STEP_DRIFT,
): boolean {
  if (
    typeof presented !== "string" ||
    presented.length !== parameters.digits ||
    !/^[0-9]+$/.test(presented)
  ) {
    return false;
  }
  const presentedBuffer = Buffer.from(presented, "utf8");
  let matched = false;
  for (let step = -stepDrift; step <= stepDrift; step += 1) {
    const candidate = totpCode(
      secretBase32,
      atMilliseconds + step * parameters.periodSeconds * 1000,
      parameters,
    );
    const candidateBuffer = Buffer.from(candidate, "utf8");
    // Compared for every step rather than short-circuiting, so the time this
    // takes does not depend on which step matched.
    if (
      candidateBuffer.length === presentedBuffer.length &&
      timingSafeEqual(candidateBuffer, presentedBuffer)
    ) {
      matched = true;
    }
  }
  return matched;
}
