import type { OperationalScope } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { EligibleMarketTuplesRequestSchema } from '../../shared/apis/eligible-market-tuples.ts';
import { VerifyMarketEligibilityV1RequestSchema } from '../../shared/apis/verify-market-eligibility-v1.ts';
import type { EligibleMarketTuple } from '../../shared/market-contracts.ts';
import type { MarketEligibilityFact, MarketEligibilitySnapshot } from '../../src/domain/market-resolution.ts';
import type { MarketResolutionPersistence } from '../../src/persistence/market-resolution-persistence.ts';
import { MarketResolutionPersistenceUnavailable } from '../../src/persistence/market-resolution-persistence.ts';
import type { MarketSubjectRestrictionSnapshot } from '../../src/integrations/market-subject-restrictions.ts';
import { handleVerifyMarketEligibilityV1 } from '../../src/api/verify-market-eligibility-v1.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const subjectId = '99999999-9999-4999-8999-999999999999';
const sellerId = '22222222-2222-4222-8222-222222222222';
const at = '2030-06-01T00:00:00.000Z';
const storefrontRef = { appId: 'shop', tenantId } as const;
const instant = (value: string) =>
  Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema.fields.effectiveAt)(value);
const subject = {
  counterpartyRef: {
    moduleId: 'party.registry' as const,
    resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    resourceType: 'party.registry.counterparty' as const,
    tenantId,
  },
  kind: 'COUNTERPARTY' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: subjectId,
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile' as const,
    tenantId,
  },
};
const ownerRestrictions = (ownerRevision: string): MarketSubjectRestrictionSnapshot => ({
  allowedChannels: ['B2B'],
  allowedSellerIds: [sellerId],
  decision: 'ALLOWED',
  evidenceRefs: ['ccc:market-restrictions:proof'],
  observedAt: instant(at),
  ownerRevision,
  profileState: 'ACTIVE',
  subjectIdentityRef: subjectId,
  subjectKind: 'COUNTERPARTY',
});
const request = (effectiveAt = at, includeSubject = false) => {
  const requestBase = {
    channel: 'B2B',
    effectiveAt,
    storefrontRef,
  };
  return Schema.decodeUnknownSync(EligibleMarketTuplesRequestSchema)(
    includeSubject ? { ...requestBase, subject } : requestBase,
  );
};
const proof = (effectiveAt: string, revision = 'owner-revision-1', ownerRevision?: string) =>
  Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
    observedAt: at,
    ownerRevision: ownerRevision ?? revision,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `market-eligibility:v1:${tenantId}:shop:B2B:${effectiveAt}:all-sellers:guest-or-unrestricted:none:none`,
    },
  });
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '77777777-7777-4777-8777-777777777777',
    authContextRef: 'session:market-proof',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId: '33333333-3333-4333-8333-333333333333',
    tenantId,
    trustedStorefrontId: storefrontRef.appId,
  }),
  correlationId: 'market-proof-verification',
};
const eligibleTuple: EligibleMarketTuple = {
  associationRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: '44444444-4444-4444-8444-444444444444',
    resourceType: 'commerce.market-catalog.storefront-association',
    tenantId,
  },
  associationRevision: 1,
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
const eligibleFact: MarketEligibilityFact = { lifecycle: 'ACTIVE', tuple: eligibleTuple };
const snapshotFor = (
  effectiveAt: string,
  options: { readonly factCount?: number; readonly revision?: string; readonly subjectRevision?: string } = {},
): MarketEligibilitySnapshot & { readonly generation: number } => {
  const { subjectRevision } = options;
  const ownerRevision =
    subjectRevision === undefined ? (options.revision ?? 'owner-revision-1') : `subject:${subjectRevision}`;
  return {
    completenessEvidence: proof(effectiveAt, options.revision, ownerRevision),
    effectiveAt: instant(effectiveAt),
    evaluatedAt: instant('2030-06-01T00:00:01.000Z'),
    facts: Array.from({ length: options.factCount ?? 0 }, () => eligibleFact),
    generation: 1,
  };
};
const run = (
  input: ReturnType<typeof request>,
  observedProof: ReturnType<typeof proof>,
  current: ReturnType<typeof snapshotFor>,
  restrictions?: MarketSubjectRestrictionSnapshot,
  persistenceUnavailable = false,
) => {
  const persistence: MarketResolutionPersistence = {
    load: () =>
      persistenceUnavailable
        ? Effect.fail(
            new MarketResolutionPersistenceUnavailable({
              code: 'market_resolution_persistence_unavailable',
              reason: 'fixture unavailable',
            }),
          )
        : Effect.succeed(current),
  };
  const reader = {
    current: () => Effect.succeed(restrictions ?? ownerRestrictions('subject:1')),
  };
  return handleVerifyMarketEligibilityV1(
    { observedProof, originalRequest: input },
    {
      readKey: 'commerce.market-catalog.api.verify-market-eligibility-v1',
      scope,
      services: { ...persistence, ...reader },
    },
  );
};

describe('verify market eligibility owner read', () => {
  it('accepts only the eligible-tuples predicate being verified', () => {
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(VerifyMarketEligibilityV1RequestSchema, { onExcessProperty: 'error' })({
          observedProof: proof(at),
          originalRequest: { ...request(), explicitSelection: { marketRef: eligibleTuple.marketRef } },
        }),
      ),
    ).toBe(true);
  });

  it.effect('verifies a complete empty set as CURRENT', () =>
    Effect.gen(function* verifyEmpty() {
      const result = yield* run(request(), proof(at), snapshotFor(at));
      expect(result.result.state).toBe('CURRENT');
    }),
  );

  it.effect('verifies a complete nonempty set as CURRENT', () =>
    Effect.gen(function* verifyNonempty() {
      const result = yield* run(request(), proof(at), snapshotFor(at, { factCount: 1 }));
      expect(result.result.state).toBe('CURRENT');
    }),
  );

  it.effect('returns STALE after a new matching association changes the owner revision', () =>
    Effect.gen(function* verifyAssociationChange() {
      const result = yield* run(request(), proof(at), snapshotFor(at, { factCount: 1, revision: 'owner-revision-2' }));
      expect(result.result.state).toBe('STALE');
    }),
  );

  it.effect('returns STALE when fresh subject restrictions change the owner revision', () =>
    Effect.gen(function* verifySubjectChange() {
      const originalProof = proof(at, undefined, 'subject:1');
      const result = yield* run(
        request(at, true),
        originalProof,
        snapshotFor(at, { subjectRevision: 'subject:2' }),
        ownerRestrictions('subject:2'),
      );
      expect(result.result.state).toBe('STALE');
    }),
  );

  it.effect('does not verify a proof for another effective instant as CURRENT', () =>
    Effect.gen(function* verifyEffectiveAtChange() {
      const otherEffectiveAt = '2030-07-01T00:00:00.000Z';
      const result = yield* run(request(otherEffectiveAt), proof(at), snapshotFor(otherEffectiveAt));
      expect(result.result.state).toBe('STALE');
    }),
  );

  it.effect('returns STALE once the observed proof reaches its effective-time boundary', () =>
    Effect.gen(function* verifyBoundary() {
      const observedProof = Schema.decodeUnknownSync(OwnerVerifiableSetCompletenessEvidenceSchema)({
        nextApplicabilityBoundary: '2030-06-02T00:00:00.000Z',
        observedAt: at,
        ownerRevision: 'owner-revision-1',
        scope: proof(at).scope,
      });
      const current = {
        ...snapshotFor(at),
        evaluatedAt: instant('2030-06-02T00:00:00.000Z'),
      };
      const result = yield* run(request(), observedProof, current);
      expect(result.result.state).toBe('STALE');
    }),
  );

  it.effect('returns UNAVAILABLE when the owner snapshot cannot be read', () =>
    Effect.gen(function* verifyUnavailable() {
      const result = yield* run(request(), proof(at), snapshotFor(at), undefined, true);
      expect(result.result.state).toBe('UNAVAILABLE');
    }),
  );
});
