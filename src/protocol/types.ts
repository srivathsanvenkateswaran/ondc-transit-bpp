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
      fulfillment: {
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
    };
  };
}

export type OnSearchResponse = Record<string, unknown> & {
  context: Trv11Context & { action: "on_search"; bpp_id: string; bpp_uri: string };
  message: {
    catalog: {
      descriptor: { name: string };
      providers: Array<Record<string, unknown>>;
    };
  };
};
