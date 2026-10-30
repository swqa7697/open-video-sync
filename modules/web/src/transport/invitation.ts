// Consume invitation fragments before mounting any component or fetching resources.
export function consumeInvitation(): string | undefined {
  const fragment = location.hash;
  if (fragment)
    history.replaceState(null, '', location.pathname + location.search);
  if (location.pathname !== '/join') return undefined;
  const params = new URLSearchParams(fragment.slice(1));
  const secret = params.get('invite');
  return secret && /^[A-Za-z0-9_-]{22}$/.test(secret) ? secret : undefined;
}
