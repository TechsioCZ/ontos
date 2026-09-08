// expect-count: 1
import { importJWK as loadJwk } from 'jose';

export function KeyBadge({ jwk }: { readonly jwk: unknown }) {
  const load = async () => await loadJwk(jwk as never, 'EdDSA');
  return <button onClick={() => void load()}>load</button>;
}
