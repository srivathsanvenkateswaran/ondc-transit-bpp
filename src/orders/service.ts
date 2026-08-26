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
  encodeQrPng,
  ticketAuthorization,
  type QrEncoder,
} from "../trv11/ticket.js";
import { serviceInstant } from "../trv11/time.js";
import {
  InMemoryOrderStore,
  OrderLifecycleError,
  type TransactionIdentity,
} from "./store.js";

interface ServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  qrEncoder?: QrEncoder;
  publicBaseUrl: string;
  fleetSimulatorUrl?: string;
}

interface TicketSpec {
  id: string;
  parentId: string;
  validity: string;
  sequence: number;
}

interface BaseOrder {
  order: ProtocolOrder;
  tickets: TicketSpec[];
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
    const { order, tickets } = this.baseOrder(
      request.context,
      request.message.order,
    );
    const issuedAt = this.now();
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
    const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
    const fulfillments = await Promise.all(
      order.fulfillments.map(async (fulfillment) => {
        const id = String(fulfillment.id);
        const ticket = ticketById.get(id);
        if (!ticket) return fulfillment;
        const ticketNumber = `SPECIMEN-${this.operatorKey.toUpperCase()}-${orderId.slice(-8)}-${String(
          ticket.sequence,
        ).padStart(2, "0")}`;
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
    if (this.options.fleetSimulatorUrl) {
      void fetch(this.options.fleetSimulatorUrl + '/fleet/report-sale', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timestamp: issuedAt.toISOString() }), signal: AbortSignal.timeout(1000) }).catch(() => undefined)
    }
    return structuredClone(confirmed);
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

  private baseOrder(
    context: Trv11Context,
    input: { items: SelectedItem[]; provider: { id: string } },
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
