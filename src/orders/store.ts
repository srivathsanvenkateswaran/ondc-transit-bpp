import type { ProtocolOrder } from "../protocol/types.js";
import type { OperatorKey, TransitOffer } from "../sources/types.js";

export interface TransactionIdentity {
  transactionId: string;
  bapId: string;
  bapUri: string;
}

function transactionKey(
  operator: OperatorKey,
  identity: TransactionIdentity,
): string {
  return JSON.stringify([
    operator,
    identity.bapId,
    identity.bapUri,
    identity.transactionId,
  ]);
}

export class InMemoryOrderStore {
  private readonly catalogues = new Map<string, Map<string, TransitOffer>>();
  private readonly orders = new Map<
    string,
    {
      operator: OperatorKey;
      identity: TransactionIdentity;
      order: ProtocolOrder;
    }
  >();
  private readonly ordersByTransaction = new Map<string, string>();

  cacheCatalogue(
    operator: OperatorKey,
    identity: TransactionIdentity,
    offers: TransitOffer[],
  ): void {
    this.catalogues.set(
      transactionKey(operator, identity),
      new Map(offers.map((offer) => [offer.offerId, structuredClone(offer)])),
    );
  }

  selectedOffers(
    operator: OperatorKey,
    identity: TransactionIdentity,
    itemIds: string[],
  ): TransitOffer[] {
    const catalogue = this.catalogues.get(transactionKey(operator, identity));
    if (!catalogue) {
      throw new OrderLifecycleError(
        "CATALOGUE-NOT-FOUND",
        `No search catalogue exists for transaction ${identity.transactionId}`,
      );
    }
    return itemIds.map((itemId) => {
      const offer = catalogue.get(itemId);
      if (!offer) {
        throw new OrderLifecycleError(
          "ITEM-NOT-FOUND",
          `Unknown item.id ${itemId} for transaction ${identity.transactionId}`,
        );
      }
      return structuredClone(offer);
    });
  }

  save(
    operator: OperatorKey,
    identity: TransactionIdentity,
    order: ProtocolOrder & { id: string },
  ): void {
    const existing = this.orders.get(order.id);
    if (existing) {
      throw new OrderLifecycleError(
        "ORDER-ID-COLLISION",
        `Generated order.id ${order.id} already exists`,
      );
    }
    const key = transactionKey(operator, identity);
    if (this.ordersByTransaction.has(key)) {
      throw new OrderLifecycleError(
        "ORDER-ALREADY-CONFIRMED",
        `Transaction ${identity.transactionId} already has a confirmed order`,
      );
    }
    this.orders.set(order.id, {
      operator,
      identity: { ...identity },
      order: structuredClone(order),
    });
    this.ordersByTransaction.set(key, order.id);
  }

  findByTransaction(
    operator: OperatorKey,
    identity: TransactionIdentity,
  ): ProtocolOrder | undefined {
    const orderId = this.ordersByTransaction.get(
      transactionKey(operator, identity),
    );
    if (!orderId) return undefined;
    return structuredClone(this.orders.get(orderId)!.order);
  }

  get(
    operator: OperatorKey,
    identity: TransactionIdentity,
    orderId: string,
  ): ProtocolOrder {
    const stored = this.orders.get(orderId);
    if (
      !stored ||
      stored.operator !== operator ||
      transactionKey(operator, stored.identity) !==
        transactionKey(operator, identity)
    ) {
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
