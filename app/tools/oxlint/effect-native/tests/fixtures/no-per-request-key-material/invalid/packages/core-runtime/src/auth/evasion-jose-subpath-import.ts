// expect-count: 2
// EVASION: `jose` publishes deep subpaths (jose/jwks/local, jose/key/import); `jose/*` misses them.
import { createLocalJWKSet } from 'jose/jwks/local';
import { importPKCS8 } from 'jose/key/import';

export const verify = async (pem: string, jwks: unknown) => {
  const set = createLocalJWKSet(jwks as never);
  const key = await importPKCS8(pem, 'EdDSA');
  return [set, key];
};
