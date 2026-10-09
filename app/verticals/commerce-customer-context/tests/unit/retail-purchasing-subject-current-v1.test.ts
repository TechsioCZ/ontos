import { ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { ProfileInstantSchema } from '../../shared/domain/profile-contracts.ts';
import { RetailPurchasingSubjectCurrentV1RequestSchema } from '../../shared/apis/retail-purchasing-subject-current-v1.ts';
import { VerifyRetailPurchasingSubjectCurrentV1RequestSchema } from '../../shared/apis/verify-retail-purchasing-subject-current-v1.ts';
import type {
  RetailPurchasingSubjectCurrentV1Response,
  RetailPurchasingSubjectProofV1,
} from '../../shared/apis/retail-purchasing-subject-current-v1.ts';
import type { VerifyRetailPurchasingSubjectCurrentV1Response } from '../../shared/apis/verify-retail-purchasing-subject-current-v1.ts';
import { readRetailPurchasingSubjectCurrentV1 } from '../../src/api/retail-purchasing-subject-current-v1.read.ts';
import type { RetailPurchasingSubjectCurrentV1Services } from '../../src/api/retail-purchasing-subject-current-v1.read.ts';
import { verifyRetailPurchasingSubjectCurrentV1 } from '../../src/api/verify-retail-purchasing-subject-current-v1.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-profile-1',
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId,
} as const;
const bindingRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'retail-binding-1',
  resourceType: 'commerce.customer-context.retail-portal-profile-binding',
  tenantId,
} as const;
const scope = { legalEntityId, principalId, tenantId } as const;
const request = Schema.decodeUnknownSync(RetailPurchasingSubjectCurrentV1RequestSchema)({ profileRef });

const provenance = (revision: string, observedAt: typeof ProfileInstantSchema.Type = '2026-09-28T10:00:00.000Z') => ({
  freshness: {
    observedAt,
    revision,
    sourceModuleId: 'commerce.customer-context',
    status: 'CURRENT' as const,
  },
  projection: 'PROFILE' as const,
});

const servicesFor = (
  options: {
    readonly binding?: RetailPurchasingSubjectProofV1['bindingRef'];
    readonly fail?: boolean;
    readonly observedAt?: typeof ProfileInstantSchema.Type;
    readonly outcome?: 'RETAIL_PRINCIPAL_BINDING_REVOKED' | 'RETAIL_PRINCIPAL_NOT_BOUND';
    readonly profile?: RetailPurchasingSubjectProofV1['profileRef'];
    readonly revision?: string;
  } = {},
): RetailPurchasingSubjectCurrentV1Services => ({
  retailPrincipalResolution: {
    resolvePrincipal: (input, trustedPrincipalId) => {
      expect(input.profileRef).toEqual(profileRef);
      expect(trustedPrincipalId).toBe(principalId);
      if (options.fail === true) {
        return Effect.fail(
          new ReadHandlerUnavailable({
            code: 'read_handler_unavailable',
            reason: 'fixture owner unavailable',
          }),
        );
      }
      if (options.outcome !== undefined) {
        return Effect.succeed({
          _tag: options.outcome,
          bindingRef: options.binding ?? bindingRef,
          profileRef,
          provenance: [provenance(options.revision ?? 'binding-revision-1', options.observedAt)],
        });
      }
      return Effect.succeed({
        _tag: 'RETAIL_PRINCIPAL_BOUND',
        bindingRef: options.binding ?? bindingRef,
        profileRef: options.profile ?? profileRef,
        provenance: [provenance(options.revision ?? 'binding-revision-1', options.observedAt)],
      });
    },
  },
});

const proofFrom = (result: RetailPurchasingSubjectCurrentV1Response) =>
  Match.value(result).pipe(
    Match.tag('CURRENT', ({ proof }) => proof),
    Match.tag('STALE', () => null),
    Match.tag('UNAVAILABLE', () => null),
    Match.exhaustive,
  );

const outcome = (result: RetailPurchasingSubjectCurrentV1Response | VerifyRetailPurchasingSubjectCurrentV1Response) =>
  Match.value(result).pipe(
    Match.tag('CURRENT', () => 'CURRENT'),
    Match.tag('STALE', () => 'STALE'),
    Match.tag('UNAVAILABLE', () => 'UNAVAILABLE'),
    Match.exhaustive,
  );

describe('Retail purchasing subject Current proof v1', () => {
  it.effect('derives principal from trusted scope and verifies the exact profile binding at a fresh observation', () =>
    Effect.gen(function* currentProof() {
      const observed = yield* readRetailPurchasingSubjectCurrentV1(request, scope, servicesFor());
      const proof = proofFrom(observed);
      if (proof === null) {
        return;
      }
      expect(proof).toMatchObject({
        ownerRevision: 'binding-revision-1',
        principal: { principalId, tenantId },
        sellingLegalEntityRef: { resourceId: legalEntityId, tenantId },
      });

      const verifyRequest = Schema.decodeUnknownSync(VerifyRetailPurchasingSubjectCurrentV1RequestSchema)({
        observedProof: proof,
        profileRef,
      });
      const verified = yield* verifyRetailPurchasingSubjectCurrentV1(
        verifyRequest,
        scope,
        servicesFor({
          observedAt: '2026-09-28T10:01:00.000Z',
        }),
      );
      expect(outcome(verified)).toBe('CURRENT');
    }),
  );

  it.effect('rejects a proof observed for another trusted principal before consulting the owner', () =>
    Effect.gen(function* principalSubstitution() {
      const observed = yield* readRetailPurchasingSubjectCurrentV1(request, scope, servicesFor());
      const proof = proofFrom(observed);
      if (proof === null) {
        return;
      }
      const verifyRequest = Schema.decodeUnknownSync(VerifyRetailPurchasingSubjectCurrentV1RequestSchema)({
        observedProof: {
          ...proof,
          principal: { ...proof.principal, principalId: '44444444-4444-4444-8444-444444444444' },
        },
        profileRef,
      });
      const verified = yield* verifyRetailPurchasingSubjectCurrentV1(verifyRequest, scope, servicesFor());
      expect(outcome(verified)).toBe('STALE');
    }),
  );

  it.effect('returns STALE when the exact binding reference or owner revision changed', () =>
    Effect.gen(function* bindingRevisionChanges() {
      const observed = yield* readRetailPurchasingSubjectCurrentV1(request, scope, servicesFor());
      const proof = proofFrom(observed);
      if (proof === null) {
        return;
      }
      const verifyRequest = Schema.decodeUnknownSync(VerifyRetailPurchasingSubjectCurrentV1RequestSchema)({
        observedProof: proof,
        profileRef,
      });
      const changedBindingResult = yield* verifyRetailPurchasingSubjectCurrentV1(
        verifyRequest,
        scope,
        servicesFor({ binding: { ...bindingRef, resourceId: 'retail-binding-2' } }),
      );
      expect(outcome(changedBindingResult)).toBe('STALE');

      const changedRevision = yield* verifyRetailPurchasingSubjectCurrentV1(
        verifyRequest,
        scope,
        servicesFor({ revision: 'binding-revision-2' }),
      );
      expect(outcome(changedRevision)).toBe('STALE');
    }),
  );

  it.effect('returns STALE for a no-longer-bound principal and UNAVAILABLE when the owner read fails', () =>
    Effect.gen(function* nonCurrentOwner() {
      const observed = yield* readRetailPurchasingSubjectCurrentV1(request, scope, servicesFor());
      const proof = proofFrom(observed);
      if (proof === null) {
        return;
      }
      const verifyRequest = Schema.decodeUnknownSync(VerifyRetailPurchasingSubjectCurrentV1RequestSchema)({
        observedProof: proof,
        profileRef,
      });
      const stale = yield* verifyRetailPurchasingSubjectCurrentV1(
        verifyRequest,
        scope,
        servicesFor({ outcome: 'RETAIL_PRINCIPAL_NOT_BOUND' }),
      );
      expect(outcome(stale)).toBe('STALE');
      const unavailable = yield* verifyRetailPurchasingSubjectCurrentV1(
        verifyRequest,
        scope,
        servicesFor({ fail: true }),
      );
      expect(outcome(unavailable)).toBe('UNAVAILABLE');
    }),
  );

  it.effect('rejects an owner BOUND result for a different Profile', () =>
    Effect.gen(function* wrongOwnerProfile() {
      const result = yield* readRetailPurchasingSubjectCurrentV1(
        request,
        scope,
        servicesFor({ profile: { ...profileRef, resourceId: 'retail-profile-2' } }),
      );
      expect(outcome(result)).toBe('UNAVAILABLE');
    }),
  );
});
