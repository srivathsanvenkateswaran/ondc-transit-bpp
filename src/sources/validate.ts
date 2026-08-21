import { durationMilliseconds } from "../trv11/time.js";
import type { TransitOffer } from "./types.js";

export function validateOfferSet(
  offers: TransitOffer[],
  sourceDescription: string,
): void {
  const offerIds = new Set<string>();
  offers.forEach((offer) => {
    if (
      typeof offer.offerId !== "string" ||
      offer.offerId.length === 0 ||
      !Array.isArray(offer.route) ||
      offer.route.length < 2
    ) {
      throw new Error(
        `${sourceDescription} contains an offer without an id or two route stops`,
      );
    }
    if (offerIds.has(offer.offerId)) {
      throw new Error(
        `${sourceDescription} contains duplicate offerId ${offer.offerId}`,
      );
    }
    offerIds.add(offer.offerId);
    if (!Number.isSafeInteger(offer.farePaise) || offer.farePaise < 0) {
      throw new Error(
        `${sourceDescription} farePaise must be a non-negative safe integer`,
      );
    }
    durationMilliseconds(offer.validity);
  });
}
