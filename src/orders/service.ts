import { randomUUID } from "node:crypto";

import type { OperatorRuntimeConfig } from "../config.js";
import type {
  ConfirmRequest,
  InitRequest,
  Payment,
  ProtocolOrder,
  SelectRequest,
  SelectedItem,
  StatusRequest,
  Trv11Context,
} from "../protocol/types.js";
import type {
  OperatorKey,
  OperatorProfile,
  TransitOffer,
} from "../sources/types.js";
import {
  fulfillmentIdForOffer,
  paiseToRupees,
  tripFulfillmentForOffer,
} from "../trv11/catalog.js";
import {
  assertNoConcessionOnTicketOrder,
  concessionFromOrderTags,
} from "../trv11/concession.js";
import {
  concessionDiscountPaise,
  concessionInfoTag,
  concessionRatePercent,
  concessionTag,
  isPassItemId,
  passFulfillment,
  passInfoTag,
  passItemById,
  passValidityWindow,
  signedPaiseToRupees,
  syntheticPassTag,
  totpInfoTag,
  PASS_CATEGORY_ID,
  PASS_ITEM_CODE,
  type PassCatalogueItem,
} from "../trv11/pass.js";
import {
  assertPassSettlement,
  passSettlementClaim,
  serviceTierForOffer,
} from "../trv11/settlement.js";
import {
  encodeQrPng,
  ticketAuthorization,
  type QrEncoder,
} from "../trv11/ticket.js";
import { serviceInstant } from "../trv11/time.js";
import {
  mintPassSecret,
  TOTP_PARAMETERS,
  type SecretFactory,
} from "../trv11/totp.js";
import {
  InMemoryOrderStore,
  OrderLifecycleError,
  type PassCredentialRecord,
  type TransactionIdentity,
} from "./store.js";

interface ServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  qrEncoder?: QrEncoder;
  secretFactory?: SecretFactory;
  publicBaseUrl: string;
}

interface TicketSpec {
  id: string;
  parentId: string;
  validity: string;
  sequence: number;
}

/** One unit of a pass, which becomes one rotating credential at `confirm`. */
interface PassCredentialSpec {
  id: string;
  parentId: string;
  sequence: number;
  item: PassCatalogueItem;
}

interface OrderSelection {
  items: SelectedItem[];
  provider: { id: string };
  /** Carries the `CONCESSION` tag group when a pass is bought at a rate. */
  tags?: Array<Record<string, unknown>>;
}

interface BaseOrder {
  order: ProtocolOrder;
  /** Single-journey tickets. Empty on a pass order. */
  tickets: TicketSpec[];
  /** Pass credentials. Empty on a single-journey order. */
  passCredentials: PassCredentialSpec[];
  /** The single-journey offers behind this order, for a settlement check. */
  offers: TransitOffer[];
}

function ticketTags(parentId: string) {
  return [
    {
      descriptor: { code: "INFO" },
      list: [{ descriptor: { code: "PARENT_ID" }, value: parentId }],
    },
    {
      descriptor: { code: "SPECIMEN_INFO" },
      display: true,
      list: [
        {
          descriptor: { code: "NOTICE" },
          value: "SPECIMEN - NOT VALID FOR TRAVEL",
        },
      ],
    },
  ];
}

function specimenOrderTags() {
  return [
    {
      descriptor: { code: "SPECIMEN_INFO" },
      display: true,
      list: [
        {
          descriptor: { code: "NOTICE" },
          value:
            "SPECIMEN - NOT VALID FOR TRAVEL - not issued by BMTC or BMRCL",
        },
      ],
    },
  ];
}

function paymentWithId(
  payment: Payment,
  operator: OperatorKey,
  transactionId: string,
  index: number,
): Record<string, unknown> {
  return {
    ...structuredClone(payment),
    id:
      payment.id ??
      `PAY-${operator.toUpperCase()}-${transactionId.slice(0, 8)}-${index + 1}`,
  };
}

export class TransitOrderService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly qrEncoder: QrEncoder;
  private readonly secretFactory: SecretFactory | undefined;
  private readonly confirmations = new Map<string, Promise<ProtocolOrder>>();

  constructor(
    private readonly operatorKey: OperatorKey,
    private readonly profile: OperatorProfile,
    private readonly runtime: OperatorRuntimeConfig,
    private readonly store: InMemoryOrderStore,
    private readonly options: ServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.qrEncoder = options.qrEncoder ?? encodeQrPng;
    this.secretFactory = options.secretFactory;
  }

  cacheCatalogue(
    context: Pick<Trv11Context, "transaction_id" | "bap_id" | "bap_uri">,
    offers: TransitOffer[],
  ): void {
    this.store.cacheCatalogue(this.operatorKey, this.identity(context), offers);
  }

  select(request: SelectRequest): ProtocolOrder {
    return this.baseOrder(request.context, request.message.order).order;
  }

  init(request: InitRequest): ProtocolOrder {
    this.assertPaymentStatus(request.message.order.payments, "NOT_PAID");
    const { order } = this.baseOrder(request.context, request.message.order);
    return {
      ...order,
      billing: structuredClone(request.message.order.billing),
      payments: request.message.order.payments.map((payment, index) =>
        paymentWithId(
          payment,
          this.operatorKey,
          request.context.transaction_id,
          index,
        ),
      ),
    };
  }

  async confirm(request: ConfirmRequest): Promise<ProtocolOrder> {
    this.assertPaymentStatus(request.message.order.payments, "PAID");
    this.assertBppAddress(request.context);
    const identity = this.identity(request.context);
    const confirmed = this.store.findByTransaction(this.operatorKey, identity);
    if (confirmed) return confirmed;

    const confirmationKey = JSON.stringify(identity);
    const pending = this.confirmations.get(confirmationKey);
    if (pending) return structuredClone(await pending);

    const confirmation = this.confirmNew(request, identity);
    this.confirmations.set(confirmationKey, confirmation);
    try {
      return structuredClone(await confirmation);
    } finally {
      if (this.confirmations.get(confirmationKey) === confirmation) {
        this.confirmations.delete(confirmationKey);
      }
    }
  }

  private async confirmNew(
    request: ConfirmRequest,
    identity: TransactionIdentity,
  ): Promise<ProtocolOrder> {
    const { order, tickets, passCredentials, offers } = this.baseOrder(
      request.context,
      request.message.order,
    );
    const issuedAt = this.now();
    this.checkPassSettlement(request, identity, offers, passCredentials, issuedAt);
    const idComponent = this.idFactory().replace(/[^A-Za-z0-9]/g, "");
    if (!idComponent) {
      throw new OrderLifecycleError(
        "INVALID-ORDER-ID",
        "Order id generator returned no usable characters",
      );
    }
    const orderId =
      `SPECIMEN-ORD-${this.operatorKey.toUpperCase()}-` +
      idComponent.toUpperCase();
    const ticketNumberFor = (sequence: number) =>
      `SPECIMEN-${this.operatorKey.toUpperCase()}-${orderId.slice(-8)}-${String(
        sequence,
      ).padStart(2, "0")}`;
    const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    const credentialById = new Map(
      passCredentials.map((credential) => [credential.id, credential]),
    );
    const mintedCredentials: PassCredentialRecord[] = [];
    const fulfillments = await Promise.all(
      order.fulfillments.map(async (fulfillment) => {
        const id = String(fulfillment.id);
        const credential = credentialById.get(id);
        if (credential) {
          return this.mintPassCredential(
            fulfillment,
            credential,
            ticketNumberFor(credential.sequence),
            issuedAt,
            mintedCredentials,
          );
        }
        const ticket = ticketById.get(id);
        if (!ticket) return fulfillment;
        const ticketNumber = ticketNumberFor(ticket.sequence);
        const authorization = await ticketAuthorization(
          orderId,
          ticketNumber,
          ticket.validity,
          issuedAt,
          this.qrEncoder,
        );
        return {
          ...fulfillment,
          stops: [{ type: "START", authorization }],
          tags: [
            ...ticketTags(ticket.parentId),
            {
              descriptor: { code: "TICKET_INFO" },
              list: [
                { descriptor: { code: "NUMBER" }, value: ticketNumber },
              ],
            },
          ],
        };
      }),
    );
    const confirmed = {
      ...order,
      id: orderId,
      status: "ACTIVE",
      fulfillments,
      billing: structuredClone(request.message.order.billing),
      payments: request.message.order.payments.map((payment, index) =>
        paymentWithId(
          payment,
          this.operatorKey,
          request.context.transaction_id,
          index,
        ),
      ),
      created_at: issuedAt.toISOString(),
      updated_at: issuedAt.toISOString(),
    } satisfies ProtocolOrder & { id: string };
    this.store.save(this.operatorKey, identity, confirmed);
    this.store.savePassCredentials(
      this.operatorKey,
      identity,
      orderId,
      mintedCredentials,
    );
    return structuredClone(confirmed);
  }

  /**
   * Mint one pass credential. Fresh per credential fulfillment, per unit of
   * quantity, and never reused - not even for the same rider buying two
   * passes at once.
   */
  private mintPassCredential(
    fulfillment: Record<string, unknown>,
    credential: PassCredentialSpec,
    ticketNumber: string,
    issuedAt: Date,
    minted: PassCredentialRecord[],
  ): Record<string, unknown> {
    const secretBase32 = mintPassSecret(this.secretFactory);
    const window = passValidityWindow(issuedAt, credential.item.window);
    minted.push({
      fulfillmentId: credential.id,
      itemId: credential.item.id,
      scope: credential.item.scope,
      validFromMs: window.validFromMs,
      validToMs: window.validToMs,
      secretBase32,
      algorithm: TOTP_PARAMETERS.algorithm,
      digits: TOTP_PARAMETERS.digits,
      periodSeconds: TOTP_PARAMETERS.periodSeconds,
    });
    return {
      ...fulfillment,
      stops: [
        {
          type: "START",
          authorization: {
            // Not `QR`: there is no image to show. A static code, screenshotted
            // once, works for every remaining day of a monthly pass, so a pass
            // carries a secret to derive a short-lived code from instead.
            type: "TOTP",
            token: secretBase32,
            valid_from: window.validFrom,
            valid_to: window.validTo,
            status: "ISSUED",
          },
        },
      ],
      tags: [
        ...ticketTags(credential.parentId),
        totpInfoTag({
          algorithm: TOTP_PARAMETERS.algorithm,
          digits: TOTP_PARAMETERS.digits,
          periodSeconds: TOTP_PARAMETERS.periodSeconds,
        }),
        {
          descriptor: { code: "TICKET_INFO" },
          list: [{ descriptor: { code: "NUMBER" }, value: ticketNumber }],
        },
      ],
    };
  }

  /**
   * A ride settled by a pass. The buyer app sends the claim; this provider
   * checks it, because this provider minted the secret. Nothing about the
   * order shape changes - same items, same quote, same full fare in
   * `params.amount`.
   */
  private checkPassSettlement(
    request: ConfirmRequest,
    identity: TransactionIdentity,
    offers: TransitOffer[],
    passCredentials: PassCredentialSpec[],
    issuedAt: Date,
  ): void {
    const claim = passSettlementClaim(request.message.order.payments);
    if (!claim) return;
    if (passCredentials.length > 0) {
      throw new OrderLifecycleError(
        "PASS-SETTLEMENT-INVALID",
        "A pass purchase cannot itself be settled by a pass; PASS_SETTLEMENT belongs on a single-journey order",
      );
    }
    assertPassSettlement(
      claim,
      this.store.findPassCredentials(
        this.operatorKey,
        identity,
        claim.passOrderId,
      ),
      offers.map((offer) => serviceTierForOffer(offer, this.profile)),
      issuedAt.getTime(),
    );
  }

  status(request: StatusRequest): ProtocolOrder {
    this.assertBppAddress(request.context);
    const orderId = request.message.order_id ?? request.message.ref_id;
    if (!orderId) {
      throw new OrderLifecycleError(
        "ORDER-ID-REQUIRED",
        "status requires order_id or ref_id",
      );
    }
    return this.store.get(
      this.operatorKey,
      this.identity(request.context),
      orderId,
    );
  }

  /**
   * A selection is either all pass items or all single-journey items. The two
   * are different products - one is a fare for a period and a scope, the
   * other a fare for a stop pair - and an order mixing them has no coherent
   * quote, so it is refused rather than half-priced.
   */
  private baseOrder(
    context: Trv11Context,
    input: OrderSelection,
  ): BaseOrder {
    this.assertBppAddress(context);
    if (input.provider.id !== this.profile.id) {
      throw new OrderLifecycleError(
        "PROVIDER-NOT-FOUND",
        `Unknown provider.id ${input.provider.id}`,
      );
    }
    const itemIds = input.items.map((item) => item.id);
    if (new Set(itemIds).size !== itemIds.length) {
      throw new OrderLifecycleError(
        "DUPLICATE-ITEM",
        "Each selected item.id must be unique",
      );
    }
    input.items.forEach((item) => {
      const count = item.quantity.selected.count;
      if (!Number.isSafeInteger(count) || count < 1 || count > 6) {
        throw new OrderLifecycleError(
          "INVALID-QUANTITY",
          `Selected quantity for ${item.id} must be an integer from 1 to 6`,
        );
      }
    });
    const passItemCount = itemIds.filter((id) => isPassItemId(id)).length;
    if (passItemCount === 0) return this.ticketBaseOrder(context, input);
    if (passItemCount !== itemIds.length) {
      throw new OrderLifecycleError(
        "MIXED-CATEGORY-ORDER",
        "An order selects pass items or single-journey items, never both",
      );
    }
    return this.passBaseOrder(context, input);
  }

  /** The single-journey path, unchanged apart from the concession guard. */
  private ticketBaseOrder(
    context: Trv11Context,
    input: OrderSelection,
  ): BaseOrder {
    assertNoConcessionOnTicketOrder(input.tags);
    const itemIds = input.items.map((item) => item.id);
    const offers = this.store.selectedOffers(
      this.operatorKey,
      this.identity(context),
      itemIds,
    );
    const tickets: TicketSpec[] = [];
    const items: Array<Record<string, unknown>> = [];
    const fulfillments: Array<Record<string, unknown>> = [];
    const breakup: Array<Record<string, unknown>> = [];
    let totalPaise = 0;
    let ticketSequence = 0;

    offers.forEach((offer, index) => {
      const selected = input.items[index];
      const count = selected.quantity.selected.count;
      const tripId = fulfillmentIdForOffer(offer.offerId);
      const ticketIds = Array.from({ length: count }, (_, ticketIndex) => {
        ticketSequence += 1;
        const id = `T-${offer.offerId}-${ticketIndex + 1}`;
        tickets.push({
          id,
          parentId: tripId,
          validity: offer.validity,
          sequence: ticketSequence,
        });
        return id;
      });
      const linePaise = offer.farePaise * count;
      if (!Number.isSafeInteger(linePaise + totalPaise)) {
        throw new OrderLifecycleError(
          "PRICE-OVERFLOW",
          "Selected fare total exceeds safe integer paise",
        );
      }
      totalPaise += linePaise;
      const unitPrice = { currency: "INR", value: paiseToRupees(offer.farePaise) };
      items.push({
        id: offer.offerId,
        category_ids: ["C1"],
        descriptor: { name: offer.productName, code: offer.productCode },
        price: unitPrice,
        quantity: { selected: { count } },
        fulfillment_ids: [tripId, ...ticketIds],
        time: {
          label: "Validity",
          duration: offer.validity,
          timestamp: this.now().toISOString(),
        },
      });
      fulfillments.push(
        tripFulfillmentForOffer(
          offer,
          this.profile.vehicleCategory,
          tripId,
        ),
        ...ticketIds.map((id) => ({
          id,
          type: "TICKET",
          tags: ticketTags(tripId),
        })),
      );
      breakup.push({
        title: "BASE_FARE",
        item: {
          id: offer.offerId,
          price: unitPrice,
          quantity: { selected: { count } },
        },
        price: { currency: "INR", value: paiseToRupees(linePaise) },
      });
    });

    return {
      order: {
        items,
        provider: {
          id: this.profile.id,
          descriptor: { name: this.profile.name },
          time: {
            range: {
              start: serviceInstant(
                context.timestamp,
                this.profile.serviceWindow.startHHMM,
              ),
              end: serviceInstant(
                context.timestamp,
                this.profile.serviceWindow.endHHMM,
              ),
            },
          },
        },
        fulfillments,
        quote: {
          price: { currency: "INR", value: paiseToRupees(totalPaise) },
          breakup,
        },
        cancellation_terms: [
          {
            external_ref: {
              mimetype: "text/html",
              url: `${this.options.publicBaseUrl}/terms`,
            },
          },
        ],
        tags: specimenOrderTags(),
      },
      tickets,
      passCredentials: [],
      offers,
    };
  }

  /**
   * A pass order. The nine items are static constants published identically
   * to every buyer, so they resolve straight from the catalogue rather than
   * from the per-transaction cache a route-sliced single-journey offer needs.
   */
  private passBaseOrder(
    context: Trv11Context,
    input: OrderSelection,
  ): BaseOrder {
    const concession = concessionFromOrderTags(input.tags);
    const timestamp = this.now().toISOString();
    const items: Array<Record<string, unknown>> = [];
    const fulfillments: Array<Record<string, unknown>> = [];
    const breakup: Array<Record<string, unknown>> = [];
    const passCredentials: PassCredentialSpec[] = [];
    let basePaise = 0;
    let discountPaise = 0;
    let sequence = 0;

    input.items.forEach((selected) => {
      const item = passItemById(this.operatorKey, selected.id);
      if (!item) {
        throw new OrderLifecycleError(
          "ITEM-NOT-FOUND",
          `${this.profile.name} does not sell pass item ${selected.id}`,
        );
      }
      const count = selected.quantity.selected.count;
      const passFulfillmentId = fulfillmentIdForOffer(item.id);
      const credentialIds = Array.from({ length: count }, (_, index) => {
        sequence += 1;
        const id = `T-${item.id}-${index + 1}`;
        passCredentials.push({
          id,
          parentId: passFulfillmentId,
          sequence,
          item,
        });
        return id;
      });
      const linePaise = item.pricePaise * count;
      if (!Number.isSafeInteger(linePaise + basePaise)) {
        throw new OrderLifecycleError(
          "PRICE-OVERFLOW",
          "Selected pass total exceeds safe integer paise",
        );
      }
      basePaise += linePaise;
      if (concession) {
        discountPaise +=
          concessionDiscountPaise(
            item.pricePaise,
            concessionRatePercent(item, concession),
          ) * count;
      }
      const unitPrice = {
        currency: "INR",
        value: paiseToRupees(item.pricePaise),
      };
      items.push({
        id: item.id,
        category_ids: [PASS_CATEGORY_ID],
        descriptor: { name: item.name, code: PASS_ITEM_CODE },
        price: unitPrice,
        quantity: { selected: { count } },
        fulfillment_ids: [passFulfillmentId, ...credentialIds],
        time: { label: "Validity", duration: item.duration, timestamp },
        tags: [passInfoTag(item), concessionInfoTag(item), syntheticPassTag()],
      });
      fulfillments.push(
        passFulfillment(item),
        ...credentialIds.map((id) => ({
          id,
          type: "TICKET",
          tags: ticketTags(passFulfillmentId),
        })),
      );
      breakup.push({
        title: "BASE_FARE",
        item: {
          id: item.id,
          price: unitPrice,
          quantity: { selected: { count } },
        },
        price: { currency: "INR", value: paiseToRupees(linePaise) },
      });
    });

    if (concession && discountPaise > 0) {
      // One aggregated line, so the receipt shows the arithmetic rather than
      // only the result. It carries no `item`: a concession is a modifier on
      // the order, not a line attributable to one item.
      breakup.push({
        title: `${concession}_CONCESSION`,
        price: {
          currency: "INR",
          value: signedPaiseToRupees(-discountPaise),
        },
      });
    }
    const totalPaise = basePaise - discountPaise;
    if (totalPaise < 0) {
      throw new OrderLifecycleError(
        "PRICE-UNDERFLOW",
        "A concession cannot discount a pass below zero",
      );
    }

    return {
      order: {
        items,
        provider: {
          id: this.profile.id,
          descriptor: { name: this.profile.name },
          time: {
            range: {
              start: serviceInstant(
                context.timestamp,
                this.profile.serviceWindow.startHHMM,
              ),
              end: serviceInstant(
                context.timestamp,
                this.profile.serviceWindow.endHHMM,
              ),
            },
          },
        },
        fulfillments,
        quote: {
          price: { currency: "INR", value: paiseToRupees(totalPaise) },
          breakup,
        },
        cancellation_terms: [
          {
            external_ref: {
              mimetype: "text/html",
              url: `${this.options.publicBaseUrl}/terms`,
            },
          },
        ],
        tags: [
          ...specimenOrderTags(),
          ...(concession ? [concessionTag(concession)] : []),
          syntheticPassTag(),
        ],
      },
      tickets: [],
      passCredentials,
      offers: [],
    };
  }

  private assertPaymentStatus(
    payments: Payment[],
    expected: "NOT_PAID" | "PAID",
  ): void {
    if (payments.length === 0 || payments.some(({ status }) => status !== expected)) {
      throw new OrderLifecycleError(
        "INVALID-PAYMENT-STATUS",
        `All payments must have status ${expected}`,
      );
    }
  }

  private assertBppAddress(context: Trv11Context): void {
    if (
      context.bpp_id !== this.runtime.subscriberId ||
      context.bpp_uri !== this.runtime.subscriberUri
    ) {
      throw new OrderLifecycleError(
        "BPP-ADDRESS-MISMATCH",
        `Request must address ${this.runtime.subscriberId} at ${this.runtime.subscriberUri}`,
      );
    }
  }

  private identity(
    context: Pick<Trv11Context, "transaction_id" | "bap_id" | "bap_uri">,
  ): TransactionIdentity {
    return {
      transactionId: context.transaction_id,
      bapId: context.bap_id,
      bapUri: context.bap_uri,
    };
  }
}
