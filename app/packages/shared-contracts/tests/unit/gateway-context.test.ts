// @effect-diagnostics asyncFunction:off -- Node test callbacks bridge the Effect contracts under test; expires: 2027-03-31.
import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { Schema, SchemaAST } from 'effect';
import {
  ApiKeyGatewayHeadersSchema,
  GatewayContextApiGroup,
  GatewayContextClaimsSchema,
  GatewayContextProtectedHeaderSchema,
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayRateLimitedProblemSchema,
  GatewayTrustedPrincipalContextSchema,
  GatewayUnavailableProblemSchema,
  decodeGatewayContextClaims,
} from '../../src/gateway-context.ts';

const endpointStatuses = (
  endpoint: (typeof GatewayContextApiGroup.endpoints)[keyof typeof GatewayContextApiGroup.endpoints],
) =>
  [...endpoint.error]
    .map((schema) => schema.ast.annotations?.['httpApiStatus'])
    .toSorted((left, right) => Number(left) - Number(right));

const problemTag = (schema: Schema.Top): SchemaAST.LiteralValue => {
  assert.ok(SchemaAST.isObjects(schema.ast));
  const tag = schema.ast.propertySignatures.find(({ name }) => name === '_tag')?.type;
  assert.ok(tag !== undefined && SchemaAST.isLiteral(tag));
  return tag.literal;
};

const principal = {
  authBindingId: '70000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:safe-reference',
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

void test('decodes the exact versioned public assertion contract', async () => {
  assert.deepEqual(await runEffectTestPromise(decodeGatewayContextClaims(claims)), claims);
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

void test('rejects malformed audiences, invalid ordering, and subject mismatch', async () => {
  await assert.rejects(
    runEffectTestPromise(Schema.decodeUnknownEffect(GatewayContextRequestSchema)({ audience: '' })),
  );
  await assert.rejects(
    runEffectTestPromise(decodeGatewayContextClaims({ ...claims, exp: claims.iat })),
  );
  await assert.rejects(
    runEffectTestPromise(decodeGatewayContextClaims({ ...claims, exp: claims.iat + 301 })),
  );
  await assert.rejects(
    runEffectTestPromise(
      decodeGatewayContextClaims({
        ...claims,
        sub: '60000000-0000-4000-8000-000000000001',
      }),
    ),
  );
});

void test('rejects credential, display, authorization, Action, and business claim expansion', async () => {
  const forbiddenFields = [
    'email',
    'displayName',
    'credential',
    'rawApiKey',
    'providerKeyId',
    'keyId',
    'cookie',
    'sessionToken',
    'actionKey',
    'permission',
    'policyDecision',
    'businessPayload',
  ] as const;

  await Promise.all(
    forbiddenFields.map(
      async (field) =>
        await assert.rejects(
          runEffectTestPromise(decodeGatewayContextClaims({ ...claims, [field]: 'must-not-pass' })),
          field,
        ),
    ),
  );
  await assert.rejects(
    runEffectTestPromise(
      decodeGatewayContextClaims({
        ...claims,
        principal: { ...principal, email: 'must-not-pass@example.test' },
      }),
    ),
  );
});

void test('schemas publish only the required public field names', () => {
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

void test('publishes the exact API-key credential boundary and failure statuses', () => {
  assert.deepEqual(Object.keys(ApiKeyGatewayHeadersSchema.fields), ['x-api-key']);
  assert.deepEqual(
    endpointStatuses(GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext),
    [400, 401, 403, 429, 500, 503],
  );
});

void test('preserves migrated gateway Problem Details shapes and ordered endpoint membership', () => {
  const rateLimited = {
    _tag: 'GatewayRateLimitedProblem',
    detail: 'Retry after the published delay.',
    retryAfterSeconds: 30,
    status: 429,
    title: 'Gateway rate limited',
    type: 'https://ontos.dev/problems/gateway-rate-limited',
  } as const;
  const unavailable = {
    _tag: 'GatewayUnavailableProblem',
    detail: 'The gateway is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Gateway unavailable',
    type: 'https://ontos.dev/problems/gateway-unavailable',
  } as const;
  assert.deepEqual(
    Schema.decodeUnknownSync(GatewayRateLimitedProblemSchema)(rateLimited),
    rateLimited,
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(GatewayUnavailableProblemSchema)(unavailable),
    unavailable,
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(GatewayRateLimitedProblemSchema, { onExcessProperty: 'error' })({
      ...rateLimited,
      internalDiagnostic: 'must-not-pass',
    }),
  );
  const actual = [...GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext.error];
  assert.deepEqual(actual.map(problemTag), [
    'GatewayAuthenticationRequiredProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayForbiddenProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
    'GatewayInternalProblem',
  ]);
});
