export function logEvent(fields: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...fields })}\n`);
}
