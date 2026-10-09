import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  AssortmentDependencyFailureError,
  AssortmentOwnerResourceRefSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentCategoryClassificationSchema,
  AssortmentCustomerGroupMembershipRequestSchema,
  AssortmentCustomerGroupMembershipSetSchema,
  AssortmentFactCurrentnessRequestSchema,
  AssortmentFactCurrentnessResultSchema,
  AssortmentSetCompletenessRequestSchema,
  AssortmentSetCompletenessResultSchema,
  AssortmentTrustedCommerceContextRequestSchema,
  AssortmentOwnerEvidenceUnavailableLive,
  AssortmentOwnerEvidence,
} from '../../shared/domain/ports/owner-evidence.ts';
import {
  adaptCommerceCustomerGroupMemberships,
  CommerceMembershipScopeTokenSchema,
} from '../../src/adapters/commerce-customer-group-memberships.ts';
import {
  AssortmentRevalidationAttemptSchema,
  revalidateAssortmentAttempt,
} from '../../shared/domain/final-revalidation.ts';
import type {
  AssortmentCustomerGroupMembershipSet,
  AssortmentOwnerFailure,
} from '../../shared/domain/ports/owner-evidence.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const otherTenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a22';
const instant = '2026-09-22T10:00:00.000Z';
const legalEntityId = '50000000-0000-4000-8000-000000000001';
const otherLegalEntityId = '50000000-0000-4000-8000-000000000002';

const ref = (moduleId: string, resourceType: string, resourceId: string, nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId: nextTenantId,
  });

const evidence = (resourceId: string, nextTenantId = tenantId) => ({
  evidenceRef: ref('owner.evidence', 'owner.evidence.proof', resourceId, nextTenantId),
  ownerModuleId: 'owner.evidence',
  sourceRevision: {
    ownerModuleId: 'owner.evidence',
    revision: 'r1',
    sourceRef: ref('owner.evidence', 'owner.evidence.revision', `${resourceId}-revision`, nextTenantId),
  },
});

const profileRef = () =>
  ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1');

const membershipSet = (nextTenantId = tenantId) =>
  Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipSetSchema)({
    asOf: instant,
    completeness: {
      predicate: 'all current memberships for profile',
      proof: evidence('membership-set-proof'),
      scope: 'commerce.customer-context.customer-group-membership',
      state: 'COMPLETE',
    },
    items: [
      {
        effectiveFrom: instant,
        effectiveTo: '2026-09-23T10:00:00.000Z',
        groupRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', 'group-1', nextTenantId),
        membershipRef: ref(
          'commerce.customer-context',
          'commerce.customer-context.customer-group-membership',
          'membership-1',
          nextTenantId,
        ),
        profileRef: ref(
          'commerce.customer-context',
          'commerce.customer-context.retail-customer-profile',
          'profile-1',
          nextTenantId,
        ),
        revision: 'r1',
        state: 'VALID',
      },
    ],
    profileRef: ref(
      'commerce.customer-context',
      'commerce.customer-context.retail-customer-profile',
      'profile-1',
      nextTenantId,
    ),
  });

it('accepts complete membership, currentness, and set proof values without using time as proof', () => {
  const memberships = membershipSet();
  expect(memberships.completeness.state).toBe('COMPLETE');
  expect(memberships.items[0]?.effectiveTo).not.toBeNull();

  const currentness = Schema.decodeUnknownSync(AssortmentFactCurrentnessResultSchema)({
    evidence: {
      factRef: ref('commerce.assortment', 'commerce.assortment.binding', 'binding-1'),
      proof: evidence('binding-currentness'),
      state: 'CURRENT',
    },
    observedAt: instant,
  });
  expect(currentness.evidence.state).toBe('CURRENT');

  const completeness = Schema.decodeUnknownSync(AssortmentSetCompletenessResultSchema)({
    evidence: memberships.completeness,
  });
  expect(completeness.evidence.state).toBe('COMPLETE');
});

it('preserves negative proof states and rejects cross-tenant nested evidence', () => {
  const completeMemberships = membershipSet();
  expect(
    Schema.is(AssortmentCustomerGroupMembershipSetSchema)({
      ...completeMemberships,
      completeness: { ...completeMemberships.completeness, state: 'UNVERIFIABLE' },
    }),
  ).toBe(true);
  const [membership] = completeMemberships.items;
  if (membership !== undefined && membership.effectiveTo !== null) {
    expect(
      Schema.is(AssortmentCustomerGroupMembershipSetSchema)({
        ...completeMemberships,
        asOf: membership.effectiveTo,
      }),
    ).toBe(false);
  }
  expect(
    Schema.decodeUnknownSync(AssortmentFactCurrentnessResultSchema)({
      evidence: {
        factRef: ref('commerce.assortment', 'commerce.assortment.binding', 'binding-1'),
        proof: evidence('binding-stale'),
        state: 'STALE',
      },
      observedAt: instant,
    }).evidence.state,
  ).toBe('STALE');
  const crossTenantMembershipSet = membershipSet();
  const crossTenantGroupRef = ref(
    'commerce.customer-context',
    'commerce.customer-context.customer-group',
    'group-other',
    otherTenantId,
  );
  expect(
    Schema.is(AssortmentCustomerGroupMembershipSetSchema)({
      ...crossTenantMembershipSet,
      items: crossTenantMembershipSet.items.map((item) => ({ ...item, groupRef: crossTenantGroupRef })),
    }),
  ).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(AssortmentCategoryClassificationSchema)({
      ancestries: [],
      classifications: [ref('catalog.owner', 'catalog.category', 'category-1', otherTenantId)],
      completeness: {
        predicate: 'all current category classifications',
        proof: evidence('category-proof'),
        scope: 'catalog.category-classification',
        state: 'COMPLETE',
      },
      currentness: [],
      productRef: ref('catalog.owner', 'catalog.product', 'product-1'),
    }),
  ).toThrow();
});

it('requires trusted context and owner-qualified set scopes rather than client context claims', () => {
  const contextRequest = Schema.decodeUnknownSync(AssortmentTrustedCommerceContextRequestSchema)({
    trustedContextRef: ref('commerce.context-owner', 'commerce.context-owner.trusted-context', 'context-1'),
  });
  expect(contextRequest.trustedContextRef.moduleId).toBe('commerce.context-owner');
  expect(() =>
    Schema.decodeUnknownSync(AssortmentTrustedCommerceContextRequestSchema)({
      channelRef: ref('commerce.channel', 'channel', 'web'),
      operationTime: instant,
      sellingLegalEntityRef: ref('commerce.legal-entity', 'legal-entity', 'sle-1'),
      tenantId,
    }),
  ).toThrow();

  expect(() =>
    Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
      asOf: instant,
      profileRef: ref(
        'commerce.customer-context',
        'commerce.customer-context.retail-customer-profile',
        'profile-1',
        otherTenantId,
      ),
      tenantId,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentFactCurrentnessRequestSchema)({
      factRef: ref('owner.fact', 'owner.fact.binding', 'fact-1', otherTenantId),
      observedAt: instant,
      tenantId,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(AssortmentSetCompletenessRequestSchema)({
      asOf: instant,
      predicate: 'all current facts',
      scope: 'owner-defined exact set',
      scopeRef: ref('owner.set', 'owner.set.scope', 'set-1', otherTenantId),
      tenantId,
    }),
  ).toThrow();
});

it.effect('fails closed with sanitized owner failures and rejects incomplete Customer Context responses', () =>
  Effect.gen(function* failClosed() {
    const request = Schema.decodeUnknownSync(AssortmentFactCurrentnessRequestSchema)({
      factRef: ref('owner.currentness', 'owner.currentness.fact', 'fact-1'),
      observedAt: instant,
      tenantId,
    });
    const unavailable = yield* AssortmentOwnerEvidence.pipe(
      Effect.flatMap((ports) => ports.verifyFactCurrentness(request)),
      Effect.provide(AssortmentOwnerEvidenceUnavailableLive),
      Effect.flip,
    );
    expect(Schema.is(AssortmentDependencyFailureError)(unavailable)).toBe(true);

    const adapter = adaptCommerceCustomerGroupMemberships({
      observe: () =>
        Effect.succeed({
          effectiveAt: instant,
          items: [],
          profile: { profileKind: 'RETAIL', profileRef: profileRef() },
        }),
      requestCorrelation: 'correlation-1',
      trustedLegalEntityId: legalEntityId,
      trustedTenantId: tenantId,
      verify: () => Effect.die('unexpected verifier call'),
    });
    const failure = yield* adapter
      .resolveCustomerGroupMemberships(
        Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
          asOf: instant,
          profileRef: profileRef(),
          tenantId,
        }),
      )
      .pipe(Effect.flip);
    expect(Schema.is(AssortmentDependencyFailureError)(failure)).toBe(true);
  }),
);

const nativePredicate = 'commerce.customer-context.customer-group-memberships.effective.v1';
const nativeProfile = { profileKind: 'RETAIL' as const, profileRef: profileRef() };
const nativeMembership = {
  assignedAt: instant,
  assignmentReason: 'Owner Membership fixture',
  effectiveFrom: instant,
  effectiveTo: null,
  groupRef: ref(
    'commerce.customer-context',
    'commerce.customer-context.customer-group',
    '30000000-0000-4000-8000-000000000001',
  ),
  membershipRef: ref(
    'commerce.customer-context',
    'commerce.customer-context.customer-group-membership',
    '40000000-0000-4000-8000-000000000001',
  ),
  profile: nativeProfile,
  removal: null,
  revision: 3,
  state: 'VALID' as const,
};
type MembershipReferenceFixture = {
  readonly [Field in keyof ReturnType<typeof profileRef>]: string;
};
interface MembershipProfileFixture {
  readonly profileKind: 'RETAIL' | 'COUNTERPARTY';
  readonly profileRef: MembershipReferenceFixture;
}
type MembershipRowFixture = Omit<
  typeof nativeMembership,
  'effectiveTo' | 'groupRef' | 'membershipRef' | 'profile' | 'state'
> & {
  readonly effectiveTo: string | null;
  readonly groupRef: MembershipReferenceFixture;
  readonly membershipRef: MembershipReferenceFixture;
  readonly profile: MembershipProfileFixture;
  readonly state: 'VALID' | 'CANCELLED';
};
const ownerObservation = (memberships: readonly MembershipRowFixture[] = [nativeMembership]) => ({
  asOf: instant,
  legalEntityId,
  memberships,
  predicateRef: nativePredicate,
  profile: nativeProfile,
  proof: {
    complete: true as const,
    digestAlgorithm: 'SHA-256' as const,
    itemCount: memberships.length,
    membershipSetSha256: 'a'.repeat(64),
  },
});
const ownerCurrent = () => ({
  asOf: instant,
  itemCount: 1,
  legalEntityId,
  membershipSetSha256: 'a'.repeat(64),
  predicateRef: nativePredicate,
  profile: nativeProfile,
  status: 'CURRENT' as const,
});
const membershipRequest = () =>
  Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
    asOf: instant,
    profileRef: profileRef(),
    tenantId,
  });
const completeSetRequest = (set: AssortmentCustomerGroupMembershipSet) =>
  Schema.decodeUnknownSync(AssortmentSetCompletenessRequestSchema)({
    asOf: instant,
    predicate: set.completeness.predicate,
    scope: set.completeness.scope,
    scopeRef: set.profileRef,
    tenantId,
  });
type MembershipObservationFixture = Omit<ReturnType<typeof ownerObservation>, 'profile' | 'proof'> & {
  readonly profile: MembershipProfileFixture;
  readonly proof: Omit<ReturnType<typeof ownerObservation>['proof'], 'complete' | 'digestAlgorithm'> & {
    readonly complete: boolean;
    readonly digestAlgorithm: string;
  };
};
type MembershipVerificationFixture = Omit<ReturnType<typeof ownerCurrent>, 'profile' | 'status'> & {
  readonly profile: MembershipProfileFixture;
  readonly status: 'CURRENT' | 'STALE';
};
const nativeAdapter = (
  observation: MembershipObservationFixture = ownerObservation(),
  verification: MembershipVerificationFixture = ownerCurrent(),
) =>
  adaptCommerceCustomerGroupMemberships({
    observe: () => Effect.succeed(observation),
    requestCorrelation: 'correlation-1',
    trustedLegalEntityId: legalEntityId,
    trustedTenantId: tenantId,
    verify: () => Effect.succeed(verification),
  });
const expectUnavailable = (failure: AssortmentOwnerFailure) => {
  expect(Schema.is(AssortmentDependencyFailureError)(failure)).toBe(true);
  expect(failure).toMatchObject({
    code: 'DEPENDENCY_FAILURE',
    ownerModuleId: 'commerce.customer-context',
    safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
  });
};

it.effect('maps exact native v1 Membership witnesses without inventing proof resources or Profile revisions', () =>
  Effect.gen(function* mapNativeMemberships() {
    const adapter = nativeAdapter();
    const set = yield* adapter.resolveCustomerGroupMemberships(membershipRequest());
    expect(set.items).toHaveLength(1);
    expect(set.items[0]).toMatchObject({
      groupRef: nativeMembership.groupRef,
      membershipRef: nativeMembership.membershipRef,
      profileRef: profileRef(),
      revision: '3',
      state: 'VALID',
    });
    expect(set.items[0]?.effectiveTo).toBeNull();
    expect(set.completeness.proof).toEqual({
      evidenceRef: nativeProfile.profileRef,
      ownerModuleId: 'commerce.customer-context',
    });
    expect(set.completeness.scope.length).toBeLessThan(500);
    expect(
      Schema.decodeUnknownSync(Schema.fromJsonString(CommerceMembershipScopeTokenSchema))(set.completeness.scope),
    ).toEqual({ legalEntityId, proof: ownerObservation().proof, version: 1 });
    expect((yield* adapter.verifySetCompleteness(completeSetRequest(set))).evidence).toEqual(set.completeness);
    const counterparty = {
      profileKind: 'COUNTERPARTY' as const,
      profileRef: ref(
        'commerce.customer-context',
        'commerce.customer-context.counterparty-purchasing-profile',
        'counterparty-profile-1',
      ),
    };
    const counterpartyRow = { ...nativeMembership, effectiveTo: '2026-09-23T10:00:00.000Z', profile: counterparty };
    const counterpartyAdapter = nativeAdapter(
      { ...ownerObservation([counterpartyRow]), profile: counterparty },
      { ...ownerCurrent(), profile: counterparty },
    );
    const counterpartySet = yield* counterpartyAdapter.resolveCustomerGroupMemberships(
      Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
        asOf: instant,
        profileRef: counterparty.profileRef,
        tenantId,
      }),
    );
    expect(counterpartySet.profileRef).toEqual(counterparty.profileRef);
    expect(counterpartySet.items[0]?.effectiveTo).not.toBeNull();
    expect((yield* counterpartyAdapter.verifySetCompleteness(completeSetRequest(counterpartySet))).evidence).toEqual(
      counterpartySet.completeness,
    );
    const emptyAdapter = nativeAdapter(ownerObservation([]), { ...ownerCurrent(), itemCount: 0 });
    const empty = yield* emptyAdapter.resolveCustomerGroupMemberships(membershipRequest());
    expect(empty.items).toHaveLength(0);
    expect(empty.completeness.state).toBe('COMPLETE');
    expect((yield* emptyAdapter.verifySetCompleteness(completeSetRequest(empty))).evidence).toEqual(empty.completeness);
    const second = {
      ...nativeMembership,
      membershipRef: ref(
        'commerce.customer-context',
        'commerce.customer-context.customer-group-membership',
        '40000000-0000-4000-8000-000000000002',
      ),
    };
    expect(
      (yield* nativeAdapter(ownerObservation([nativeMembership, second])).resolveCustomerGroupMemberships(
        membershipRequest(),
      )).items,
    ).toHaveLength(2);
  }),
);

it.effect('rejects torn, duplicate, ineffective and mismatched owner observation controls', () =>
  Effect.gen(function* rejectInvalidObservation() {
    const base = ownerObservation();
    const otherProfile = { ...nativeProfile, profileRef: { ...nativeProfile.profileRef, resourceId: 'other-profile' } };
    const invalid = [
      { ...base, legalEntityId: otherLegalEntityId },
      { ...base, asOf: '2026-09-22T10:00:01.000Z' },
      { ...base, profile: otherProfile },
      { ...base, profile: { ...nativeProfile, profileRef: { ...nativeProfile.profileRef, tenantId: otherTenantId } } },
      { ...base, predicateRef: 'wrong.predicate' },
      { ...base, proof: { ...base.proof, itemCount: 0 } },
      { ...base, proof: { ...base.proof, complete: false } },
      { ...base, proof: { ...base.proof, digestAlgorithm: 'MD5' } },
      { ...base, proof: { ...base.proof, membershipSetSha256: 'invalid' } },
      ownerObservation([nativeMembership, nativeMembership]),
      ownerObservation([{ ...nativeMembership, profile: otherProfile }]),
      ownerObservation([{ ...nativeMembership, groupRef: { ...nativeMembership.groupRef, tenantId: otherTenantId } }]),
      ownerObservation([
        { ...nativeMembership, membershipRef: { ...nativeMembership.membershipRef, tenantId: otherTenantId } },
      ]),
      ownerObservation([{ ...nativeMembership, state: 'CANCELLED' }]),
      ownerObservation([{ ...nativeMembership, effectiveFrom: '2026-09-22T10:00:01.000Z' }]),
      ownerObservation([{ ...nativeMembership, effectiveFrom: '2026-09-21T10:00:00.000Z', effectiveTo: instant }]),
    ];
    yield* Effect.forEach(
      invalid,
      (observation) =>
        nativeAdapter(observation)
          .resolveCustomerGroupMemberships(membershipRequest())
          .pipe(Effect.flip, Effect.map(expectUnavailable)),
      { concurrency: 1, discard: true },
    );
    const wrongTenant = { ...membershipRequest(), tenantId: ref('owner', 'owner.fact', 'x', otherTenantId).tenantId };
    expectUnavailable(yield* nativeAdapter().resolveCustomerGroupMemberships(wrongTenant).pipe(Effect.flip));
    const boundTenantMismatch = Schema.decodeUnknownSync(AssortmentCustomerGroupMembershipRequestSchema)({
      asOf: instant,
      profileRef: { ...profileRef(), tenantId: otherTenantId },
      tenantId: otherTenantId,
    });
    expectUnavailable(yield* nativeAdapter().resolveCustomerGroupMemberships(boundTenantMismatch).pipe(Effect.flip));
    const wrongProfile = {
      ...membershipRequest(),
      profileRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', 'group'),
    };
    expectUnavailable(yield* nativeAdapter().resolveCustomerGroupMemberships(wrongProfile).pipe(Effect.flip));
    const badCorrelation = adaptCommerceCustomerGroupMemberships({
      observe: () => Effect.die('must not call owner'),
      requestCorrelation: ' padded ',
      trustedLegalEntityId: legalEntityId,
      trustedTenantId: tenantId,
      verify: () => Effect.die('must not call owner'),
    });
    expectUnavailable(yield* badCorrelation.resolveCustomerGroupMemberships(membershipRequest()).pipe(Effect.flip));
  }),
);

it.effect(
  'passes the exact native witness to verification and preserves the prior token on stale insertion or cancellation',
  () =>
    Effect.gen(function* preserveNativeWitness() {
      const calls: unknown[] = [];
      const observe = ownerObservation([]);
      const adapter = adaptCommerceCustomerGroupMemberships({
        observe: () => Effect.succeed(observe),
        requestCorrelation: 'correlation-1',
        trustedLegalEntityId: legalEntityId,
        trustedTenantId: tenantId,
        verify: (input, correlation) => {
          calls.push({ correlation, input });
          return Effect.succeed({ ...ownerCurrent(), membershipSetSha256: 'b'.repeat(64), status: 'STALE' });
        },
      });
      const set = yield* adapter.resolveCustomerGroupMemberships(membershipRequest());
      const verified = yield* adapter.verifySetCompleteness(completeSetRequest(set));
      expect(calls).toEqual([
        {
          correlation: 'correlation-1',
          input: {
            asOf: instant,
            membershipSetSha256: observe.proof.membershipSetSha256,
            profile: nativeProfile,
            proofItemCount: 0,
          },
        },
      ]);
      expect(verified.evidence).toEqual({ ...set.completeness, state: 'STALE' });
      const cancellation = nativeAdapter(ownerObservation(), {
        ...ownerCurrent(),
        itemCount: 0,
        membershipSetSha256: 'c'.repeat(64),
        status: 'STALE',
      });
      const nonempty = yield* cancellation.resolveCustomerGroupMemberships(membershipRequest());
      expect((yield* cancellation.verifySetCompleteness(completeSetRequest(nonempty))).evidence).toEqual({
        ...nonempty.completeness,
        state: 'STALE',
      });
    }),
);

it.effect('rejects malformed tokens and inconsistent Current verifier scopes instead of manufacturing absence', () =>
  Effect.gen(function* rejectInvalidVerification() {
    const set = yield* nativeAdapter().resolveCustomerGroupMemberships(membershipRequest());
    const request = completeSetRequest(set);
    const token = Schema.decodeUnknownSync(Schema.fromJsonString(CommerceMembershipScopeTokenSchema))(
      set.completeness.scope,
    );
    const wrongSeller = Schema.encodeSync(Schema.fromJsonString(CommerceMembershipScopeTokenSchema))({
      ...token,
      legalEntityId: otherLegalEntityId,
    });
    const invalidRequests = [
      { ...request, predicate: 'unsupported.predicate' },
      { ...request, scope: 'not-json' },
      { ...request, scope: 'x'.repeat(501) },
      { ...request, scope: ` ${request.scope}` },
      { ...request, scope: request.scope.replace('"version":1', '"version":2') },
      { ...request, scope: wrongSeller },
      { ...request, scopeRef: ref('commerce.customer-context', 'commerce.customer-context.customer-group', 'group') },
      { ...request, tenantId: ref('owner', 'owner.fact', 'x', otherTenantId).tenantId },
      Schema.decodeUnknownSync(AssortmentSetCompletenessRequestSchema)({
        asOf: instant,
        predicate: request.predicate,
        scope: request.scope,
        scopeRef: { ...profileRef(), tenantId: otherTenantId },
        tenantId: otherTenantId,
      }),
    ];
    const invalidAdapter = adaptCommerceCustomerGroupMemberships({
      observe: () => Effect.die('must not call owner'),
      requestCorrelation: 'correlation-1',
      trustedLegalEntityId: legalEntityId,
      trustedTenantId: tenantId,
      verify: () => Effect.die('invalid token must not call owner'),
    });
    yield* Effect.forEach(
      invalidRequests,
      (input) => invalidAdapter.verifySetCompleteness(input).pipe(Effect.flip, Effect.map(expectUnavailable)),
      { concurrency: 1, discard: true },
    );
    const current = ownerCurrent();
    const invalidResponses = [
      { ...current, itemCount: 0 },
      { ...current, membershipSetSha256: 'b'.repeat(64) },
      { ...current, legalEntityId: otherLegalEntityId },
      { ...current, asOf: '2026-09-22T10:00:01.000Z' },
      {
        ...current,
        profile: { ...nativeProfile, profileRef: { ...nativeProfile.profileRef, resourceId: 'other-profile' } },
      },
      {
        ...current,
        profile: { ...nativeProfile, profileRef: { ...nativeProfile.profileRef, tenantId: otherTenantId } },
      },
      { ...current, predicateRef: 'wrong.predicate' },
    ];
    yield* Effect.forEach(
      invalidResponses,
      (response) =>
        nativeAdapter(ownerObservation(), response)
          .verifySetCompleteness(request)
          .pipe(Effect.flip, Effect.map(expectUnavailable)),
      { concurrency: 1, discard: true },
    );
    const outage = adaptCommerceCustomerGroupMemberships({
      observe: () => Effect.fail('private owner outage detail'),
      requestCorrelation: 'correlation-1',
      trustedLegalEntityId: legalEntityId,
      trustedTenantId: tenantId,
      verify: () => Effect.fail('private owner outage detail'),
    });
    const outageFailure = yield* outage.resolveCustomerGroupMemberships(membershipRequest()).pipe(Effect.flip);
    expectUnavailable(outageFailure);
    expect(Object.getOwnPropertyDescriptor(outageFailure, 'cause')?.enumerable).toBe(false);
    expect(JSON.stringify(outageFailure)).not.toContain('private owner outage detail');
    expectUnavailable(yield* outage.verifySetCompleteness(request).pipe(Effect.flip));
  }),
);

const membershipAttempt = (set: AssortmentCustomerGroupMembershipSet) =>
  Schema.decodeUnknownSync(AssortmentRevalidationAttemptSchema)({
    decision: {
      evidence: {
        factCurrentness: [],
        operationTime: instant,
        setCompleteness: [set.completeness],
        subject: { kind: 'IDENTIFIED', subject: { kind: 'RETAIL_CUSTOMER_PROFILE', profileRef: set.profileRef } },
        target: { kind: 'PRODUCT', productRef: ref('catalog.owner', 'catalog.product', 'product-1') },
        trustedContext: {
          channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
          operationTime: instant,
          sellingLegalEntityRef: ref('party.registry', 'party.registry.legal-entity', legalEntityId),
          tenantId,
        },
      },
      outcome: 'ELIGIBLE',
    },
    factRequests: [],
    setRequests: [
      {
        asOf: instant,
        predicate: set.completeness.predicate,
        scope: set.completeness.scope,
        scopeRef: set.profileRef,
        tenantId,
      },
    ],
  });

it.effect(
  'rebuilds changed native Membership proof through bounded final revalidation and exhausts persistent stale evidence',
  () =>
    Effect.gen(function* retryNativeMemberships() {
      const scopes: string[] = [];
      const adapter = adaptCommerceCustomerGroupMemberships({
        observe: () => Effect.succeed(ownerObservation([])),
        requestCorrelation: 'correlation-1',
        trustedLegalEntityId: legalEntityId,
        trustedTenantId: tenantId,
        verify: () => Effect.succeed({ ...ownerCurrent(), membershipSetSha256: 'b'.repeat(64), status: 'STALE' }),
      });
      const next = nativeAdapter(
        { ...ownerObservation(), proof: { ...ownerObservation().proof, membershipSetSha256: 'b'.repeat(64) } },
        { ...ownerCurrent(), membershipSetSha256: 'b'.repeat(64) },
      );
      const result = yield* revalidateAssortmentAttempt({
        buildAttempt: (number) => {
          const current = number === 1 ? adapter : next;
          return current.resolveCustomerGroupMemberships(membershipRequest()).pipe(
            Effect.map((set) => {
              scopes.push(set.completeness.scope);
              return membershipAttempt(set);
            }),
          );
        },
        maxAttempts: 2,
        ownerEvidence: {
          resolveSetComposition: () => Effect.die('unused composition'),
          verifyFactCurrentness: () => Effect.die('unused facts'),
          verifySetCompleteness: (request) =>
            scopes.length === 1 ? adapter.verifySetCompleteness(request) : next.verifySetCompleteness(request),
        },
      });
      expect(result).toMatchObject({ attempts: 2, kind: 'PUBLISHED' });
      expect(scopes).toHaveLength(2);
      expect(scopes[1]).not.toBe(scopes[0]);
      const exhausted = yield* revalidateAssortmentAttempt({
        buildAttempt: () =>
          adapter.resolveCustomerGroupMemberships(membershipRequest()).pipe(Effect.map(membershipAttempt)),
        maxAttempts: 2,
        ownerEvidence: {
          resolveSetComposition: () => Effect.die('unused composition'),
          verifyFactCurrentness: () => Effect.die('unused facts'),
          verifySetCompleteness: adapter.verifySetCompleteness,
        },
      });
      expect(exhausted).toMatchObject({ attempts: 2, decision: { outcome: 'INDETERMINATE' }, kind: 'INDETERMINATE' });
    }),
);
