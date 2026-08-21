export async function dispatchCallback(
  callbackUrl: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Callback ${callbackUrl} failed with HTTP ${response.status}: ${responseText.slice(0, 1_000)}`,
    );
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error(`Callback ${callbackUrl} returned invalid JSON`);
  }
  const ackStatus = (
    responseBody as { message?: { ack?: { status?: unknown } } }
  ).message?.ack?.status;
  if (ackStatus !== "ACK") {
    throw new Error(
      `Callback ${callbackUrl} was not acknowledged (status ${String(ackStatus)})`,
    );
  }
}
