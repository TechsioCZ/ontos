// expect-count: 2
// Mirrors verticals/contacts/api/auth/action-principal.ts:232 (audit A1/A3).
import { Effect } from 'effect';
import { createLocalJWKSet, jwtVerify } from 'jose';

interface PrincipalConfig {
  readonly issuer: string;
  readonly jwks: { readonly keys: readonly unknown[] };
}

export const verifyActionPrincipal = (token: string, configuration: PrincipalConfig) =>
  Effect.tryPromise({
    catch: () => new Error('invalid'),
    try: () =>
      // Rebuilds the local JWK set for every inbound request.
      jwtVerify(token, createLocalJWKSet(configuration.jwks as never), {
        algorithms: ['EdDSA'],
        issuer: configuration.issuer,
      }),
  });

export function verifyAgain(token: string, configuration: PrincipalConfig): Promise<unknown> {
  return jwtVerify(token, createLocalJWKSet(configuration.jwks as never));
}
