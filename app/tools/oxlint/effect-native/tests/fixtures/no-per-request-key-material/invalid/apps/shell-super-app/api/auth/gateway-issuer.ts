// expect-count: 1
// Mirrors apps/shell-super-app/api/auth/gateway-issuer.ts:97 (audit A1/A3).
import { Effect } from 'effect';
import { SignJWT, importJWK } from 'jose';

interface IssuerConfig {
  readonly issuer: string;
  readonly privateJwk: { readonly kid: string };
}

export const issueAssertion = (configuration: IssuerConfig, subject: string) =>
  Effect.tryPromise({
    catch: () => new Error('signing'),
    try: async () => {
      // Re-imports the private key on every signing call.
      const key = await importJWK(configuration.privateJwk as never, 'EdDSA');
      return await new SignJWT({ sub: subject })
        .setProtectedHeader({ alg: 'EdDSA', kid: configuration.privateJwk.kid, typ: 'JWT' })
        .setIssuer(configuration.issuer)
        .sign(key as never);
    },
  });
