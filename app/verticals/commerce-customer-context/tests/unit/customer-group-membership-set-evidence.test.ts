import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { EffectiveCustomerGroupMembershipSetV1ResponseSchema } from '../../shared/apis/effective-customer-group-membership-set-v1.ts';
import { VerifyEffectiveCustomerGroupMembershipSetV1ResponseSchema } from '../../shared/apis/verify-effective-customer-group-membership-set-v1.ts';
import type {
  CommerceCustomerGroupMembership,
  CommerceCustomerProfileSubject,
} from '../../shared/domain/group-contract.ts';
import {
  CommerceCustomerGroupMembershipSchema,
  CommerceCustomerProfileSubjectSchema,
} from '../../shared/domain/group-contract.ts';
import {
  computeEffectiveCustomerGroupMembershipSetProof,
  effectiveCustomerGroupMembershipSetMatchesProof,
  effectiveCustomerGroupMembershipSetSha256,
} from '../../src/api/effective-customer-group-membership-set-v1.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const profile = Schema.decodeUnknownSync(CommerceCustomerProfileSubjectSchema)({
  profileKind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '20000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
});
const counterpartyProfile = Schema.decodeUnknownSync(CommerceCustomerProfileSubjectSchema)({
  profileKind: 'COUNTERPARTY',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '20000000-0000-4000-8000-000000000002',
    resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
    tenantId,
  },
});
const membership = Schema.decodeUnknownSync(CommerceCustomerGroupMembershipSchema)({
  assignedAt: '2026-09-01T00:00:00.000Z',
  assignmentReason: 'Test membership',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: null,
  groupRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '30000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.customer-group',
    tenantId,
  },
  membershipRef: {
    moduleId: 'commerce.customer-context',
    resourceId: '40000000-0000-4000-8000-000000000001',
    resourceType: 'commerce.customer-context.customer-group-membership',
    tenantId,
  },
  profile,
  removal: null,
  revision: 1,
  state: 'VALID',
});

const asOf = '2026-09-28T12:00:00.000Z';
const legalEntityId = '50000000-0000-4000-8000-000000000001';
const set = (
  memberships: readonly CommerceCustomerGroupMembership[],
  at = asOf,
  subject: CommerceCustomerProfileSubject = profile,
  sellerId = legalEntityId,
) => ({
  asOf: at,
  legalEntityId: sellerId,
  memberships,
  profile: subject,
});

describe('Commerce Customer Group complete-set evidence', () => {
  it.effect('proves a complete empty set and keeps a changed insertion stale', () =>
    Effect.gen(function* proveCompleteEmptySet() {
      const empty = set([]);
      const emptyProof = yield* computeEffectiveCustomerGroupMembershipSetProof(empty);
      const nonemptyProof = yield* computeEffectiveCustomerGroupMembershipSetProof(set([membership]));
      expect(emptyProof).toMatchObject({ complete: true, digestAlgorithm: 'SHA-256', itemCount: 0 });
      expect(
        Schema.is(EffectiveCustomerGroupMembershipSetV1ResponseSchema)({
          ...empty,
          predicateRef: 'commerce.customer-context.customer-group-memberships.effective.v1',
          proof: emptyProof,
        }),
      ).toBe(true);
      expect(yield* effectiveCustomerGroupMembershipSetMatchesProof(empty, emptyProof)).toBe(true);
      expect(yield* effectiveCustomerGroupMembershipSetMatchesProof(set([membership]), emptyProof)).toBe(false);
      expect(
        Schema.is(VerifyEffectiveCustomerGroupMembershipSetV1ResponseSchema)({
          asOf,
          itemCount: 1,
          legalEntityId,
          membershipSetSha256: nonemptyProof.membershipSetSha256,
          predicateRef: 'commerce.customer-context.customer-group-memberships.effective.v1',
          profile,
          status: 'STALE',
        }),
      ).toBe(true);
    }),
  );

  it.effect('makes cancellation stale and treats the cancelled effective set as empty', () =>
    Effect.gen(function* verifyCancellation() {
      const priorProof = yield* computeEffectiveCustomerGroupMembershipSetProof(set([membership]));
      const cancelledSet = set([]);
      const cancelledProof = yield* computeEffectiveCustomerGroupMembershipSetProof(cancelledSet);
      expect(yield* effectiveCustomerGroupMembershipSetMatchesProof(cancelledSet, priorProof)).toBe(false);
      expect(yield* effectiveCustomerGroupMembershipSetMatchesProof(cancelledSet, cancelledProof)).toBe(true);
    }),
  );

  it.effect('binds verification to the exact Profile and asOf', () =>
    Effect.gen(function* verifyExactScope() {
      const original = set([membership]);
      const digest = yield* effectiveCustomerGroupMembershipSetSha256(original);
      const proof = { itemCount: 1, membershipSetSha256: digest };
      expect(
        yield* effectiveCustomerGroupMembershipSetMatchesProof(set([membership], '2026-09-29T12:00:00.000Z'), proof),
      ).toBe(false);
      expect(
        yield* effectiveCustomerGroupMembershipSetMatchesProof(set([membership], asOf, counterpartyProfile), proof),
      ).toBe(false);
      expect(
        yield* effectiveCustomerGroupMembershipSetMatchesProof(
          set([membership], asOf, profile, '50000000-0000-4000-8000-000000000002'),
          proof,
        ),
      ).toBe(false);
    }),
  );
});
