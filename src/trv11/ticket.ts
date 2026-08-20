import QRCode from "qrcode";

const ISO_DURATION =
  /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+)S)?)?$/;

export function durationMilliseconds(duration: string): number {
  const match = ISO_DURATION.exec(duration);
  if (!match?.groups) {
    throw new Error(`Unsupported ticket validity duration ${duration}`);
  }
  const days = Number(match.groups.days ?? 0);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);
  const milliseconds =
    (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(`Ticket validity must be a positive duration: ${duration}`);
  }
  return milliseconds;
}

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
