import { DateTime, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AssortmentApplicableBoundaryQueryV1Schema,
  AssortmentOrdinaryCandidateQueryV1Schema,
} from '../../shared/domain/decision-set-query.ts';
import { AssortmentCandidateSchema } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentOrdinaryResolutionInputSchema,
  resolveAssortmentOrdinary,
} from '../../shared/domain/ordinary-resolution.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const at = DateTime.makeUnsafe(new Date('2026-09-28T09:00:00.000Z'));
const ref = (moduleId: string, resourceId: string, resourceType: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});
const trustedContext = {
  channelRef: ref('commerce.channel', 'channel-1', 'commerce.channel.channel'),
  operationTime: at,
  sellingLegalEntityRef: ref('party.registry', legalEntityId, 'party.registry.legal-entity'),
  tenantId,
};

it('accepts exact tenant, legal entity, and transaction time for a complete Boundary query', () => {
  expect(
    Schema.is(AssortmentApplicableBoundaryQueryV1Schema)({
      decisionPurpose: 'PURCHASE',
      kind: 'APPLICABLE_BOUNDARIES',
      legalEntityId,
      operationTime: at,
      subject: {
        kind: 'RETAIL_CUSTOMER_PROFILE',
        profileRef: ref('commerce.customer-context', 'profile-1', 'commerce.customer-context.retail-customer-profile'),
      },
      target: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'product-1', 'commerce.catalog.product') },
      tenantId,
      trustedContext,
      version: 1,
    }),
  ).toBe(true);
});

it('rejects Candidate queries that change the trusted operation instant', () => {
  expect(
    Schema.is(AssortmentOrdinaryCandidateQueryV1Schema)({
      decisionPurpose: 'PURCHASE',
      kind: 'ORDINARY_CANDIDATES',
      legalEntityId,
      operationTime: DateTime.makeUnsafe(new Date('2026-09-28T09:00:01.000Z')),
      subject: {
        kind: 'IDENTIFIED',
        subject: {
          kind: 'RETAIL_CUSTOMER_PROFILE',
          profileRef: ref(
            'commerce.customer-context',
            'profile-1',
            'commerce.customer-context.retail-customer-profile',
          ),
        },
      },
      target: { kind: 'PRODUCT', productRef: ref('commerce.catalog', 'product-1', 'commerce.catalog.product') },
      tenantId,
      trustedContext,
      version: 1,
    }),
  ).toBe(false);
});

it('rejects cross-tenant targets even when the trusted context itself is valid', () => {
  expect(
    Schema.is(AssortmentApplicableBoundaryQueryV1Schema)({
      decisionPurpose: 'PURCHASE',
      kind: 'APPLICABLE_BOUNDARIES',
      legalEntityId,
      operationTime: at,
      subject: {
        counterpartyRef: ref('party.registry', 'counterparty-1', 'party.registry.counterparty'),
        kind: 'COUNTERPARTY',
      },
      target: {
        kind: 'PRODUCT',
        productRef: {
          ...ref('commerce.catalog', 'product-1', 'commerce.catalog.product'),
          tenantId: '40000000-0000-4000-8000-000000000001',
        },
      },
      tenantId,
      trustedContext,
      version: 1,
    }),
  ).toBe(false);
});

for (const audienceKind of ['SHARED', 'COMMERCE_CUSTOMER_GROUP', 'SUBJECT'] as const) {
  it(`resolves a retained ${audienceKind} exact DENY over broader ALLOW without Stable Rule lifecycle precedence`, () => {
    const productRef = ref('commerce.catalog', 'product-1', 'catalog.product');
    const profileRef = ref(
      'commerce.customer-context',
      'profile-1',
      'commerce.customer-context.retail-customer-profile',
    );
    const groupRef = ref('commerce.customer-context', 'group-1', 'commerce.customer-context.customer-group');
    const subject = { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef } } as const;
    const query = Schema.decodeUnknownSync(Schema.toType(AssortmentOrdinaryCandidateQueryV1Schema))({
      decisionPurpose: 'VISIBILITY',
      kind: 'ORDINARY_CANDIDATES',
      legalEntityId,
      operationTime: at,
      subject,
      target: { kind: 'PRODUCT', productRef },
      tenantId,
      trustedContext,
      version: 1,
    });
    const commercialScope = {
      channelRef: trustedContext.channelRef,
      sellingLegalEntityRef: trustedContext.sellingLegalEntityRef,
    };
    const baseline = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
      audience: { kind: 'SHARED' },
      bindingRef: ref('commerce.assortment', 'broad-binding', 'commerce.assortment.applicability-binding'),
      commercialScope,
      decisionPurpose: 'VISIBILITY',
      effect: 'ALLOW',
      ruleRevision: {
        ownerModuleId: 'commerce.assortment',
        revision: '1',
        sourceRef: ref('commerce.assortment', 'broad-revision', 'commerce.assortment.rule-revision'),
      },
      selector: { kind: 'ALL' },
    });
    const audience = Match.value(audienceKind).pipe(
      Match.when('SHARED', () => ({ kind: 'SHARED' as const })),
      Match.when('COMMERCE_CUSTOMER_GROUP', () => ({ groupRef, kind: 'COMMERCE_CUSTOMER_GROUP' as const })),
      Match.when('SUBJECT', () => ({ kind: 'SUBJECT' as const, subject: subject.subject })),
      Match.exhaustive,
    );
    const retained = Schema.decodeUnknownSync(AssortmentCandidateSchema)({
      ...baseline,
      audience,
      bindingRef: ref('commerce.assortment', 'retained-binding', 'commerce.assortment.applicability-binding'),
      effect: 'DENY',
      ruleRevision: {
        ownerModuleId: 'commerce.assortment',
        revision: '1',
        sourceRef: ref('commerce.assortment', 'retained-revision', 'commerce.assortment.rule-revision'),
      },
      selector: { kind: 'PRODUCT', productRef },
      stableRuleRef: ref('commerce.assortment', 'retired-lineage', 'commerce.assortment.stable-rule'),
    });
    const proof = {
      evidenceRef: ref('commerce.assortment', 'fixture-complete-set', 'commerce.assortment.decision-set-proof'),
      ownerModuleId: 'commerce.assortment',
    };
    const resolve = (
      candidates: readonly (typeof baseline)[],
      membershipState: 'COMPLETE' | 'UNVERIFIABLE' = 'COMPLETE',
    ) =>
      resolveAssortmentOrdinary(
        Schema.decodeUnknownSync(Schema.toType(AssortmentOrdinaryResolutionInputSchema))({
          candidates,
          completeness: {
            evidence: {
              predicate: 'all current Candidate-producing bindings and immutable revisions for this exact decision',
              proof,
              scope: 'commerce.assortment.ordinary-candidates',
              state: 'COMPLETE',
            },
            scope: {
              commercialScope,
              decisionPurpose: query.decisionPurpose,
              kind: 'ORDINARY_CANDIDATES',
              operationTime: at,
              subject,
              target: query.target,
              tenantId,
            },
          },
          decisionPurpose: query.decisionPurpose,
          factCurrentness: candidates.flatMap((candidate) =>
            [candidate.bindingRef, candidate.ruleRevision.sourceRef].map((factRef) => ({
              factRef,
              proof,
              state: 'CURRENT',
            })),
          ),
          // Test-owned Membership proof demonstrates resolver semantics, not a production owner contract.
          memberships: {
            asOf: at,
            completeness: {
              predicate: 'all current customer-group memberships',
              proof: {
                evidenceRef: ref(
                  'commerce.customer-context',
                  'fixture-memberships',
                  'commerce.customer-context.membership-set-proof',
                ),
                ownerModuleId: 'commerce.customer-context',
              },
              scope: 'customer-context.memberships',
              state: membershipState,
            },
            items: [
              {
                effectiveFrom: DateTime.makeUnsafe('2026-01-01T00:00:00.000Z'),
                effectiveTo: null,
                groupRef,
                membershipRef: ref(
                  'commerce.customer-context',
                  'member-1',
                  'commerce.customer-context.customer-group-membership',
                ),
                profileRef,
                revision: '1',
                state: 'VALID',
              },
            ],
            profileRef,
          },
          subject,
          target: query.target,
          tenantId,
          trustedContext,
        }),
      );
    const beforeEnd = resolve([baseline, retained]);
    expect(beforeEnd).toMatchObject({
      evidence: { maximalCandidates: [retained] },
      kind: 'RESOLVED',
      outcome: 'INELIGIBLE',
    });
    expect(resolve([retained, baseline])).toMatchObject({
      evidence: { maximalCandidates: [retained] },
      kind: 'RESOLVED',
      outcome: 'INELIGIBLE',
    });
    expect(resolve([baseline])).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });
    if (audienceKind === 'COMMERCE_CUSTOMER_GROUP') {
      expect(resolve([baseline, retained], 'UNVERIFIABLE')).toEqual({
        kind: 'INDETERMINATE',
        reason: 'MEMBERSHIP_SET_INCOMPLETE',
      });
    }
  });
}
