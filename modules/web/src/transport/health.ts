export type Readiness = 'ready' | 'not_ready' | 'unreachable';
// OVS answers 503 for failed persistent writes and during shutdown; anything else is unreachable.
export async function checkReadiness(signal: AbortSignal): Promise<Readiness> {
  try {
    const response = await fetch('/health/ready', {
      signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    return response.ok
      ? 'ready'
      : response.status === 503
        ? 'not_ready'
        : 'unreachable';
  } catch (error) {
    if (signal.aborted) throw error;
    return 'unreachable';
  }
}
