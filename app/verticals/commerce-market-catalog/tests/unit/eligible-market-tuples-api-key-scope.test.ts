import { NodeCrypto } from '@effect/platform-node';
import type { OperationalScope } from '@app/core-runtime';
import {
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import type { EligibleMarketTuplesRequest } from '../../shared/apis/eligible-market-tuples.ts';
import type { EligibleMarketTuple } from '../../shared/market-contracts.ts';
import { handleEligibleMarketTuples, prepareEligibleMarketTuples } from '../../src/api/eligible-market-tuples.read.ts';
import type { MarketEligibilitySnapshot } from '../../src/domain/market-resolution.ts';
import type { MarketResolutionPersistence } from '../../src/persistence/market-resolution-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '99999999-9999-4999-8999-999999999999';
const sellerId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const compositionRevision = 'd'.repeat(64);
const storefrontRef = { appId: 'shop', tenantId } as const;
const at = '2030-06-01T00:00:00.000Z';

const eligibleTuple: EligibleMarketTuple = {
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: 4,
  channel: 'B2B',
  marketDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '55555555-5555-4555-8555-555555555555',
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  marketRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '66666666-6666-4666-8666-666666666666',
    resourceType: 'commerce.market-catalog.market',
    tenantId,
  },
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: sellerId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
};
const snapshot: MarketEligibilitySnapshot = {
  completenessEvidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: at,
    ownerRevision: 'market-eligibility:v1:proof',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-eligibility:v1:shop:B2B:seller' },
  }),
  effectiveAt: Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema.fields.effectiveAt)(at),
  evaluatedAt: Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:01.000Z',
  ),
  facts: [{ lifecycle: 'ACTIVE', tuple: eligibleTuple }],
};
const available: MarketResolutionPersistence = { load: () => Effect.succeed({ ...snapshot, generation: 7 }) };
const subjectReader = {
  current: () => Effect.die('The subject restriction reader must not be reached without a subject'),
};

interface PrincipalFields {
  readonly authBindingId?: string;
  readonly impersonatedByPrincipalId?: string;
  readonly legalEntityId?: string;
  readonly trustedStorefrontId?: string;
}

const decodePrincipal = (principal: PrincipalFields, authContextRef: string, authMethod: string) =>
  Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef,
    authMethod,
    principalId,
    tenantId,
    ...principal,
  });

const makeScope = (principal: PrincipalFields, authContextRef: string, authMethod: string): OperationalScope => ({
  ...decodePrincipal(principal, authContextRef, authMethod),
  correlationId: 'eligible-market-tuples-scope-test',
});

// The Shell verifies a delegated module call: the subject is the human the work is for, the actor is the module.
const makeDelegatedScope = (principal: PrincipalFields, authContextRef: string, authMethod: string): OperationalScope =>
  trustVerifiedGatewayPrincipalContext(
    { ...decodePrincipal(principal, authContextRef, authMethod), correlationId: 'eligible-market-tuples-delegated' },
    compositionRevision,
    undefined,
    {
      appId: 'commerce-customer-context',
      buildMarker: 'commerce-customer-context-build',
      principalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  );

const sessionPrincipal = {
  authBindingId: '88888888-8888-4888-8888-888888888888',
  legalEntityId: sellerId,
};
const delegatedWithoutStorefront = makeDelegatedScope(
  sessionPrincipal,
  'session:eligible-market-tuples-delegated',
  'session',
);
const apiKeyWithoutStorefront = makeScope(
  { authBindingId: '77777777-7777-4777-8777-777777777777', legalEntityId: sellerId },
  'api-key:eligible-market-tuples',
  'api_key',
);

const request = (overrides: Partial<typeof EligibleMarketTuplesRequestSchema.Encoded> = {}) =>
  Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
    channel: 'B2B',
    effectiveAt: at,
    storefrontRef,
    ...overrides,
  });

/** prepare (trusted scope, Customer Context restrictions) then load (the owner snapshot), as the runtime runs them. */
const eligibleMarketTuples = (input: EligibleMarketTuplesRequest, scope: OperationalScope) => {
  const steps = { readKey: 'commerce.market-catalog.api.eligible-market-tuples', scope, services: available };
  return prepareEligibleMarketTuples(input, steps, subjectReader).pipe(
    Effect.flatMap((prepared) => handleEligibleMarketTuples(input, { ...steps, prepared })),
    Effect.provide(NodeCrypto.layer),
  );
};

describe('Commerce Market eligible tuples delegated module callers without a Storefront', () => {
  it.effect('admits a verified module actor that carries no trusted Storefront', () =>
    Effect.gen(function* admitsDelegatedActor() {
      expect(delegatedWithoutStorefront.trustedStorefrontId).toBeUndefined();
      const result = yield* eligibleMarketTuples(request(), delegatedWithoutStorefront);
      expect(result.result).toMatchObject({ outcome: 'ELIGIBLE_MARKET_TUPLES', tuples: [eligibleTuple] });
      expect(result.evidence.resultCount).toBe(1);
    }),
  );

  it.effect('denies a call without a verified module actor and no trusted Storefront', () =>
    Effect.gen(function* deniesWithoutActor() {
      const sessionScope = makeScope(sessionPrincipal, 'session:eligible-market-tuples', 'session');
      const sessionError = yield* Effect.flip(eligibleMarketTuples(request(), sessionScope));
      expect(Schema.is(ReadPermissionDenied)(sessionError)).toBe(true);

      const apiKeyError = yield* Effect.flip(eligibleMarketTuples(request(), apiKeyWithoutStorefront));
      expect(Schema.is(ReadPermissionDenied)(apiKeyError)).toBe(true);
    }),
  );

  it.effect('still binds a caller that carries a trusted Storefront to that Storefront', () =>
    Effect.gen(function* boundCaller() {
      const scope = makeDelegatedScope(
        { ...sessionPrincipal, trustedStorefrontId: storefrontRef.appId },
        'session:eligible-market-tuples-bound',
        'session',
      );
      const admitted = yield* eligibleMarketTuples(request(), scope);
      expect(admitted.result.outcome).toBe('ELIGIBLE_MARKET_TUPLES');

      const error = yield* Effect.flip(
        eligibleMarketTuples(request({ storefrontRef: { ...storefrontRef, appId: 'untrusted-shop' } }), scope),
      );
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a module actor whose requested Storefront belongs to another Tenant', () =>
    Effect.gen(function* crossTenantStorefront() {
      const error = yield* Effect.flip(
        eligibleMarketTuples(
          request({ storefrontRef: { appId: storefrontRef.appId, tenantId: otherTenantId } }),
          delegatedWithoutStorefront,
        ),
      );
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a module actor whose seller restriction belongs to another Tenant', () =>
    Effect.gen(function* crossTenantSeller() {
      const error = yield* Effect.flip(
        eligibleMarketTuples(
          request({
            sellingLegalEntityRestriction: { ...eligibleTuple.sellingLegalEntityRef, tenantId: otherTenantId },
          }),
          delegatedWithoutStorefront,
        ),
      );
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a module actor whose purchasing subject belongs to another Tenant', () =>
    Effect.gen(function* crossTenantSubject() {
      const error = yield* Effect.flip(
        eligibleMarketTuples(
          request({
            subject: {
              kind: 'RETAIL_PROFILE',
              profileRef: {
                moduleId: 'commerce.customer-context',
                resourceId: '12121212-1212-4121-8121-121212121212',
                resourceType: 'commerce.customer-context.retail-customer-profile',
                tenantId: otherTenantId,
              },
            },
          }),
          delegatedWithoutStorefront,
        ),
      );
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a session caller without a trusted Storefront', () =>
    Effect.gen(function* sessionWithoutStorefront() {
      const scope = makeScope(sessionPrincipal, 'session:eligible-market-tuples', 'session');
      expect(scope.trustedStorefrontId).toBeUndefined();
      const error = yield* Effect.flip(eligibleMarketTuples(request(), scope));
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a support impersonation caller without a trusted Storefront', () =>
    Effect.gen(function* impersonationWithoutStorefront() {
      const scope = makeScope(
        {
          ...sessionPrincipal,
          impersonatedByPrincipalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
        'impersonation:eligible-market-tuples',
        'support_impersonation',
      );
      const error = yield* Effect.flip(eligibleMarketTuples(request(), scope));
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('rejects a system caller without a trusted Storefront', () =>
    Effect.gen(function* systemWithoutStorefront() {
      const scope = makeScope({}, 'job:eligible-market-tuples:run:1', 'system');
      const error = yield* Effect.flip(eligibleMarketTuples(request(), scope));
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );
});
