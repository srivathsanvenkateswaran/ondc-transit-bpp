/**
 * Paise to rupees, on the wire.
 *
 * A second copy of a formatter the module next door already has, and the
 * duplication is deliberate for the same reason the schema tree is duplicated:
 * a change made for one domain must not silently alter what the other prints.
 * The two are byte-identical today and neither is entitled to assume the other
 * stays that way.
 *
 * Everything internal is integer paise. A rupee value exists only at the
 * moment a number becomes a string on a payload.
 */

export function paiseToRupees(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new Error("paise must be a non-negative safe integer");
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return remainder === 0
    ? String(rupees)
    : `${rupees}.${String(remainder).padStart(2, "0")}`;
}

export function signedPaiseToRupees(paise: number): string {
  return paise < 0 ? `-${paiseToRupees(-paise)}` : paiseToRupees(paise);
}
