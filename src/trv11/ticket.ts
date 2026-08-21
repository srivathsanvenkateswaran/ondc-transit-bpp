import QRCode from "qrcode";

import { durationMilliseconds } from "./time.js";

export { durationMilliseconds } from "./time.js";

export function specimenTicketPayload(
  orderId: string,
  ticketNumber: string,
): string {
  return `SPECIMEN|TRV11|${orderId}|${ticketNumber}|NOT VALID FOR TRAVEL`;
}

export type QrEncoder = (payload: string) => Promise<Buffer>;

export const encodeQrPng: QrEncoder = (payload) =>
  QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 256,
  });

export async function ticketAuthorization(
  orderId: string,
  ticketNumber: string,
  validity: string,
  issuedAt: Date,
  encoder: QrEncoder = encodeQrPng,
) {
  const payload = specimenTicketPayload(orderId, ticketNumber);
  const token = (await encoder(payload)).toString("base64");
  return {
    type: "QR",
    token,
    valid_to: new Date(
      issuedAt.getTime() + durationMilliseconds(validity),
    ).toISOString(),
    status: "UNCLAIMED",
  } as const;
}
