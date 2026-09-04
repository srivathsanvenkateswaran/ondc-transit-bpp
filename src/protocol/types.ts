export interface Trv11Context {
  domain: "ONDC:TRV11";
  location: {
    country: { code: "IND" };
    city: { code: string };
  };
  action: string;
  version: "2.0.1";
  bap_id: string;
  bap_uri: string;
  bpp_id?: string;
  bpp_uri?: string;
  transaction_id: string;
  message_id: string;
  timestamp: string;
  ttl: string;
}

export interface SearchRequest {
  context: Trv11Context & { action: "search" };
  message: {
    intent: {
      /**
       * Absent on a pass search. A pass has neither an origin nor a
       * destination, so a stop pair cannot express the question at all.
       */
      fulfillment?: {
        stops: Array<{
          type: "START" | "END";
          location: {
            descriptor?: { code?: string };
            gps?: string;
          };
          time?: { timestamp?: string };
        }>;
        vehicle?: { category: "BUS" | "METRO" };
      };
      /** `PASS` asks about a category of products rather than a journey. */
      category?: { descriptor?: { code?: string } };
    };
  };
}

export interface SelectedItem {
  id: string;
  quantity: { selected: { count: number } };
}

export interface Billing {
  name: string;
  email?: string;
  phone: string;
}

export interface Payment {
  id?: string;
  collected_by: "BAP" | "BPP";
  status: "NOT_PAID" | "PAID";
  type: "PRE_ORDER";
  params?: Record<string, string>;
  tags?: Array<Record<string, unknown>>;
}

export interface SelectRequest {
  context: Trv11Context & {
    action: "select";
    bpp_id: string;
    bpp_uri: string;
  };
  message: {
    order: {
      items: SelectedItem[];
      provider: { id: string };
      tags?: Array<Record<string, unknown>>;
    };
  };
}

export interface InitRequest {
  context: Trv11Context & {
    action: "init";
    bpp_id: string;
    bpp_uri: string;
  };
  message: {
    order: {
      items: SelectedItem[];
      provider: { id: string };
      billing: Billing;
      payments: Payment[];
      tags?: Array<Record<string, unknown>>;
    };
  };
}

export interface ConfirmRequest {
  context: Trv11Context & {
    action: "confirm";
    bpp_id: string;
    bpp_uri: string;
  };
  message: {
    order: {
      items: SelectedItem[];
      provider: { id: string };
      billing: Billing;
      payments: Payment[];
      tags?: Array<Record<string, unknown>>;
    };
  };
}

export interface StatusRequest {
  context: Trv11Context & {
    action: "status";
    bpp_id: string;
    bpp_uri: string;
  };
  message: { order_id?: string; ref_id?: string };
}

export type ActionRequest =
  | SearchRequest
  | SelectRequest
  | InitRequest
  | ConfirmRequest
  | StatusRequest;

export type ProtocolOrder = Record<string, unknown> & {
  id?: string;
  status?: string;
  items: Array<Record<string, unknown>>;
  provider: Record<string, unknown>;
  fulfillments: Array<Record<string, unknown>>;
  quote: Record<string, unknown>;
};

export type CallbackResponse = Record<string, unknown> & {
  context: Trv11Context & { bpp_id: string; bpp_uri: string };
  message?: { order?: ProtocolOrder };
  error?: { code: string; paths?: string; message: string };
};

export type OnSearchResponse = Record<string, unknown> & {
  context: Trv11Context & { action: "on_search"; bpp_id: string; bpp_uri: string };
  message: {
    catalog: {
      descriptor: { name: string };
      providers: Array<Record<string, unknown>>;
    };
  };
};
