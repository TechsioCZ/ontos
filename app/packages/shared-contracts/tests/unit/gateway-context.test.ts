import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { Effect, Schema } from 'effect';
import {
  GatewayContextClaimsSchema,
  GatewayContextProtectedHeaderSchema,
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayTrustedPrincipalContextSchema,
  decodeGatewayContextClaims,
} from '../../src/gateway-context.ts';

const principal = {
  authContextRef: 'session:safe-reference',
  authMethod: 'session' as const,
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
};

const claims = {
  aud: 'inventory-stock',
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: '50000000-0000-4000-8000-000000000001',
  principal,
  sub: principal.principalId,
  ver: 1 as const,
};

test('decodes the exact versioned public assertion contract', async () => {
  assert.deepEqual(await Effect.runPromise(decodeGatewayContextClaims(claims)), claims);
  assert.deepEqual(
    Schema.decodeUnknownSync(GatewayContextProtectedHeaderSchema)({
      alg: 'EdDSA',
      kid: 'current-2026-08',
      typ: 'JWT',
    }),
    {
      alg: 'EdDSA',
      kid: 'current-2026-08',
      typ: 'JWT',
    },
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(GatewayContextRequestSchema)({
      audience: 'inventory-stock',
    }),
    { audience: 'inventory-stock' },
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(GatewayContextResponseSchema)({
      expiresAt: claims.exp,
      token: 'header.payload.signature',
    }),
    { expiresAt: claims.exp, token: 'header.payload.signature' },
  );
});

test('rejects malformed audiences, invalid ordering, and subject mismatch', async () => {
  await assert.rejects(
    Effect.runPromise(Schema.decodeUnknownEffect(GatewayContextRequestSchema)({ audience: '' })),
  );
  await assert.rejects(
    Effect.runPromise(decodeGatewayContextClaims({ ...claims, exp: claims.iat })),
  );
  await assert.rejects(
    Effect.runPromise(decodeGatewayContextClaims({ ...claims, exp: claims.iat + 301 })),
  );
  await assert.rejects(
    Effect.runPromise(
      decodeGatewayContextClaims({
        ...claims,
        sub: '60000000-0000-4000-8000-000000000001',
      }),
    ),
  );
});

test('rejects credential, display, authorization, Action, and business claim expansion', async () => {
  const forbiddenFields = [
    'email',
    'displayName',
    'credential',
    'cookie',
    'sessionToken',
    'actionKey',
    'permission',
    'policyDecision',
    'businessPayload',
  ] as const;

  await Promise.all(
    forbiddenFields.map((field) =>
      assert.rejects(
        Effect.runPromise(decodeGatewayContextClaims({ ...claims, [field]: 'must-not-pass' })),
        undefined,
        field,
      ),
    ),
  );
  await assert.rejects(
    Effect.runPromise(
      decodeGatewayContextClaims({
        ...claims,
        principal: { ...principal, email: 'must-not-pass@example.test' },
      }),
    ),
  );
});

test('schemas publish only the required public field names', () => {
  assert.equal(GatewayTrustedPrincipalContextSchema, TrustedPrincipalContextSchema);
  assert.deepEqual(Object.keys(GatewayContextClaimsSchema.fields).toSorted(), [
    'aud',
    'exp',
    'iat',
    'iss',
    'jti',
    'principal',
    'sub',
    'ver',
  ]);
  assert.deepEqual(Object.keys(GatewayContextProtectedHeaderSchema.fields).toSorted(), [
    'alg',
    'kid',
    'typ',
  ]);
});
