import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { Effect, Redacted, Result, Schema, SchemaAST, Struct } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';
import {
  ApiKeyGatewayHeadersSchema,
  GatewayContextApiGroup,
  GatewayContextClaimsSchema,
  GatewayContextProtectedHeaderSchema,
  GatewayContextRequestSchema,
  GatewayContextResponseSchema,
  GatewayRateLimitedProblemSchema,
  GatewayReloadRequiredProblemSchema,
  GatewayTrustedPrincipalContextSchema,
  GatewayUnavailableProblemSchema,
  decodeGatewayContextClaims,
} from '../../src/gateway-context.ts';
import { issueApiKeyGatewayContext } from '../../src/gateway-context-api-key.ts';

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
  compositionRevision: 'a'.repeat(64),
  exp: 1_700_000_300,
  iat: 1_700_000_000,
  iss: 'https://shell.example.test',
  jti: '50000000-0000-4000-8000-000000000001',
  principal,
  sub: principal.principalId,
  targetBuildMarker: 'inventory-release-2026-10-02',
  ver: 1 as const,
};

it.effect('decodes the exact versioned public assertion contract', () =>
  Effect.gen(function* testScenario1() {
    expect(yield* decodeGatewayContextClaims(claims)).toEqual(claims);
    expect(
      yield* Schema.decodeEffect(GatewayContextProtectedHeaderSchema)({
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
      yield* Schema.decodeEffect(GatewayContextRequestSchema)({
        audience: 'inventory-stock',
        compositionRevision: claims.compositionRevision,
      }),
    ).toEqual({ audience: 'inventory-stock', compositionRevision: claims.compositionRevision });
    expect(
      yield* Schema.decodeEffect(GatewayContextResponseSchema)({
        apiBaseUrl: '/inventory-stock-api',
        compositionRevision: claims.compositionRevision,
        expiresAt: claims.exp,
        token: 'header.payload.signature',
      }),
    ).toEqual({
      apiBaseUrl: '/inventory-stock-api',
      compositionRevision: claims.compositionRevision,
      expiresAt: claims.exp,
      token: 'header.payload.signature',
    });
  }),
);

it.effect('requires the approved response revision and a same-origin API base path', () =>
  Effect.gen(function* responseReleaseIdentityContractTest() {
    const response = {
      apiBaseUrl: '/inventory-stock-api',
      compositionRevision: claims.compositionRevision,
      expiresAt: claims.exp,
      token: 'header.payload.signature',
    };
    const decodeResponse = Schema.decodeUnknownEffect(GatewayContextResponseSchema, { onExcessProperty: 'error' });
    for (const field of ['apiBaseUrl', 'compositionRevision'] as const) {
      expect(Result.isFailure(yield* Effect.result(decodeResponse(Struct.omit(response, [field]))))).toBe(true);
    }
    for (const apiBaseUrl of [
      '',
      'inventory-stock-api',
      'https://attacker.example/api',
      '//attacker.example/api',
      '/api?token=secret',
      '/api#fragment',
      '/ api',
    ]) {
      expect(Result.isFailure(yield* Effect.result(decodeResponse({ ...response, apiBaseUrl }))), apiBaseUrl).toBe(
        true,
      );
    }
    for (const compositionRevision of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${'a'.repeat(64)}`]) {
      expect(Result.isFailure(yield* Effect.result(decodeResponse({ ...response, compositionRevision })))).toBe(true);
    }
    expect(
      Result.isFailure(yield* Effect.result(decodeResponse({ ...response, internalDeployment: 'must-not-pass' }))),
    ).toBe(true);
  }),
);

it.effect('rejects malformed audiences, invalid ordering, and subject mismatch', () =>
  Effect.gen(function* testScenario2() {
    expect(
      yield* Effect.flip(
        Schema.decodeEffect(GatewayContextRequestSchema)({
          audience: '',
          compositionRevision: claims.compositionRevision,
        }),
      ),
    ).toBeDefined();
    expect(yield* Effect.flip(decodeGatewayContextClaims({ ...claims, exp: claims.iat }))).toBeDefined();
    expect(yield* Effect.flip(decodeGatewayContextClaims({ ...claims, exp: claims.iat + 301 }))).toBeDefined();
    expect(
      yield* Effect.flip(
        decodeGatewayContextClaims({
          ...claims,
          sub: '60000000-0000-4000-8000-000000000001',
        }),
      ),
    ).toBeDefined();
    expect(
      yield* Effect.flip(
        decodeGatewayContextClaims({
          ...claims,
          principal: { ...principal, trustedStorefrontId: 'payload-storefront' },
        }),
      ),
    ).toBeDefined();
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(GatewayContextRequestSchema, { onExcessProperty: 'error' })({
          audience: 'inventory-stock',
          compositionRevision: claims.compositionRevision,
          trustedStorefrontId: 'payload-storefront',
        }),
      ),
    ).toBeDefined();
  }),
);

it.effect('requires the approved composition and target release in every assertion', () =>
  Effect.gen(function* releaseIdentityContractTest() {
    const { compositionRevision: _compositionRevision, ...withoutRevision } = claims;
    const { targetBuildMarker: _targetBuildMarker, ...withoutTargetRelease } = claims;
    expect(yield* Effect.flip(decodeGatewayContextClaims(withoutRevision))).toBeDefined();
    expect(yield* Effect.flip(decodeGatewayContextClaims(withoutTargetRelease))).toBeDefined();

    for (const compositionRevision of [
      '',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      'g'.repeat(64),
      `sha256:${'a'.repeat(64)}`,
    ]) {
      expect(
        yield* Effect.flip(decodeGatewayContextClaims({ ...claims, compositionRevision })),
        compositionRevision,
      ).toBeDefined();
    }
    expect(yield* decodeGatewayContextClaims({ ...claims, targetBuildMarker: 'a'.repeat(200) })).toEqual({
      ...claims,
      targetBuildMarker: 'a'.repeat(200),
    });
    for (const targetBuildMarker of ['', 'a'.repeat(201), ' ', ' release', 'release ']) {
      expect(yield* Effect.flip(decodeGatewayContextClaims({ ...claims, targetBuildMarker }))).toBeDefined();
    }
  }),
);

it.effect('requires a valid pinned composition when requesting an assertion', () =>
  Effect.gen(function* requestedCompositionContractTest() {
    expect(
      yield* Effect.flip(Schema.decodeUnknownEffect(GatewayContextRequestSchema)({ audience: 'inventory-stock' })),
    ).toBeDefined();
    for (const compositionRevision of ['', 'a'.repeat(63), 'A'.repeat(64), `sha256:${'a'.repeat(64)}`]) {
      expect(
        yield* Effect.flip(
          Schema.decodeEffect(GatewayContextRequestSchema)({ audience: 'inventory-stock', compositionRevision }),
        ),
      ).toBeDefined();
    }
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
    'compositionRevision',
    'exp',
    'iat',
    'iss',
    'jti',
    'principal',
    'sub',
    'targetBuildMarker',
    'ver',
  ]);
  expect(Object.keys(GatewayContextProtectedHeaderSchema.fields).toSorted()).toEqual(['alg', 'kid', 'typ']);
});

it('publishes the exact API-key credential boundary and failure statuses', () => {
  expect(Object.keys(ApiKeyGatewayHeadersSchema.fields)).toEqual(['x-api-key']);
  expect(endpointStatuses(GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext)).toEqual([
    400, 401, 403, 409, 429, 500, 503,
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
  const reloadRequired = {
    _tag: 'GatewayReloadRequiredProblem',
    detail: 'Reload to select the approved composition.',
    reloadRequired: true,
    status: 409,
    title: 'Gateway reload required',
    type: 'https://ontos.dev/problems/gateway-reload-required',
  } as const;
  const decodedRateLimited = Schema.decodeSync(GatewayRateLimitedProblemSchema)(rateLimited);
  expect(Schema.is(GatewayRateLimitedProblemSchema)(decodedRateLimited)).toBe(true);
  expect(Struct.omit(decodedRateLimited, ['_tag'])).toEqual(Struct.omit(rateLimited, ['_tag']));
  const decodedUnavailable = Schema.decodeSync(GatewayUnavailableProblemSchema)(unavailable);
  expect(Schema.is(GatewayUnavailableProblemSchema)(decodedUnavailable)).toBe(true);
  expect(Struct.omit(decodedUnavailable, ['_tag'])).toEqual(Struct.omit(unavailable, ['_tag']));
  const decodedReloadRequired = Schema.decodeSync(GatewayReloadRequiredProblemSchema)(reloadRequired);
  expect(Schema.is(GatewayReloadRequiredProblemSchema)(decodedReloadRequired)).toBe(true);
  expect(Struct.omit(decodedReloadRequired, ['_tag'])).toEqual(Struct.omit(reloadRequired, ['_tag']));
  expect(() =>
    Schema.decodeUnknownSync(GatewayReloadRequiredProblemSchema)({ ...reloadRequired, reloadRequired: false }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(GatewayRateLimitedProblemSchema, {
      onExcessProperty: 'error',
    })({
      ...rateLimited,
      internalDiagnostic: 'must-not-pass',
    }),
  ).toThrow();
  const actual = [...GatewayContextApiGroup.endpoints.issueApiKeyGatewayContext.error];
  expect(actual.map(problemTag)).toEqual([
    'GatewayAuthenticationRequiredProblem',
    'GatewayAudienceInvalidProblem',
    'GatewayReloadRequiredProblem',
    'GatewayForbiddenProblem',
    'GatewayRateLimitedProblem',
    'GatewayUnavailableProblem',
    'GatewayInternalProblem',
  ]);
});

it.effect('issues API-key gateway context through the server-only credential boundary', () =>
  Effect.gen(function* apiKeyGatewayContextClientTest() {
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.url).toBe('https://shell.example.test/shell-super-app-api/auth/api-key/gateway-context');
      return Promise.resolve(
        Response.json({
          apiBaseUrl: '/payment-term-catalog-api',
          compositionRevision: claims.compositionRevision,
          expiresAt: claims.exp,
          token: 'fresh-signed-assertion',
        }),
      );
    };

    const response = yield* issueApiKeyGatewayContext(
      {
        audience: 'payment-term-catalog',
        compositionRevision: claims.compositionRevision,
        legalEntityId: '20000000-0000-4000-8000-000000000001',
      },
      {
        apiKey: Redacted.make('server-owned-api-key'),
        baseUrl: new URL('https://shell.example.test/shell-super-app-api'),
        requestCorrelation: 'catalog-credential-correlation',
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));

    expect(response).toEqual({
      apiBaseUrl: '/payment-term-catalog-api',
      compositionRevision: claims.compositionRevision,
      expiresAt: claims.exp,
      token: 'fresh-signed-assertion',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('x-api-key')).toBe('server-owned-api-key');
    expect(requests[0]?.headers.get('x-correlation-id')).toBe('catalog-credential-correlation');
    expect(requests[0]?.headers.get('cookie')).toBeNull();
    expect(requests[0]?.headers.get('authorization')).toBeNull();
    expect(yield* Effect.promise(() => requests[0]?.json() ?? Promise.resolve())).toEqual({
      audience: 'payment-term-catalog',
      compositionRevision: claims.compositionRevision,
      legalEntityId: '20000000-0000-4000-8000-000000000001',
    });
  }),
);
