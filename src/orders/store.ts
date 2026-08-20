import type { ProtocolOrder } from "../protocol/types.js";
import type { OperatorKey, TransitOffer } from "../sources/types.js";

function transactionKey(operator: OperatorKey, transactionId: string): string {
  return `${operator}:${transactionId}`;
}

export class InMemoryOrderStore {
  private readonly catalogues = new Map<string, Map<string, TransitOffer>>();
  private readonly orders = new Map<
    string,
    { operator: OperatorKey; transactionId: string; order: ProtocolOrder }
  >();

  cacheCatalogue(
    operator: OperatorKey,
    transactionId: string,
    offers: TransitOffer[],
  ): void {
    this.catalogues.set(
      transactionKey(operator, transactionId),
      new Map(offers.map((offer) => [offer.offerId, structuredClone(offer)])),
    );
  }

  selectedOffers(
    operator: OperatorKey,
    transactionId: string,
    itemIds: string[],
  ): TransitOffer[] {
    const catalogue = this.catalogues.get(transactionKey(operator, transactionId));
    if (!catalogue) {
      throw new OrderLifecycleError(
        "CATALOGUE-NOT-FOUND",
        `No search catalogue exists for transaction ${transactionId}`,
      );
    }
    return itemIds.map((itemId) => {
      const offer = catalogue.get(itemId);
      if (!offer) {
        throw new OrderLifecycleError(
          "ITEM-NOT-FOUND",
          `Unknown item.id ${itemId} for transaction ${transactionId}`,
        );
      }
      return structuredClone(offer);
    });
  }

  save(
    operator: OperatorKey,
    transactionId: string,
    order: ProtocolOrder & { id: string },
  ): void {
    this.orders.set(order.id, {
      operator,
      transactionId,
      order: structuredClone(order),
    });
  }

  get(operator: OperatorKey, orderId: string): ProtocolOrder {
    const stored = this.orders.get(orderId);
    if (!stored || stored.operator !== operator) {
      throw new OrderLifecycleError(
        "ORDER-NOT-FOUND",
        `Unknown order.id ${orderId} for operator ${operator}`,
      );
    }
    return structuredClone(stored.order);
  }

  inspect(orderId: string): ProtocolOrder | undefined {
    const stored = this.orders.get(orderId);
    return stored ? structuredClone(stored.order) : undefined;
  }
}

export class OrderLifecycleError extends Error {
  readonly type = "DOMAIN-ERROR";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrderLifecycleError";
  }
}
