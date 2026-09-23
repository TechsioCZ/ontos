import type { OperationalScope } from '@app/core-runtime';
import { ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import { ResolveCommerceMarketRequestSchema } from '../../shared/apis/resolve-commerce-market.ts';
import type { EligibleMarketTuple } from '../../shared/market-contracts.ts';
import { handleEligibleMarketTuples } from '../../src/api/eligible-market-tuples.read.ts';
import { handleResolveCommerceMarket } from '../../src/api/resolve-commerce-market.read.ts';
import type { MarketEligibilitySnapshot } from '../../src/domain/market-resolution.ts';
import { MarketResolutionPersistenceUnavailable } from '../../src/persistence/market-resolution-persistence.ts';
import type { MarketResolutionPersistence } from '../../src/persistence/market-resolution-persistence.ts';
import type {
  MarketSubjectRestrictionSnapshot,
  MarketSubjectRestrictionsReader,
} from '../../src/integrations/market-subject-restrictions.ts';
import { MarketSubjectRestrictionsUnavailable } from '../../src/integrations/market-subject-restrictions.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const sellerId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const profileId = '99999999-9999-4999-8999-999999999999';
const retailProfileId = '12121212-1212-4121-8121-121212121212';
const counterpartyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storefrontRef = { appId: 'shop', tenantId } as const;
const at = '2030-06-01T00:00:00.000Z';
const sellerRef = {
  moduleId: 'core.identity' as const,
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId,
};
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
  sellingLegalEntityRef: sellerRef,
};
const snapshot: MarketEligibilitySnapshot = {
  completenessEvidence: Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: at,
    ownerRevision: 'market-eligibility:v1:proof',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market-eligibility:v1:shop:B2B:seller' },
  }),
  effectiveAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(at),
  evaluatedAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:01.000Z',
  ),
  facts: [{ lifecycle: 'ACTIVE', tuple: eligibleTuple }],
};
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '77777777-7777-4777-8777-777777777777',
    authContextRef: 'session:market-resolution',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId,
    tenantId,
    trustedStorefrontId: storefrontRef.appId,
  }),
  correlationId: 'market-resolution-test',
};
const available: MarketResolutionPersistence = { load: () => Effect.succeed({ ...snapshot, generation: 7 }) };
const withSnapshot = (current: MarketEligibilitySnapshot, generation: number): MarketResolutionPersistence => ({
  load: () => Effect.succeed({ ...current, generation }),
});
const unavailable: MarketResolutionPersistence = {
  load: () =>
    Effect.fail(
      new MarketResolutionPersistenceUnavailable({
        code: 'market_resolution_persistence_unavailable',
        reason: 'fixture unavailable',
      }),
    ),
};
const ownerRestrictions: MarketSubjectRestrictionSnapshot = {
  allowedChannels: ['B2B'],
  allowedSellerIds: [sellerId],
  decision: 'ALLOWED',
  evidenceRefs: ['commerce-customer-context:counterparty-profile:revision:7'],
  observedAt: Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema.fields.effectiveAt)(
    '2030-06-01T00:00:00.500Z',
  ),
  ownerRevision: 'counterparty-profile:7',
  profileState: 'ACTIVE',
  subjectIdentityRef: profileId,
  subjectKind: 'COUNTERPARTY',
};
const reader = { current: () => Effect.succeed(ownerRestrictions) };
const context = (
  services: MarketResolutionPersistence,
  scopeOverride: OperationalScope = scope,
  subjectReader: MarketSubjectRestrictionsReader = reader,
) => ({
  readKey: 'commerce.market-catalog.api.resolve-commerce-market',
  scope: scopeOverride,
  services: { ...services, ...subjectReader },
});

const counterpartySubject = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: profileId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};

const retailSubject = {
  kind: 'RETAIL_PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: retailProfileId,
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId,
  },
};

describe('Commerce Market governed resolution reads', () => {
  it.effect('returns safe complete eligible tuples under trusted Storefront context', () =>
    Effect.gen(function* eligibleRead() {
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: sellerRef,
        storefrontRef,
      });
      const result = yield* handleEligibleMarketTuples(input, context(available));
      expect(result.result).toMatchObject({ outcome: 'ELIGIBLE_MARKET_TUPLES', tuples: [eligibleTuple] });
      if (result.result.outcome === 'ELIGIBLE_MARKET_TUPLES') {
        expect(DateTime.formatIso(result.result.effectiveAt)).toBe(at);
        expect(DateTime.formatIso(result.result.evaluatedAt)).toBe('2030-06-01T00:00:01.000Z');
      }
      expect(result.evidence.resultCount).toBe(1);
    }),
  );

  it.effect('fails closed when the Storefront differs from trusted operational context', () =>
    Effect.gen(function* deniedStorefront() {
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef: { ...storefrontRef, appId: 'untrusted-shop' },
      });
      const error = yield* Effect.flip(handleEligibleMarketTuples(input, context(available)));
      expect(Schema.is(ReadPermissionDenied)(error)).toBe(true);
    }),
  );

  it.effect('uses owner restrictions instead of treating trusted principal seller scope as authority', () =>
    Effect.gen(function* ownerRestrictedSeller() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: {
          ...sellerRef,
          resourceId: '88888888-8888-4888-8888-888888888888',
        },
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* handleResolveCommerceMarket(input, context(available));
      expect(result.result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL' });
    }),
  );

  it.effect('forwards fixed Retail seller restrictions into the authoritative eligibility predicate', () =>
    Effect.gen(function* retailRestrictions() {
      let receivedRestrictions: MarketSubjectRestrictionSnapshot | undefined;
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef,
        subject: retailSubject,
      });
      const retailSnapshot: MarketSubjectRestrictionSnapshot = {
        ...ownerRestrictions,
        allowedChannels: ['B2C'],
        evidenceRefs: ['commerce-customer-context:retail-profile:revision:4'],
        ownerRevision: 'retail-profile:4',
        subjectIdentityRef: retailProfileId,
        subjectKind: 'RETAIL_PROFILE',
      };
      const result = yield* handleResolveCommerceMarket(
        input,
        context(
          {
            load: (_request, restrictions) => {
              receivedRestrictions = restrictions;
              return Effect.succeed({
                ...snapshot,
                facts: [{ lifecycle: 'ACTIVE', tuple: { ...eligibleTuple, channel: 'B2C' } }],
                generation: 7,
              });
            },
          },
          scope,
          { current: () => Effect.succeed(retailSnapshot) },
        ),
      );

      expect(receivedRestrictions).toEqual(retailSnapshot);
      expect(result.result).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        subjectRestrictionEvidence: {
          ownerRevision: 'retail-profile:4',
          subjectKind: 'RETAIL_PROFILE',
        },
      });
    }),
  );

  it.effect('changes Counterparty eligibility when the owner changes the allowed seller set', () =>
    Effect.gen(function* changedCounterpartyRestriction() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const restrictionAwarePersistence: MarketResolutionPersistence = {
        load: (_request, restrictions) =>
          Effect.succeed({
            ...snapshot,
            completenessEvidence: {
              ...snapshot.completenessEvidence,
              ownerRevision: `market-eligibility:${restrictions?.ownerRevision ?? 'none'}`,
            },
            facts: snapshot.facts.filter(
              ({ tuple }) =>
                restrictions !== undefined &&
                restrictions.allowedSellerIds.includes(tuple.sellingLegalEntityRef.resourceId),
            ),
            generation: 7,
          }),
      };
      const before = yield* handleResolveCommerceMarket(input, context(restrictionAwarePersistence));
      const after = yield* handleResolveCommerceMarket(
        input,
        context(restrictionAwarePersistence, scope, {
          current: () =>
            Effect.succeed({
              ...ownerRestrictions,
              allowedSellerIds: ['88888888-8888-4888-8888-888888888888'],
              ownerRevision: 'counterparty-profile:8',
            }),
        }),
      );

      expect(before.result.outcome).toBe('MARKET_RESOLVED');
      expect(after.result).toMatchObject({ outcome: 'MARKET_NOT_ALLOWED_FOR_SUBJECT_OR_CHANNEL' });
    }),
  );

  it.effect('attaches only safe owner-issued subject restriction evidence', () =>
    Effect.gen(function* restrictedResolution() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        sellingLegalEntityRestriction: sellerRef,
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* handleResolveCommerceMarket(input, context(available));
      expect(result.result).toMatchObject({
        outcome: 'MARKET_RESOLVED',
        subjectRestrictionEvidence: {
          decision: 'ALLOWED',
          evidenceRefs: ['commerce-customer-context:counterparty-profile:revision:7'],
          ownerRevision: 'counterparty-profile:7',
          subjectKind: 'COUNTERPARTY',
        },
      });
      if (result.result.outcome === 'MARKET_RESOLVED') {
        expect(DateTime.formatIso(result.result.effectiveAt)).toBe(at);
        expect(DateTime.formatIso(result.result.evaluatedAt)).toBe('2030-06-01T00:00:01.000Z');
      }
      expect(JSON.stringify(result.result)).not.toContain(profileId);
    }),
  );

  it.effect(
    'returns retryable inability without querying Market persistence when subject ownership is unavailable',
    () =>
      Effect.gen(function* unavailableSubjectOwner() {
        let persistenceCalls = 0;
        const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
          channel: 'B2B',
          effectiveAt: at,
          storefrontRef,
          subject: counterpartySubject,
        });
        const result = yield* handleResolveCommerceMarket(
          input,
          context(
            {
              load: () => {
                persistenceCalls += 1;
                return Effect.succeed({ ...snapshot, generation: 7 });
              },
            },
            scope,
            {
              current: () =>
                Effect.fail(
                  new MarketSubjectRestrictionsUnavailable({
                    code: 'market_subject_restrictions_unavailable',
                    reason: 'owner unavailable',
                  }),
                ),
            },
          ),
        );
        expect(result.result).toEqual({
          outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
          reason: 'Current Commerce Market eligibility could not be established',
          retryable: true,
        });
        expect(persistenceCalls).toBe(0);
      }),
  );

  it.effect('fails eligible-set discovery closed when mandatory subject-owner state is unavailable', () =>
    Effect.gen(function* unavailableEligibleSubjectOwner() {
      let persistenceCalls = 0;
      const input = Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const result = yield* handleEligibleMarketTuples(
        input,
        context(
          {
            load: () => {
              persistenceCalls += 1;
              return Effect.succeed({ ...snapshot, generation: 7 });
            },
          },
          scope,
          {
            current: () =>
              Effect.fail(
                new MarketSubjectRestrictionsUnavailable({
                  code: 'market_subject_restrictions_unavailable',
                  reason: 'owner unavailable',
                }),
              ),
          },
        ),
      );

      expect(result.result).toEqual({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        reason: 'Current Commerce Market eligibility could not be established',
        retryable: true,
      });
      expect(persistenceCalls).toBe(0);
    }),
  );

  it.effect('invalidates completeness when the owner subject revision changes', () =>
    Effect.gen(function* changedSubjectRevision() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
        subject: counterpartySubject,
      });
      const ownerAwarePersistence: MarketResolutionPersistence = {
        load: (_request, restrictions) =>
          Effect.succeed({
            ...snapshot,
            completenessEvidence: {
              ...snapshot.completenessEvidence,
              ownerRevision: `market-eligibility:v2:${restrictions?.ownerRevision ?? 'none'}`,
            },
            generation: 7,
          }),
      };
      const before = yield* handleResolveCommerceMarket(input, context(ownerAwarePersistence));
      const after = yield* handleResolveCommerceMarket(
        input,
        context(ownerAwarePersistence, scope, {
          current: () => Effect.succeed({ ...ownerRestrictions, ownerRevision: 'counterparty-profile:8' }),
        }),
      );
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.completenessEvidence.ownerRevision).not.toBe(
          after.result.completenessEvidence.ownerRevision,
        );
      }
    }),
  );

  it.effect('returns a separate retryable inability when owner completeness cannot be established', () =>
    Effect.gen(function* unavailableResolution() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2C',
        effectiveAt: at,
        storefrontRef,
      });
      const result = yield* handleResolveCommerceMarket(input, context(unavailable));
      expect(result.result).toEqual({
        outcome: 'MARKET_ELIGIBILITY_UNAVAILABLE',
        reason: 'Current Commerce Market eligibility could not be established',
        retryable: true,
      });
    }),
  );

  it.effect('invalidates prior completeness after a material lifecycle or association revision changes', () =>
    Effect.gen(function* invalidatedCompleteness() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
      });
      const changedSnapshot: MarketEligibilitySnapshot = {
        ...snapshot,
        completenessEvidence: {
          ...snapshot.completenessEvidence,
          ownerRevision: 'market-eligibility:v1:changed-material-state',
        },
      };
      const before = yield* handleResolveCommerceMarket(input, context(withSnapshot(snapshot, 7)));
      const after = yield* handleResolveCommerceMarket(input, context(withSnapshot(changedSnapshot, 8)));
      expect(before.result.outcome).toBe('MARKET_RESOLVED');
      expect(after.result.outcome).toBe('MARKET_RESOLVED');
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.selectedTuple.marketRef).toEqual(after.result.selectedTuple.marketRef);
        expect(before.result.completenessEvidence.ownerRevision).not.toBe(
          after.result.completenessEvidence.ownerRevision,
        );
      }
    }),
  );

  it.effect('keeps exact predicate completeness stable across an unrelated tenant generation change', () =>
    Effect.gen(function* stableExactPredicate() {
      const input = Schema.decodeUnknownSync(ResolveCommerceMarketRequestSchema)({
        channel: 'B2B',
        effectiveAt: at,
        storefrontRef,
      });
      const before = yield* handleResolveCommerceMarket(input, context(withSnapshot(snapshot, 7)));
      const after = yield* handleResolveCommerceMarket(input, context(withSnapshot(snapshot, 99)));
      if (before.result.outcome === 'MARKET_RESOLVED' && after.result.outcome === 'MARKET_RESOLVED') {
        expect(before.result.completenessEvidence.ownerRevision).toBe(after.result.completenessEvidence.ownerRevision);
      }
    }),
  );
});
