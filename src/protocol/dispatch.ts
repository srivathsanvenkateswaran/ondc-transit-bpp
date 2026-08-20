export async function dispatchCallback(
  callbackUrl: string,
  body: unknown,
  timeoutMs: number,
): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Callback ${callbackUrl} failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
}
