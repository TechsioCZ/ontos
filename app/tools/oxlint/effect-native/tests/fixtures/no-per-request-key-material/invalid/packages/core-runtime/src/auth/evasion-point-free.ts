// expect-count: 3
// point-free pipe / callback references.
import { Effect, pipe } from 'effect';
import { createLocalJWKSet, importJWK } from 'jose';

export const a = (jwk: unknown) => pipe(jwk, importJWK);
export const b = (jwks: readonly unknown[]) => Effect.forEach(jwks, createLocalJWKSet as never);
export const c = (jwk: unknown) => Effect.promise(() => importJWK(jwk as never, 'EdDSA'));
