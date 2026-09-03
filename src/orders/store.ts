import type { ProtocolOrder } from "../protocol/types.js";
import type {
  OperatorKey,
  ServiceTier,
  TransitOffer,
} from "../sources/types.js";

export interface TransactionIdentity {
  transactionId: string;
  bapId: string;
  bapUri: string;
}

/**
 * One minted pass credential, held so that a later ride order claiming to be
 * settled by this pass can be checked against it. This provider mints the
 * secret, so this provider is the party that can check a presented code.
 */
export interface PassCredentialRecord {
  fulfillmentId: string;
  itemId: string;
  scope: ServiceTier;
  /** The pass's own window, in epoch milliseconds. `validToMs` is exclusive. */
  validFromMs: number;
  validToMs: number;
  secretBase32: string;
  algorithm: "SHA1";
  digits: number;
  periodSeconds: number;
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

/**
 * A pass is bought in one transaction and presented in another, so its
 * credentials are keyed by order id rather than by transaction. The buyer app
 * is still part of the key: one BAP must not be able to settle a ride against
 * a pass another BAP bought. So is the operator, because an operator can only
 * check a pass it issued itself - a BMTC BPP holds no BMRCL secret, exactly
 * as it sells no BMRCL ticket.
 */
function passKey(
  operator: OperatorKey,
  identity: TransactionIdentity,
  orderId: string,
): string {
  return JSON.stringify([operator, identity.bapId, identity.bapUri, orderId]);
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
  private readonly passCredentials = new Map<string, PassCredentialRecord[]>();

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

  savePassCredentials(
    operator: OperatorKey,
    identity: TransactionIdentity,
    orderId: string,
    credentials: PassCredentialRecord[],
  ): void {
    if (credentials.length === 0) return;
    this.passCredentials.set(
      passKey(operator, identity, orderId),
      credentials.map((credential) => ({ ...credential })),
    );
  }

  /** Empty when this operator holds no pass under that order id for this BAP. */
  findPassCredentials(
    operator: OperatorKey,
    identity: TransactionIdentity,
    orderId: string,
  ): PassCredentialRecord[] {
    const stored = this.passCredentials.get(
      passKey(operator, identity, orderId),
    );
    return stored ? stored.map((credential) => ({ ...credential })) : [];
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
