import { expect, test } from '@rstest/core';
import { Effect } from 'effect';
import { decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { parseGatewayIssuerConfig } from '../../api/auth/gateway-issuer-config.ts';
import type { GatewayIssuerConfigValue } from '../../api/auth/gateway-issuer-config.ts';
import { issueGatewayContextAssertion } from '../../api/auth/gateway-issuer.ts';
import type { GatewayIssuerDependencies } from '../../api/auth/gateway-issuer.ts';

const issuer = 'https://shell.example.test';
const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'session:safe-reference',
  authMethod: 'support_impersonation' as const,
  impersonatedByPrincipalId: '20000000-0000-4000-8000-000000000001',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '50000000-0000-4000-8000-000000000001',
};

const makeConfiguration = async (): Promise<{
  readonly configuration: GatewayIssuerConfigValue;
  readonly publicKey: CryptoKey;
}> => {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true,
  });
  const privateJwk = await exportJWK(privateKey);
  return {
    configuration: {
      issuer,
      privateJwk: {
        alg: 'EdDSA',
        crv: 'Ed25519',
        d: privateJwk.d ?? '',
        kid: 'current-2026-08',
        kty: 'OKP',
        use: 'sig',
        x: privateJwk.x ?? '',
      },
    },
    publicKey,
  };
};

const dependencies = (
  configuration: GatewayIssuerConfigValue,
  overrides: Partial<GatewayIssuerDependencies> = {},
): GatewayIssuerDependencies => ({
  currentTimeSeconds: Effect.succeed(1_700_000_000),
  generateJti: Effect.succeed('60000000-0000-4000-8000-000000000001'),
  loadAudiences: Effect.succeed(new Set(['inventory-stock'])),
  loadConfig: Effect.succeed(configuration),
  ...overrides,
});

test('signs exact five-minute, audience-scoped EdDSA claims with the configured key ID', async () => {
  const { configuration, publicKey } = await makeConfiguration();
  const result = await Effect.runPromise(
    issueGatewayContextAssertion(
      { audience: 'inventory-stock', principal },
      dependencies(configuration),
    ),
  );
  const header = decodeProtectedHeader(result.token);
  const claims = decodeJwt(result.token);
  const verified = await jwtVerify(result.token, publicKey, {
    algorithms: ['EdDSA'],
    audience: 'inventory-stock',
    currentDate: new Date(1_700_000_001_000),
    issuer,
  });

  expect(result.expiresAt).toBe(1_700_000_300);
  expect(header).toEqual({ alg: 'EdDSA', kid: 'current-2026-08', typ: 'JWT' });
  expect(claims).toEqual({
    aud: 'inventory-stock',
    exp: 1_700_000_300,
    iat: 1_700_000_000,
    iss: issuer,
    jti: '60000000-0000-4000-8000-000000000001',
    principal,
    sub: principal.principalId,
    ver: 1,
  });
  expect(verified.payload.principal).toEqual(principal);
  expect(JSON.stringify(claims)).not.toMatch(
    /email|displayName|credential|cookie|sessionToken|actionKey|permission|policy|businessPayload/u,
  );
});

test('fails closed for unknown audiences and invalid Effect-managed time', async () => {
  const { configuration } = await makeConfiguration();
  const audienceError = await Effect.runPromise(
    Effect.flip(
      issueGatewayContextAssertion({ audience: 'billing', principal }, dependencies(configuration)),
    ),
  );
  const timeError = await Effect.runPromise(
    Effect.flip(
      issueGatewayContextAssertion(
        { audience: 'inventory-stock', principal },
        dependencies(configuration, { currentTimeSeconds: Effect.succeed(-1) }),
      ),
    ),
  );

  expect(audienceError.code).toBe('gateway_audience_invalid');
  expect(timeError.code).toBe('gateway_issuer_unavailable');
});

test('rejects missing configuration, HMAC keys, non-Ed25519 keys, and missing key IDs', async () => {
  const invalidJwks = [
    undefined,
    { alg: 'HS256', d: 'secret', kid: 'hmac', kty: 'oct', use: 'sig', x: 'secret' },
    {
      alg: 'EdDSA',
      crv: 'X25519',
      d: 'private',
      kid: 'wrong-curve',
      kty: 'OKP',
      use: 'sig',
      x: 'public',
    },
    { alg: 'EdDSA', crv: 'Ed25519', d: 'private', kty: 'OKP', use: 'sig', x: 'public' },
  ];

  const errors = await Promise.all(
    invalidJwks.map((privateJwk) =>
      Effect.runPromise(
        Effect.flip(
          parseGatewayIssuerConfig({
            ONTOS_GATEWAY_ISSUER: issuer,
            ...(privateJwk === undefined
              ? {}
              : { ONTOS_GATEWAY_PRIVATE_JWK: JSON.stringify(privateJwk) }),
          }),
        ),
      ),
    ),
  );
  expect(errors.every((error) => error._tag === 'GatewayIssuerConfigError')).toBe(true);
});
