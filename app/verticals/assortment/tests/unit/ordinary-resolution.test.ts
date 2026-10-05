import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import { adaptCommerceCustomerGroupMemberships } from '../../src/adapters/commerce-customer-group-memberships.ts';
import {
  AssortmentCommerceMembershipPredicate,
  AssortmentCommerceMembershipScopeTokenSchema,
  AssortmentCustomerGroupMembershipRequestSchema,
  AssortmentCustomerGroupMembershipSetSchema,
  AssortmentSetCompletenessRequestSchema,
} from '../../shared/domain/ports/owner-evidence.ts';
import { AssortmentCandidateSchema, AssortmentOwnerResourceRefSchema } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentOrdinaryResolutionInputSchema,
  resolveAssortmentOrdinary,
} from '../../shared/domain/ordinary-resolution.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';
const operationTime = '2026-09-22T10:00:00.000Z';

const ref = (moduleId: string, resourceType: string, resourceId: string, nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: nextTenantId,
  });

const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const categoryRef = (resourceId: string) => ref('catalog.owner', 'catalog.category', resourceId);
const channelRef = ref('commerce.channel', 'commerce.channel', 'web');
const sellingLegalEntityRef = ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1');
const profileRef = ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');
const subject = { kind: 'RETAIL_CUSTOMER_PROFILE' as const, profileRef };
const groupRef = (resourceId: string) =>
  ref('commerce.customer-context', 'commerce.customer-context.customer-group', resourceId);
const membershipRef = (resourceId: string) =>
  ref('commerce.customer-context', 'commerce.customer-context.customer-group-membership', resourceId);

interface ContextFixture {
  readonly channelRef: ReturnType<typeof ref>;
  readonly commerceMarketRef?: ReturnType<typeof ref>;
  readonly operationTime: string;
  readonly sellingLegalEntityRef: ReturnType<typeof ref>;
  readonly storefrontRef?: ReturnType<typeof ref>;
  readonly tenantId: string;
}
interface CommercialScopeFixture {
  channelRef: ReturnType<typeof ref>;
  commerceMarketRef?: ReturnType<typeof ref>;
  sellingLegalEntityRef: ReturnType<typeof ref>;
  storefrontRef?: ReturnType<typeof ref>;
}

const trustedContext: ContextFixture = {
  channelRef,
  operationTime,
  sellingLegalEntityRef,
  tenantId,
};

const completenessEvidence = {
  predicate: 'all current Candidate-producing bindings and immutable revisions for this exact decision',
  proof: {
    evidenceRef: ref('commerce.assortment', 'commerce.assortment.candidate-set-proof', 'candidate-proof-1'),
    ownerModuleId: 'commerce.assortment',
  },
  scope: 'commerce.assortment.ordinary-candidates',
  state: 'COMPLETE' as const,
};

const categoryCompleteness = {
  predicate: 'all current Catalog classifications and ancestry for the exact product',
  proof: {
    evidenceRef: ref('catalog.owner', 'catalog.category-classification-proof', 'category-proof-1'),
    ownerModuleId: 'catalog.owner',
  },
  scope: 'catalog.category-classification',
  state: 'COMPLETE' as const,
};

const subjectInput = { kind: 'IDENTIFIED' as const, subject };

interface CandidateOverrides {
  readonly audience?: unknown;
  readonly bindingRef?: unknown;
  readonly commercialScope?: unknown;
  readonly decisionPurpose?: unknown;
  readonly effect?: unknown;
  readonly ruleRevision?: unknown;
  readonly selector?: unknown;
}

const candidate = (overrides: CandidateOverrides = {}) =>
  Schema.decodeUnknownSync(AssortmentCandidateSchema)({
    audience: { kind: 'SHARED' as const },
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-default'),
    commercialScope: { channelRef, sellingLegalEntityRef },
    decisionPurpose: 'VISIBILITY' as const,
    effect: 'ALLOW' as const,
    ruleRevision: {
      ownerModuleId: 'commerce.assortment' as const,
      revision: 'r1',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-default'),
    },
    selector: { kind: 'ALL' as const },
    ...overrides,
  });

const factCurrentness = (candidates: readonly ReturnType<typeof candidate>[]) =>
  candidates.flatMap((item) =>
    [item.bindingRef, item.ruleRevision.sourceRef].map((factRef, index) => ({
      factRef,
      proof: {
        evidenceRef: ref(
          'commerce.assortment',
          'commerce.assortment.currentness-proof',
          `current-${index}-${factRef.resourceId}`,
        ),
        ownerModuleId: 'commerce.assortment',
      },
      state: 'CURRENT' as const,
    })),
  );

const categoryClassification = (
  classifications: readonly ReturnType<typeof categoryRef>[],
  ancestries: readonly {
    readonly ancestors: readonly ReturnType<typeof ref>[];
    readonly categoryRef: ReturnType<typeof ref>;
  }[] = [],
) => ({
  ancestries,
  classifications,
  completeness: categoryCompleteness,
  currentness: [],
  productRef,
});

const memberships = (groups: readonly string[], state: 'COMPLETE' | 'STALE' = 'COMPLETE') => ({
  asOf: operationTime,
  completeness: {
    predicate: 'all current customer-group memberships',
    proof: {
      evidenceRef: ref('commerce.customer-context', 'commerce.customer-context.membership-proof', 'membership-proof-1'),
      ownerModuleId: 'commerce.customer-context',
    },
    scope: 'customer-context.memberships',
    state,
  },
  items: groups.map((group, index) => ({
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    groupRef: groupRef(group),
    membershipRef: membershipRef(`membership-${index}`),
    profileRef,
    revision: `membership-r${index + 1}`,
    state: 'VALID' as const,
  })),
  profileRef,
});

const input = (
  candidates: readonly ReturnType<typeof candidate>[],
  overrides: {
    readonly categoryClassification?: unknown;
    readonly completeness?: unknown;
    readonly decisionPurpose?: 'PURCHASE' | 'VISIBILITY';
    readonly factCurrentness?: unknown;
    readonly memberships?: unknown;
    readonly subject?: unknown;
    readonly target?: unknown;
    readonly tenantId?: string;
    readonly trustedContext?: {
      readonly channelRef: ReturnType<typeof ref>;
      readonly commerceMarketRef?: ReturnType<typeof ref>;
      readonly operationTime: string;
      readonly sellingLegalEntityRef: ReturnType<typeof ref>;
      readonly storefrontRef?: ReturnType<typeof ref>;
      readonly tenantId: string;
    };
  } = {},
) =>
  (() => {
    const decisionPurpose = overrides.decisionPurpose ?? 'VISIBILITY';
    const target = overrides.target ?? { kind: 'PRODUCT' as const, productRef };
    const decisionSubject = overrides.subject ?? subjectInput;
    const context = overrides.trustedContext ?? trustedContext;
    const commercialScope: CommercialScopeFixture = {
      channelRef: context.channelRef,
      sellingLegalEntityRef: context.sellingLegalEntityRef,
    };
    if (context.commerceMarketRef !== undefined) {
      commercialScope.commerceMarketRef = context.commerceMarketRef;
    }
    if (context.storefrontRef !== undefined) {
      commercialScope.storefrontRef = context.storefrontRef;
    }
    const completeness = overrides.completeness ?? {
      evidence: completenessEvidence,
      scope: {
        commercialScope,
        decisionPurpose,
        kind: 'ORDINARY_CANDIDATES' as const,
        operationTime: context.operationTime,
        subject: decisionSubject,
        target,
        tenantId,
      },
    };
    return Schema.decodeUnknownSync(AssortmentOrdinaryResolutionInputSchema)({
      candidates,
      completeness,
      decisionPurpose,
      factCurrentness: factCurrentness(candidates),
      subject: decisionSubject,
      target,
      tenantId,
      trustedContext: context,
      ...overrides,
    });
  })();

it('distinguishes a complete empty set from an incomplete set', () => {
  expect(resolveAssortmentOrdinary(input([]))).toMatchObject({ kind: 'MISSING_CONFIGURATION' });
  expect(
    resolveAssortmentOrdinary(
      input([], {
        completeness: {
          evidence: { ...completenessEvidence, state: 'STALE' },
          scope: {
            commercialScope: { channelRef, sellingLegalEntityRef },
            decisionPurpose: 'VISIBILITY',
            kind: 'ORDINARY_CANDIDATES',
            operationTime,
            subject: subjectInput,
            target: { kind: 'PRODUCT', productRef },
            tenantId,
          },
        },
      }),
    ),
  ).toEqual({ kind: 'INDETERMINATE', reason: 'CANDIDATE_SET_INCOMPLETE' });
});

it('resolves ALLOW and DENY, including catalog and audience specificity', () => {
  const broad = candidate({ effect: 'DENY' });
  const product = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-product'),
    effect: 'ALLOW',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-product',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-product'),
    },
    selector: { kind: 'PRODUCT', productRef },
  });
  const result = resolveAssortmentOrdinary(input([broad, product]));
  expect(result).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });
  if (result.kind === 'RESOLVED') {
    expect(result.evidence.maximalCandidates).toHaveLength(1);
    expect(result.evidence.maximalCandidates[0]?.selector.kind).toBe('PRODUCT');
  }

  const shared = candidate({ effect: 'DENY' });
  const subjectCandidate = candidate({
    audience: { kind: 'SUBJECT', subject },
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-subject'),
    effect: 'ALLOW',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-subject',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-subject'),
    },
  });
  expect(resolveAssortmentOrdinary(input([shared, subjectCandidate]))).toMatchObject({
    kind: 'RESOLVED',
    outcome: 'ELIGIBLE',
  });
});

it('keeps unrelated Categories incomparable and makes descendants beat ancestors', () => {
  const ancestor = categoryRef('category-parent');
  const descendant = categoryRef('category-child');
  const unrelated = categoryRef('category-unrelated');
  const ancestorCandidate = candidate({
    effect: 'DENY',
    selector: { categoryRef: ancestor, kind: 'CATEGORY' },
  });
  const descendantCandidate = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-child'),
    effect: 'ALLOW',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-child',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-child'),
    },
    selector: { categoryRef: descendant, kind: 'CATEGORY' },
  });
  const classification = categoryClassification([descendant], [{ ancestors: [ancestor], categoryRef: descendant }]);
  expect(
    resolveAssortmentOrdinary(
      input([ancestorCandidate, descendantCandidate], { categoryClassification: classification }),
    ),
  ).toMatchObject({
    kind: 'RESOLVED',
    outcome: 'ELIGIBLE',
  });

  const unrelatedCandidate = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-unrelated'),
    effect: 'DENY',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-unrelated',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-unrelated'),
    },
    selector: { categoryRef: unrelated, kind: 'CATEGORY' },
  });
  const unrelatedClassification = categoryClassification([descendant, unrelated]);
  const conflict = resolveAssortmentOrdinary(
    input([descendantCandidate, unrelatedCandidate], { categoryClassification: unrelatedClassification }),
  );
  expect(conflict).toMatchObject({ kind: 'CONFIGURATION_CONFLICT' });
});

it('uses lexicographic axes and stops at a higher-axis incomparability', () => {
  const market = ref('commerce.market', 'commerce.market', 'cz');
  const context = { ...trustedContext, commerceMarketRef: market };
  const categoryA = categoryRef('category-lex-a');
  const categoryB = categoryRef('category-lex-b');
  const broadAllow = candidate({
    effect: 'ALLOW',
    selector: { categoryRef: categoryA, kind: 'CATEGORY' },
  });
  const narrowDeny = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-lex-narrow'),
    commercialScope: { channelRef, commerceMarketRef: market, sellingLegalEntityRef },
    effect: 'DENY',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-lex-narrow',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-lex-narrow'),
    },
    selector: { kind: 'ALL' },
  });
  const inputOverrides = {
    categoryClassification: categoryClassification([categoryA]),
    completeness: {
      evidence: completenessEvidence,
      scope: {
        commercialScope: { channelRef, commerceMarketRef: market, sellingLegalEntityRef },
        decisionPurpose: 'VISIBILITY' as const,
        kind: 'ORDINARY_CANDIDATES' as const,
        operationTime,
        subject: subjectInput,
        target: { kind: 'PRODUCT' as const, productRef },
        tenantId,
      },
    },
    trustedContext: context,
  };
  expect(resolveAssortmentOrdinary(input([broadAllow, narrowDeny], inputOverrides))).toMatchObject({
    kind: 'RESOLVED',
    outcome: 'ELIGIBLE',
  });

  const incomparableDeny = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-lex-incomparable'),
    commercialScope: { channelRef, commerceMarketRef: market, sellingLegalEntityRef },
    effect: 'DENY',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-lex-incomparable',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-lex-incomparable'),
    },
    selector: { categoryRef: categoryB, kind: 'CATEGORY' },
  });
  const incomparable = resolveAssortmentOrdinary(
    input([broadAllow, incomparableDeny], {
      ...inputOverrides,
      categoryClassification: categoryClassification([categoryA, categoryB]),
    }),
  );
  expect(incomparable).toMatchObject({ kind: 'CONFIGURATION_CONFLICT' });
});

it('preserves same-effect maxima, conflicts opposing maxima, and ignores row order', () => {
  const categoryA = categoryRef('category-a');
  const categoryB = categoryRef('category-b');
  const allowA = candidate({
    effect: 'ALLOW',
    selector: { categoryRef: categoryA, kind: 'CATEGORY' },
  });
  const allowB = candidate({
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-b'),
    effect: 'ALLOW',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-b',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-b'),
    },
    selector: { categoryRef: categoryB, kind: 'CATEGORY' },
  });
  const classification = categoryClassification([categoryA, categoryB]);
  const first = resolveAssortmentOrdinary(input([allowA, allowB], { categoryClassification: classification }));
  const second = resolveAssortmentOrdinary(input([allowB, allowA], { categoryClassification: classification }));
  expect(first).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });
  expect(second).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });
  if (first.kind === 'RESOLVED' && second.kind === 'RESOLVED') {
    expect(first.evidence.maximalCandidates).toHaveLength(2);
    expect(second.evidence.maximalCandidates).toHaveLength(2);
  }

  const denyB = { ...allowB, effect: 'DENY' as const };
  expect(resolveAssortmentOrdinary(input([allowA, denyB], { categoryClassification: classification }))).toMatchObject({
    kind: 'CONFIGURATION_CONFLICT',
  });
});

it('requires complete membership and category evidence only for material candidates', () => {
  const groupCandidate = candidate({
    audience: { groupRef: groupRef('group-1'), kind: 'COMMERCE_CUSTOMER_GROUP' },
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-group'),
  });
  expect(resolveAssortmentOrdinary(input([groupCandidate]))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'MEMBERSHIP_SET_INCOMPLETE',
  });
  expect(resolveAssortmentOrdinary(input([groupCandidate], { memberships: memberships(['group-1']) }))).toMatchObject({
    kind: 'RESOLVED',
    outcome: 'ELIGIBLE',
  });

  const categoryCandidate = candidate({ selector: { categoryRef: categoryRef('category-1'), kind: 'CATEGORY' } });
  expect(resolveAssortmentOrdinary(input([categoryCandidate]))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CATEGORY_SET_INCOMPLETE',
  });
  expect(
    resolveAssortmentOrdinary(input([categoryCandidate], { categoryClassification: categoryClassification([]) })),
  ).toMatchObject({ kind: 'MISSING_CONFIGURATION' });
});

it('supports multiple groups and does not invent a group mapping for counterparties', () => {
  const groupOne = candidate({
    audience: { groupRef: groupRef('group-1'), kind: 'COMMERCE_CUSTOMER_GROUP' },
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-group-one'),
  });
  const groupTwo = candidate({
    audience: { groupRef: groupRef('group-2'), kind: 'COMMERCE_CUSTOMER_GROUP' },
    bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'binding-group-two'),
    effect: 'ALLOW',
    ruleRevision: {
      ownerModuleId: 'commerce.assortment',
      revision: 'r-group-two',
      sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'revision-group-two'),
    },
  });
  const result = resolveAssortmentOrdinary(
    input([groupOne, groupTwo], { memberships: memberships(['group-1', 'group-2']) }),
  );
  expect(result).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });

  const counterparty = {
    counterpartyRef: ref('party.registry', 'party.registry.counterparty', 'counterparty-1'),
    kind: 'COUNTERPARTY' as const,
  };
  expect(
    resolveAssortmentOrdinary(input([groupOne], { subject: { kind: 'IDENTIFIED', subject: counterparty } })),
  ).toMatchObject({ kind: 'MISSING_CONFIGURATION' });
});

it('binds PURCHASE completeness to the full Catalog Selection identity', () => {
  const variantOne = ref('catalog.owner', 'catalog.variant', 'variant-one');
  const variantTwo = ref('catalog.owner', 'catalog.variant', 'variant-two');
  const purchaseSelection = {
    configuration: { kind: 'NONE' as const },
    productRef,
    variantKind: 'ATOMIC' as const,
    variantRef: variantOne,
  };
  const purchaseCandidate = candidate({
    decisionPurpose: 'PURCHASE',
    selector: { kind: 'VARIANT', variantRef: variantOne },
  });
  const purchaseTarget = { kind: 'CATALOG_SELECTION' as const, selection: purchaseSelection };
  const valid = input([purchaseCandidate], { decisionPurpose: 'PURCHASE', target: purchaseTarget });
  expect(resolveAssortmentOrdinary(valid)).toMatchObject({ kind: 'RESOLVED', outcome: 'ELIGIBLE' });

  const mismatchedCompleteness = input([purchaseCandidate], {
    completeness: {
      evidence: completenessEvidence,
      scope: {
        commercialScope: { channelRef, sellingLegalEntityRef },
        decisionPurpose: 'PURCHASE' as const,
        kind: 'ORDINARY_CANDIDATES' as const,
        operationTime,
        subject: subjectInput,
        target: {
          kind: 'CATALOG_SELECTION',
          selection: { ...purchaseSelection, variantRef: variantTwo },
        },
        tenantId,
      },
    },
    decisionPurpose: 'PURCHASE',
    target: purchaseTarget,
  });
  expect(resolveAssortmentOrdinary(mismatchedCompleteness)).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CANDIDATE_SET_INCOMPLETE',
  });
});

it('rejects purpose/target mismatches, stale facts, proof mismatches, and foreign tenants', () => {
  expect(resolveAssortmentOrdinary(input([candidate()], { decisionPurpose: 'PURCHASE' }))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'PURPOSE_TARGET_MISMATCH',
  });

  const currentCandidate = candidate();
  const staleFacts = factCurrentness([currentCandidate]).map((evidence) => ({ ...evidence, state: 'STALE' as const }));
  expect(resolveAssortmentOrdinary(input([currentCandidate], { factCurrentness: staleFacts }))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'FACT_CURRENTNESS_UNCERTAIN',
  });

  const mismatchedCompleteness = input([currentCandidate], {
    completeness: {
      evidence: { ...completenessEvidence, scope: 'generic-unrelated-proof' },
      scope: {
        commercialScope: { channelRef, sellingLegalEntityRef },
        decisionPurpose: 'VISIBILITY',
        kind: 'ORDINARY_CANDIDATES',
        operationTime,
        subject: subjectInput,
        target: { kind: 'PRODUCT', productRef },
        tenantId,
      },
    },
  });
  expect(resolveAssortmentOrdinary(mismatchedCompleteness)).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CANDIDATE_SET_INCOMPLETE',
  });

  const foreignCandidate = candidate({
    bindingRef: ref(
      'commerce.assortment',
      'commerce.assortment.applicability-binding',
      'binding-foreign',
      otherTenantId,
    ),
  });
  expect(resolveAssortmentOrdinary(input([foreignCandidate]))).toEqual({
    kind: 'INDETERMINATE',
    reason: 'CROSS_TENANT_INPUT',
  });
});

it.effect('consumes native Membership adapter proof without translating its digest or scope', () =>
  Effect.gen(function* nativeMembershipResolverProof() {
    const sellerId = '10000000-0000-4000-8000-000000000001';
    const nativeSeller = ref('commerce.legal-entity', 'commerce.legal-entity', sellerId);
    const nativeProfileRef = ref(
      'commerce.customer-context',
      'commerce.customer-context.retail-customer-profile',
      '20000000-0000-4000-8000-000000000001',
    );
    const nativeGroup = groupRef('30000000-0000-4000-8000-000000000001');
    const nativeProfile = { profileKind: 'RETAIL' as const, profileRef: nativeProfileRef };
    const row = {
      assignedAt: '2026-01-01T00:00:00.000Z',
      assignmentReason: 'owner-fixture',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      groupRef: nativeGroup,
      membershipRef: membershipRef('40000000-0000-4000-8000-000000000001'),
      profile: nativeProfile,
      removal: null,
      revision: 3,
      state: 'VALID' as const,
    };
    const commercialScope = { channelRef, sellingLegalEntityRef: nativeSeller };
    const sharedAllow = candidate({ commercialScope });
    const groupDeny = candidate({
      audience: { groupRef: nativeGroup, kind: 'COMMERCE_CUSTOMER_GROUP' },
      bindingRef: ref('commerce.assortment', 'commerce.assortment.applicability-binding', 'native-group-deny'),
      commercialScope,
      effect: 'DENY',
      ruleRevision: {
        ownerModuleId: 'commerce.assortment',
        revision: 'native-group-deny-r1',
        sourceRef: ref('commerce.assortment', 'commerce.assortment.rule-revision', 'native-group-deny-revision'),
      },
      selector: { kind: 'PRODUCT', productRef },
    });
    const request = Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
      asOf: operationTime,
      profileRef: nativeProfileRef,
      tenantId,
    });
    const context = { ...trustedContext, sellingLegalEntityRef: nativeSeller };
    const decisionSubject = {
      kind: 'IDENTIFIED' as const,
      subject: { kind: 'RETAIL_CUSTOMER_PROFILE' as const, profileRef: nativeProfileRef },
    };
    for (const rows of [[row], []]) {
      const digest = rows.length === 0 ? 'b'.repeat(64) : 'a'.repeat(64);
      const port = adaptCommerceCustomerGroupMemberships({
        observe: () =>
          Effect.succeed({
            asOf: operationTime,
            legalEntityId: sellerId,
            memberships: rows,
            predicateRef: AssortmentCommerceMembershipPredicate,
            profile: nativeProfile,
            proof: { complete: true, digestAlgorithm: 'SHA-256', itemCount: rows.length, membershipSetSha256: digest },
          }),
        requestCorrelation: 'native-membership-resolution-test',
        trustedLegalEntityId: sellerId,
        trustedTenantId: tenantId,
        verify: () =>
          Effect.succeed({
            asOf: operationTime,
            itemCount: rows.length,
            legalEntityId: sellerId,
            membershipSetSha256: digest,
            predicateRef: AssortmentCommerceMembershipPredicate,
            profile: nativeProfile,
            status: 'CURRENT',
          }),
      });
      const observed = yield* port.resolveCustomerGroupMemberships(request);
      const encodedObserved = yield* Schema.encodeEffect(AssortmentCustomerGroupMembershipSetSchema)(observed);
      const expectedOutcome = rows.length === 0 ? 'ELIGIBLE' : 'INELIGIBLE';
      expect(
        resolveAssortmentOrdinary(
          input([sharedAllow, groupDeny], {
            memberships: encodedObserved,
            subject: decisionSubject,
            trustedContext: context,
          }),
        ),
      ).toMatchObject({ kind: 'RESOLVED', outcome: expectedOutcome });
      const current = yield* port.verifySetCompleteness(
        Schema.decodeUnknownSync(AssortmentSetCompletenessRequestSchema)({
          asOf: operationTime,
          predicate: observed.completeness.predicate,
          scope: observed.completeness.scope,
          scopeRef: observed.profileRef,
          tenantId,
        }),
      );
      expect(current.evidence).toEqual(observed.completeness);
      expect(observed.completeness.proof.evidenceRef).toEqual(nativeProfileRef);
      const token = Schema.decodeUnknownSync(Schema.fromJsonString(AssortmentCommerceMembershipScopeTokenSchema))(
        observed.completeness.scope,
      );
      expect(token.proof.membershipSetSha256).toBe(digest);
      const invalidScopes = [
        '{}',
        JSON.stringify({ ...token, legalEntityId: '10000000-0000-4000-8000-000000000002' }),
        JSON.stringify({ ...token, proof: { ...token.proof, itemCount: token.proof.itemCount + 1 } }),
        JSON.stringify({ ...token, proof: { ...token.proof, complete: false } }),
        JSON.stringify({ ...token, proof: { ...token.proof, membershipSetSha256: 'not-an-owner-digest' } }),
        JSON.stringify({ ...token, version: 2 }),
        JSON.stringify({ ...token, unrecognized: true }),
      ];
      for (const scope of invalidScopes) {
        expect(
          resolveAssortmentOrdinary(
            input([sharedAllow, groupDeny], {
              memberships: { ...encodedObserved, completeness: { ...observed.completeness, scope } },
              subject: decisionSubject,
              trustedContext: context,
            }),
          ),
        ).toEqual({ kind: 'INDETERMINATE', reason: 'MEMBERSHIP_SET_INCOMPLETE' });
      }
      const [first] = encodedObserved.items;
      if (first !== undefined) {
        const invalidRows = [
          {
            ...encodedObserved,
            completeness: {
              ...encodedObserved.completeness,
              scope: JSON.stringify({ ...token, proof: { ...token.proof, itemCount: 2 } }),
            },
            items: [first, first],
          },
          { ...encodedObserved, items: [{ ...first, state: 'CANCELLED' as const }] },
        ];
        for (const invalidMemberships of invalidRows) {
          expect(
            resolveAssortmentOrdinary(
              input([sharedAllow, groupDeny], {
                memberships: invalidMemberships,
                subject: decisionSubject,
                trustedContext: context,
              }),
            ),
          ).toEqual({ kind: 'INDETERMINATE', reason: 'MEMBERSHIP_SET_INCOMPLETE' });
        }
      }
      for (const completeness of [
        { ...observed.completeness, predicate: 'unrecognized-owner-predicate' },
        { ...observed.completeness, state: 'STALE' as const },
        {
          ...observed.completeness,
          proof: { ...observed.completeness.proof, evidenceRef: groupRef('another-anchor') },
        },
      ]) {
        expect(
          resolveAssortmentOrdinary(
            input([sharedAllow, groupDeny], {
              memberships: { ...encodedObserved, completeness },
              subject: decisionSubject,
              trustedContext: context,
            }),
          ),
        ).toEqual({ kind: 'INDETERMINATE', reason: 'MEMBERSHIP_SET_INCOMPLETE' });
      }
    }
  }),
);
