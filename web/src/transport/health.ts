// Health is the only active browser/server contract in the template.
export async function checkReadiness(signal: AbortSignal): Promise<boolean> {
  const response = await fetch('/health/ready', {
    signal,
    cache: 'no-store',
    credentials: 'omit',
  });
  return response.ok;
}
