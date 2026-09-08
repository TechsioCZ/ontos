// expect-count: 6
// Alias / namespace / computed / optional-chaining / WebCrypto / point-free coverage.
import { Effect } from 'effect';
import * as jose from 'jose';
import { createSecretKey } from 'node:crypto';

export const loadEverything = (token: string, jwks: unknown) =>
  Effect.tryPromise({
    catch: () => new Error('key'),
    try: async () => {
      const local = jose.createLocalJWKSet(jwks as never);
      const remote = jose['createRemoteJWKSet'](new URL('https://issuer.example/jwks'));
      const imported = await jose?.importJWK?.({} as never);
      const secret = createSecretKey(token as never);
      const raw = await globalThis.crypto.subtle.importKey('raw', new Uint8Array(), 'HMAC', false, ['sign']);
      return [local, remote, imported, secret, raw];
    },
  });

export const pointFree = (material: readonly string[]) =>
  Effect.sync(() => material.map(createSecretKey as never));
