import { randomUUID } from 'node:crypto';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  ReadRuntime,
} from '@app/core-runtime';
import type { GatewayAssertionRedemption, ReadCoreError, ReadRuntimeService } from '@app/core-runtime';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import { priceGroupDefinitionReadApiLive } from '../../api/price-group-definition-read-server.ts';
import { validatePriceGroupCompatibilityReadApiLive } from '../../api/validate-price-group-compatibility-read-server.ts';
import { priceGroupCatalogApi } from '../../shared/api.ts';
import {
  PriceGroupDefinitionAuthenticationProblemSchema,
  PriceGroupDefinitionDomainUnavailableProblemSchema,
  PriceGroupDefinitionForbiddenProblemSchema,
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
  PriceGroupDefinitionUnavailableProblemSchema,
} from '../../shared/apis/price-group-definition.ts';
import {
  ValidatePriceGroupCompatibilityAuthenticationProblemSchema,
  ValidatePriceGroupCompatibilityDomainConflictProblemSchema,
  ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema,
  ValidatePriceGroupCompatibilityForbiddenProblemSchema,
  ValidatePriceGroupCompatibilityRequestSchema,
  ValidatePriceGroupCompatibilityResponseSchema,
  ValidatePriceGroupCompatibilityUnavailableProblemSchema,
} from '../../shared/apis/validate-price-group-compatibility.ts';
import {
  PriceGroupCurrentnessFailure,
  PriceGroupExpectedCurrentConflict,
  PriceGroupPersistenceUnavailable,
} from '../../shared/domain/price-group-errors.ts';
import { PriceGroupDefinitionRevisionSchema, PriceGroupIdentitySchema } from '../../shared/domain/price-group.ts';
import { executePriceGroupDefinitionWithAuthorization } from '../../src/api/price-group-definition-client.ts';
import { executeValidatePriceGroupCompatibilityWithAuthorization } from '../../src/api/validate-price-group-compatibility-client.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const priceGroupId = '33333333-3333-4333-8333-333333333333';
const definitionRevisionId = '44444444-4444-4444-8444-444444444444';
const trustedOperationAt = '2026-11-01T00:00:00.000Z';
const issuer = 'https://shell.price-group-read.test';
const baseUrl = 'https://pricing.price-group-read.test';

const principal = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:price-group-read-http-test',
  authMethod: 'session',
  principalId,
  tenantId,
} as const;
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog',
  resourceId: priceGroupId,
  resourceType: 'pricing.price-group-catalog.price-group',
  tenantId,
} as const;
const requiredContract = {
  contractId: 'commerce.customer-price-group-assignment',
  version: 1,
} as const;
const definition = Schema.decodeUnknownSync(PriceGroupDefinitionRevisionSchema)({
  acceptedCatalogRevision: 7,
  classificationPurpose: 'Classifies customers eligible for dealer pricing.',
  compatibilityContracts: [requiredContract],
  created: {
    actionInvocationId: '66666666-6666-4666-8666-666666666666',
    actorPrincipalId: '77777777-7777-4777-8777-777777777777',
    reason: 'Approved the current Price Group definition.',
    trustedAt: '2026-09-23T12:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Dealer pricing classification.',
  displayName: 'Dealer',
  effectivePeriod: {
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    effectiveTo: '2027-01-01T00:00:00.000Z',
  },
  meaningFingerprint: 'a'.repeat(64),
  previousDefinitionRevisionId: '88888888-8888-4888-8888-888888888888',
  priceGroupRef,
  revisionNumber: 3,
});
const identity = Schema.decodeUnknownSync(PriceGroupIdentitySchema)({
  businessCode: 'DEALER',
  classificationPurpose: definition.classificationPurpose,
  created: definition.created,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: definition.effectivePeriod.effectiveFrom,
    retiredAt: null,
    state: 'ACTIVE',
  },
  meaningFingerprint: definition.meaningFingerprint,
  priceGroupRef,
});
const definitionRequest = Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
  priceGroupRef,
  trustedOperationAt,
});
const compatibilityRequest = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityRequestSchema)({
  expectedCurrent: {
    catalogRevision: 11,
    definitionRevisionId,
    definitionRevisionNumber: definition.revisionNumber,
    meaningFingerprint: definition.meaningFingerprint,
    priceGroupRef,
  },
  priceGroupRef,
  requiredContract,
  trustedOperationAt,
});
const definitionResponse = Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)({
  currentEvidence: {
    catalogRevision: 11,
    definitionEffectivePeriod: definition.effectivePeriod,
    definitionRevisionId,
    definitionRevisionNumber: definition.revisionNumber,
    meaningFingerprint: definition.meaningFingerprint,
    observedAt: trustedOperationAt,
    priceGroupRef,
  },
  definition,
  identity,
  observedAt: '2026-11-01T00:00:01.000Z',
  selection: 'CURRENT',
});
const retirementBoundary = definition.effectivePeriod.effectiveTo;
if (retirementBoundary === null) {
  throw new Error('The HTTP retirement-boundary fixture requires a bounded final definition');
}
const retiredDefinitionRequest = Schema.decodeUnknownSync(PriceGroupDefinitionRequestSchema)({
  priceGroupRef,
  trustedOperationAt: retirementBoundary,
});
const retiredDefinitionResponse = Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)({
  currentEvidence: {
    catalogRevision: 11,
    definitionEffectivePeriod: definition.effectivePeriod,
    definitionRevisionId,
    definitionRevisionNumber: definition.revisionNumber,
    meaningFingerprint: definition.meaningFingerprint,
    observedAt: retirementBoundary,
    priceGroupRef,
  },
  definition,
  identity: {
    ...identity,
    lifecycle: {
      activeFrom: identity.lifecycle.activeFrom,
      retiredAt: retirementBoundary,
      state: 'RETIRED',
    },
  },
  observedAt: '2027-01-01T00:00:01.000Z',
  selection: 'CURRENT',
});
const compatibilityResponse = Schema.decodeUnknownSync(ValidatePriceGroupCompatibilityResponseSchema)({
  evidence: {
    catalogRevision: 11,
    definitionEffectivePeriod: definition.effectivePeriod,
    definitionRevisionId,
    definitionRevisionNumber: definition.revisionNumber,
    meaningFingerprint: definition.meaningFingerprint,
    priceGroupRef,
    requiredContract,
    trustedOperationAt,
    verifiedAt: '2026-11-01T00:00:01.000Z',
  },
  kind: 'USABLE',
});

const ProblemDetailsSchema = Schema.Struct({
  _tag: Schema.String,
  detail: Schema.String,
  reasonCode: Schema.optionalKey(Schema.String),
  retryable: Schema.optionalKey(Schema.Boolean),
  status: Schema.Number,
  title: Schema.String,
  type: Schema.String,
});

type ReadFailure =
  | ReadCoreError
  | PriceGroupCurrentnessFailure
  | PriceGroupExpectedCurrentConflict
  | PriceGroupPersistenceUnavailable;

const makeAssertion = () =>
  Effect.gen(function* signPriceGroupReadAssertion() {
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'price-group-read-http-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'price-group-read-http-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('price-group-catalog')
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    return {
      environment: {
        ONTOS_GATEWAY_ISSUER: issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          keys: [publicJwk],
        }),
      },
      token,
    };
  });

const nonPersistingRedemption: GatewayAssertionRedemption = {
  consume: () => Effect.void,
};
const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());

const makeReadRuntime = (definitionResult: typeof PriceGroupDefinitionResponseSchema.Type = definitionResponse) => {
  let failure: ReadFailure | undefined;
  let reads = 0;
  // SAFETY: This test double exercises only runRead and selects schema-valid results by the exact
  // generated registration key. The production ReadRuntime still owns all generic constraints.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only generic runtime double; expires: 2027-03-31.
  const readRuntime = {
    runRead: ({ registration }: Parameters<ReadRuntimeService['runRead']>[0]) =>
      Effect.suspend(() => {
        reads += 1;
        if (failure !== undefined) {
          return Effect.fail(failure);
        }
        return Effect.succeed(
          registration.descriptor.readKey === 'pricing.price-group-catalog.api.price-group-definition'
            ? definitionResult
            : compatibilityResponse,
        );
      }),
  } as ReadRuntimeService;
  return {
    readCount: () => reads,
    readRuntime,
    setFailure: (nextFailure?: ReadFailure) => {
      failure = nextFailure;
    },
  };
};

const mountRuntime = (
  environment: Readonly<Record<string, string>>,
  readRuntime: ReadRuntimeService,
  redemption: GatewayAssertionRedemption = nonPersistingRedemption,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const api = HttpApi.make('PriceGroupCatalogApi')
        .add(priceGroupCatalogApi.groups.priceGroupDefinition)
        .add(priceGroupCatalogApi.groups.validatePriceGroupCompatibility);
      const readLayer = Layer.succeed(ReadRuntime, readRuntime);
      const redemptionLayer = Layer.succeed(GatewayAssertionRedemptionService, redemption);
      const handlers = Layer.mergeAll(priceGroupDefinitionReadApiLive, validatePriceGroupCompatibilityReadApiLive).pipe(
        Layer.provide(ActionPrincipalVerifierLive),
        Layer.provide(readLayer),
        Layer.provide(redemptionLayer),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
      );
      return HttpRouter.toWebHandler(
        HttpApiBuilder.layer(api).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(readLayer),
          Layer.provideMerge(redemptionLayer),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      );
    }),
    (runtime) => Effect.promise(() => runtime.dispose()).pipe(Effect.orDie),
  );

const endpoints = [
  {
    authenticationProblem: PriceGroupDefinitionAuthenticationProblemSchema,
    forbiddenProblem: PriceGroupDefinitionForbiddenProblemSchema,
    path: '/reads/price-group-definition',
    payload: definitionRequest,
    unavailableProblem: PriceGroupDefinitionUnavailableProblemSchema,
  },
  {
    authenticationProblem: ValidatePriceGroupCompatibilityAuthenticationProblemSchema,
    forbiddenProblem: ValidatePriceGroupCompatibilityForbiddenProblemSchema,
    path: '/reads/validate-price-group-compatibility',
    payload: compatibilityRequest,
    unavailableProblem: ValidatePriceGroupCompatibilityUnavailableProblemSchema,
  },
] as const;

const requestFor = (
  endpoint: (typeof endpoints)[number],
  token?: string,
  correlationId = `price-group-read-${randomUUID()}`,
) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-correlation-id': correlationId,
  });
  if (token !== undefined) {
    headers.set('authorization', `Bearer ${token}`);
  }
  return new Request(`${baseUrl}${endpoint.path}`, {
    body: JSON.stringify(endpoint.payload),
    headers,
    method: 'POST',
  });
};

const readProblem = Effect.fn('PriceGroupReadHttpTest.readProblem')(function* readProblem(response: Response) {
  expect(response.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
  return yield* Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProblemDetailsSchema)),
  );
});

const handle = (runtime: ReturnType<typeof HttpRouter.toWebHandler>, request: Request) =>
  runtime.handler(request, emptyRequestContext);

const expectSanitized = (problem: typeof ProblemDetailsSchema.Type, secrets: readonly string[]) => {
  const encoded = JSON.stringify(problem);
  for (const secret of secrets) {
    expect(encoded).not.toContain(secret);
  }
};

describe('Price Group governed Read HTTP integration', () => {
  it.effect('decodes both successful endpoints through their generated clients and assembled runtime', () =>
    Effect.gen(function* decodeSuccessfulReads() {
      const assertion = yield* makeAssertion();
      const harness = makeReadRuntime();
      const runtime = yield* mountRuntime(assertion.environment, harness.readRuntime);
      const inMemoryFetch: typeof globalThis.fetch = (input, init) => handle(runtime, new Request(input, init));
      const authorization = `Bearer ${assertion.token}`;

      const decodedDefinition = yield* executePriceGroupDefinitionWithAuthorization(
        definitionRequest,
        authorization,
        'price-group-definition-success',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, inMemoryFetch));
      const decodedCompatibility = yield* executeValidatePriceGroupCompatibilityWithAuthorization(
        compatibilityRequest,
        authorization,
        'price-group-compatibility-success',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, inMemoryFetch));

      expect(decodedDefinition).toEqual(definitionResponse);
      expect(Schema.is(PriceGroupDefinitionResponseSchema)(decodedDefinition)).toBe(true);
      expect(decodedCompatibility).toEqual(compatibilityResponse);
      expect(Schema.is(ValidatePriceGroupCompatibilityResponseSchema)(decodedCompatibility)).toBe(true);
      expect(harness.readCount()).toBe(2);
    }),
  );

  it.effect('encodes and decodes retired terminal Current at the exact boundary through the generated client', () =>
    Effect.gen(function* decodeRetiredBoundary() {
      const assertion = yield* makeAssertion();
      const harness = makeReadRuntime(retiredDefinitionResponse);
      const runtime = yield* mountRuntime(assertion.environment, harness.readRuntime);
      const inMemoryFetch: typeof globalThis.fetch = (input, init) => handle(runtime, new Request(input, init));

      const decoded = yield* executePriceGroupDefinitionWithAuthorization(
        retiredDefinitionRequest,
        `Bearer ${assertion.token}`,
        'price-group-definition-retired-boundary',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, inMemoryFetch));

      expect(decoded).toEqual(retiredDefinitionResponse);
      expect(decoded).toMatchObject({
        currentEvidence: { observedAt: retirementBoundary },
        definition: { definitionRevisionId },
        identity: { lifecycle: { retiredAt: retirementBoundary, state: 'RETIRED' } },
        selection: 'CURRENT',
      });
      expect(harness.readCount()).toBe(1);
    }),
  );

  it.effect('returns sanitized 401 and module-state 403/503 Problems for both generated Read servers', () =>
    Effect.gen(function* mapCoreReadFailures() {
      const assertion = yield* makeAssertion();
      const harness = makeReadRuntime();
      const runtime = yield* mountRuntime(assertion.environment, harness.readRuntime);
      const initialReadCount = harness.readCount();

      for (const endpoint of endpoints) {
        const readsBeforeAuthentication = harness.readCount();
        const unauthenticated = yield* Effect.promise(() => handle(runtime, requestFor(endpoint)));
        expect(unauthenticated.status).toBe(401);
        expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
        const authenticationProblem = yield* readProblem(unauthenticated);
        expect(Schema.is(endpoint.authenticationProblem)(authenticationProblem)).toBe(true);
        expect(authenticationProblem.status).toBe(401);
        expectSanitized(authenticationProblem, [principalId, tenantId]);
        expect(harness.readCount()).toBe(readsBeforeAuthentication);

        harness.setFailure(
          new ModuleStateDeniedError({
            code: 'module_state_denied',
            reason: 'private disabled-module state detail',
          }),
        );
        const disabled = yield* Effect.promise(() => handle(runtime, requestFor(endpoint, assertion.token)));
        expect(disabled.status).toBe(403);
        expect(disabled.headers.get('www-authenticate')).toBe(null);
        const forbiddenProblem = yield* readProblem(disabled);
        expect(Schema.is(endpoint.forbiddenProblem)(forbiddenProblem)).toBe(true);
        expect(forbiddenProblem.status).toBe(403);
        expectSanitized(forbiddenProblem, [
          'private disabled-module state detail',
          assertion.token,
          principalId,
          tenantId,
        ]);

        harness.setFailure(
          new ModuleStateCheckUnavailableError({
            code: 'module_state_check_unavailable',
            reason: 'private module-state database detail',
          }),
        );
        const unavailable = yield* Effect.promise(() => handle(runtime, requestFor(endpoint, assertion.token)));
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get('www-authenticate')).toBe(null);
        const unavailableProblem = yield* readProblem(unavailable);
        expect(Schema.is(endpoint.unavailableProblem)(unavailableProblem)).toBe(true);
        expect(unavailableProblem).toMatchObject({ retryable: true, status: 503 });
        expectSanitized(unavailableProblem, [
          'private module-state database detail',
          assertion.token,
          principalId,
          tenantId,
        ]);
      }
      expect(harness.readCount()).toBe(initialReadCount + 4);
    }),
  );

  it.effect('maps stale evidence, currentness, and owner outages to endpoint-declared sanitized domain Problems', () =>
    Effect.gen(function* mapDomainReadFailures() {
      const assertion = yield* makeAssertion();
      const harness = makeReadRuntime();
      const runtime = yield* mountRuntime(assertion.environment, harness.readRuntime);
      const [, compatibilityEndpoint] = endpoints;

      harness.setFailure(
        new PriceGroupExpectedCurrentConflict({
          code: 'price_group_expected_current_conflict',
          priceGroupRef,
          reason: 'private stale-evidence database detail',
        }),
      );
      const conflict = yield* Effect.promise(() => handle(runtime, requestFor(compatibilityEndpoint, assertion.token)));
      expect(conflict.status).toBe(409);
      const conflictProblem = yield* readProblem(conflict);
      const decodedConflictProblem = yield* Schema.decodeUnknownEffect(
        ValidatePriceGroupCompatibilityDomainConflictProblemSchema,
      )(conflictProblem);
      expect(decodedConflictProblem).toMatchObject({
        reasonCode: 'STALE_EXPECTED_EVIDENCE',
        status: 409,
      });
      expectSanitized(conflictProblem, [
        'private stale-evidence database detail',
        assertion.token,
        principalId,
        tenantId,
      ]);

      for (const endpoint of endpoints) {
        harness.setFailure(
          new PriceGroupCurrentnessFailure({
            candidateDefinitionRevisionIds: [definitionRevisionId],
            code: 'price_group_currentness_failure',
            priceGroupRef,
            reason: 'MULTIPLE_CURRENT_DEFINITIONS',
          }),
        );
        const currentness = yield* Effect.promise(() => handle(runtime, requestFor(endpoint, assertion.token)));
        expect(currentness.status).toBe(503);
        const currentnessProblem = yield* readProblem(currentness);
        const decodedCurrentnessProblem =
          endpoint.path === '/reads/price-group-definition'
            ? yield* Schema.decodeUnknownEffect(PriceGroupDefinitionDomainUnavailableProblemSchema)(currentnessProblem)
            : yield* Schema.decodeUnknownEffect(ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema)(
                currentnessProblem,
              );
        expect(decodedCurrentnessProblem).toMatchObject({
          reasonCode: 'MULTIPLE_CURRENT_DEFINITIONS',
          retryable: true,
          status: 503,
        });
        expectSanitized(currentnessProblem, [definitionRevisionId, assertion.token, principalId, tenantId]);

        harness.setFailure(
          new PriceGroupPersistenceUnavailable({
            code: 'price_group_persistence_unavailable',
            reason: 'private owner database host detail',
            retryable: true,
          }),
        );
        const ownerOutage = yield* Effect.promise(() => handle(runtime, requestFor(endpoint, assertion.token)));
        expect(ownerOutage.status).toBe(503);
        const outageProblem = yield* readProblem(ownerOutage);
        const decodedOutageProblem =
          endpoint.path === '/reads/price-group-definition'
            ? yield* Schema.decodeUnknownEffect(PriceGroupDefinitionDomainUnavailableProblemSchema)(outageProblem)
            : yield* Schema.decodeUnknownEffect(ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema)(
                outageProblem,
              );
        expect(decodedOutageProblem).toMatchObject({
          reasonCode: 'OWNER_UNAVAILABLE',
          retryable: true,
          status: 503,
        });
        expectSanitized(outageProblem, ['private owner database host detail', assertion.token, principalId, tenantId]);
      }
      expect(harness.readCount()).toBe(5);
    }),
  );

  it.effect('returns sanitized retryable 503 Problems when assertion redemption is unavailable', () =>
    Effect.gen(function* mapAuthenticationUnavailability() {
      const assertion = yield* makeAssertion();
      const harness = makeReadRuntime();
      const runtime = yield* mountRuntime(assertion.environment, harness.readRuntime, {
        consume: () =>
          Effect.fail(
            new GatewayAssertionRedemptionUnavailableError({
              reason: 'private assertion-redemption storage detail',
            }),
          ),
      });

      for (const endpoint of endpoints) {
        const response = yield* Effect.promise(() => handle(runtime, requestFor(endpoint, assertion.token)));
        expect(response.status).toBe(503);
        expect(response.headers.get('www-authenticate')).toBe(null);
        const problem = yield* readProblem(response);
        expect(Schema.is(endpoint.unavailableProblem)(problem)).toBe(true);
        expect(problem).toMatchObject({ retryable: true, status: 503 });
        expectSanitized(problem, [
          'private assertion-redemption storage detail',
          assertion.token,
          principalId,
          tenantId,
        ]);
      }
      expect(harness.readCount()).toBe(0);
    }),
  );
});
