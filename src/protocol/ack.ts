export const ack = {
  message: { ack: { status: "ACK" as const } },
};

export function nack(message: string, data?: unknown) {
  return {
    message: { ack: { status: "NACK" as const } },
    error: {
      code: "40000",
      type: "JSON-SCHEMA-ERROR",
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}
