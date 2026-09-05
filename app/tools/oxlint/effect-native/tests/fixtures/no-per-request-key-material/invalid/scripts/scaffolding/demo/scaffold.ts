// expect-count: 1
// Audit A8: the generator emits per-request key material into every new MicroVertical.
export const renderActionPrincipalServer = (appId: string): string => `
import { Effect } from 'effect';
import { createLocalJWKSet, jwtVerify } from 'jose';

export const AUDIENCE = '${appId}';

export const verify = (token: string, configuration: { readonly jwks: unknown }) =>
  Effect.tryPromise({
    catch: () => new Error('invalid'),
    try: () => jwtVerify(token, createLocalJWKSet(configuration.jwks), { audience: AUDIENCE }),
  });
`;
