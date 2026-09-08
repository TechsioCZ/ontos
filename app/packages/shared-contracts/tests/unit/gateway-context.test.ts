import { expect, it } from '@app/effect-rstest';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { Effect, Schema, SchemaAST, Struct } from 'effect';
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

const problemTag = (schema: Schema.Top) => {
  expect(SchemaAST.isObjects(schema.ast)).toBe(true);
  const tag = SchemaAST.isObjects(schema.ast)
    ? schema.ast.propertySignatures.find(({ name }) => name === '_tag')?.type
    : undefined;
  expect(tag !== undefined && SchemaAST.isLiteral(tag)).toBe(true);
  return tag !== undefined && SchemaAST.isLiteral(tag) ? tag.literal : undefined;
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

it.effect('decodes the exact versioned public assertion contract', () =>
  Effect.gen(function* testScenario1() {
    expect(yield* decodeGatewayContextClaims(claims)).toEqual(claims);
    expect(
      yield* Schema.decodeUnknownEffect(GatewayContextProtectedHeaderSchema)({
        alg: 'EdDSA',
        kid: 'current-2026-08',
        typ: 'JWT',
      }),
    ).toEqual({
      alg: 'EdDSA',
      kid: 'current-2026-08',
      typ: 'JWT',
    });
    expect(
      yield* Schema.decodeUnknownEffect(GatewayContextRequestSchema)({
        audience: 'inventory-stock',
      }),
    ).toEqual({ audience: 'inventory-stock' });
    expect(
      yield* Schema.decodeUnknownEffect(GatewayContextResponseSchema)({
        expiresAt: claims.exp,
        token: 'header.payload.signature',
      }),
    ).toEqual({ expiresAt: claims.exp, token: 'header.payload.signature' });
  }),
);

it.effect('rejects malformed audiences, invalid ordering, and subject mismatch', () =>
  Effect.gen(function* testScenario2() {
    expect(
      yield* Effect.flip(Schema.decodeUnknownEffect(GatewayContextRequestSchema)({ audience: '' })),
    ).toBeDefined();
    expect(
      yield* Effect.flip(decodeGatewayContextClaims({ ...claims, exp: claims.iat })),
    ).toBeDefined();
    expect(
      yield* Effect.flip(decodeGatewayContextClaims({ ...claims, exp: claims.iat + 301 })),
    ).toBeDefined();
    expect(
      yield* Effect.flip(
        decodeGatewayContextClaims({
          ...claims,
          sub: '60000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toBeDefined();
  }),
);

it.effect('rejects credential, display, authorization, Action, and business claim expansion', () =>
  Effect.gen(function* testScenario3() {
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

    for (const field of forbiddenFields) {
      expect(
        yield* Effect.flip(decodeGatewayContextClaims({ ...claims, [field]: 'must-not-pass' })),
        field,
      ).toBeDefined();
    }
    expect(
      yield* Effect.flip(
        decodeGatewayContextClaims({
          ...claims,
          principal: { ...principal, email: 'must-not-pass@example.test' },
        }),
      ),
    ).toBeDefined();
  }),
);

it('schemas publish only the required public field names', () => {
  expect(GatewayTrustedPrincipalContextSchema).toBe(TrustedPrincipalContextSchema);
  expect(Object.keys(GatewayContextClaimsSchema.fields).toSorted()).toEqual([
    'aud',
    'exp',
    'iat',
    'iss',
    'jti',
    'principal',
    'sub',
    'ver',
  ]);
  expect(Object.keys(GatewayContextProtectedHeaderSchema.fields).toSorted()).toEqual([
    'alg',
    'kid',
    'typ',
  ]);
});

it('publishes the exact API-key credential boundary and failure statuses', () => {
  expect(Object.keys(ApiKeyGatewayHeadersSchema.fields)).toEqual(['x-api-key']);
  expect(endpointStatuses(GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext)).toEqual([
    400, 401, 403, 429, 500, 503,
  ]);
});

it('preserves migrated gateway Problem Details shapes and ordered endpoint membership', () => {
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
  const decodedRateLimited = Schema.decodeUnknownSync(GatewayRateLimitedProblemSchema)(rateLimited);
  expect(Schema.is(GatewayRateLimitedProblemSchema)(decodedRateLimited)).toBe(true);
  expect(Struct.omit(decodedRateLimited, ['_tag'])).toEqual(Struct.omit(rateLimited, ['_tag']));
  const decodedUnavailable = Schema.decodeUnknownSync(GatewayUnavailableProblemSchema)(unavailable);
  expect(Schema.is(GatewayUnavailableProblemSchema)(decodedUnavailable)).toBe(true);
  expect(Struct.omit(decodedUnavailable, ['_tag'])).toEqual(Struct.omit(unavailable, ['_tag']));
  expect(() =>
    Schema.decodeUnknownSync(GatewayRateLimitedProblemSchema, { onExcessProperty: 'error' })({
      ...rateLimited,
      internalDiagnostic: 'must-not-pass',
    }),
  ).toThrow();
  const actual = [...GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext.error];
  expect(actual.map(problemTag)).toEqual([
    'GatewayAuthenticationRequiredProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayForbiddenProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
    'GatewayInternalProblem',
  ]);
});
