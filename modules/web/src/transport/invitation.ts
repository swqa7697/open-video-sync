// Remove secrets from the URL before mounting components. Keep pending entry in
// this history entry so installing the helper and reloading can resume joining.
export function consumeInvitation(): string | undefined {
  const fragment = location.hash;
  const state: unknown = history.state;
  const secret: unknown = fragment
    ? new URLSearchParams(fragment.slice(1)).get('invite')
    : state && typeof state === 'object' && 'pendingInvitation' in state
      ? state.pendingInvitation
      : undefined;
  const pending =
    location.pathname === '/join' &&
    typeof secret === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(secret)
      ? secret
      : undefined;
  history.replaceState(
    pending ? { pendingInvitation: pending } : null,
    '',
    location.pathname + location.search
  );
  return pending;
}
