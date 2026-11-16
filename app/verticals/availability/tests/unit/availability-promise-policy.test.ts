import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AvailabilityOwnerEvidenceUnverifiable } from '../../shared/domain/availability-owner-ports.ts';
import { AvailabilityLaunchPromisePolicySchema } from '../../shared/domain/availability-promise-policy.ts';
import { AvailabilitySubjectSchema } from '../../shared/domain/availability-subject.ts';
import { availabilityPromisePolicyService } from '../../src/services/availability-promise-policy.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const operationTime = '2026-10-05T12:00:00.000Z';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', '22222222-2222-4222-8222-222222222222');
const variantRef = ref('commerce.catalog.variant', '33333333-3333-4333-8333-333333333333');
const unitRef = ref('commerce.catalog.product-unit', '44444444-4444-4444-8444-444444444444');
const guestSubject = { guestEvidenceRef: 'guest-evidence', guestSessionRef: 'guest-session', kind: 'GUEST' };
const purchasingContext = {
  contextVerification: {
    evidence: {
      currentness: { evaluatedAt: operationTime, observedAt: operationTime, validFrom: operationTime, validTo: null },
      ownerRef: 'purchase-context',
      ownerRevisionRef: 'revision-1',
      subjectAuthority: {
        guestEvidenceAuthorityRef: 'guest-evidence-authority',
        guestSessionAuthorityRef: 'guest-session-authority',
        kind: 'GUEST',
        subject: guestSubject,
        subjectAuthorityRevisionRef: 'guest-revision-1',
      },
      verificationRef: 'verification-1',
      verifiedScope: { channelId: 'b2c', legalEntityId: 'seller', marketId: 'cz', tenantId },
    },
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request: {
      actor: { kind: 'GUEST' },
      operationTime,
      purchasingContext: {
        channelId: 'b2c',
        contextRef: 'purchase-context',
        contextRevision: 'revision-1',
        marketId: 'cz',
        sellingLegalEntityId: 'seller',
      },
      subject: guestSubject,
      tenantId,
    },
  },
};
const input = {
  purchasingContext,
  quantity: { amount: '5.00', unitRef },
  selection: { productRef, variantRef },
};

const subject = Schema.decodeUnknownSync(AvailabilitySubjectSchema)(input);
const useBoundary = { kind: 'CHECKOUT_SUBMISSION' as const, requiredAt: operationTime };

describe('Availability Launch promise policy', () => {
  it.effect('rejects an invalid exact request through the typed policy failure channel', () =>
    Effect.gen(function* rejectInvalidRequest() {
      const error = yield* availabilityPromisePolicyService
        .resolveCurrent({
          subject: { ...subject, quantity: { ...subject.quantity, amount: '0' } },
          useBoundary,
        })
        .pipe(Effect.flip);
      expect(Schema.is(AvailabilityOwnerEvidenceUnverifiable)(error)).toBe(true);
      expect(error.owner).toBe('AVAILABILITY_POLICY');
    }),
  );

  it.effect('binds the entire exact request and use boundary to the current owner policy revision', () =>
    Effect.gen(function* bindExactRequest() {
      const policy = yield* availabilityPromisePolicyService.resolveCurrent({ subject, useBoundary });
      expect(policy).toEqual({
        kind: 'LAUNCH_EXACT_QUANTITY',
        owner: 'AVAILABILITY',
        revisionRef: 'LAUNCH_EXACT_QUANTITY_V1',
        subject,
        useBoundary,
      });
      expect(policy.subject.quantity.amount).toBe('5.00');
      expect(policy.subject.quantity.unitRef).toEqual(unitRef);
    }),
  );

  it.effect('returns a deeply immutable snapshot without freezing or rewriting caller-owned inputs', () =>
    Effect.gen(function* freezeDetachedSnapshot() {
      const mutableQuantity = { ...subject.quantity };
      const mutableInput = { subject: { ...subject, quantity: mutableQuantity }, useBoundary };
      const original = structuredClone(mutableInput);
      const policy = yield* availabilityPromisePolicyService.resolveCurrent(mutableInput);
      expect(mutableInput).toEqual(original);
      expect(Object.isFrozen(mutableInput.subject)).toBe(false);
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.subject.quantity)).toBe(true);
      expect(Object.isFrozen(policy.subject.purchasingContext.contextVerification.evidence)).toBe(true);
      mutableQuantity.amount = '3';
      expect(policy.subject.quantity.amount).toBe('5.00');
    }),
  );

  it.effect('has no buffer, partial quantity, reservation-like deduction or fallback policy path', () =>
    Effect.gen(function* excludePolicyKnobs() {
      const policy = yield* availabilityPromisePolicyService.resolveCurrent({ subject, useBoundary });
      expect(Object.keys(policy)).toEqual(['kind', 'owner', 'revisionRef', 'subject', 'useBoundary']);
      const decode = Schema.decodeUnknownSync(AvailabilityLaunchPromisePolicySchema, { onExcessProperty: 'error' });
      for (const knob of [
        'safetyBuffer',
        'partialQuantity',
        'backorder',
        'preorder',
        'supplierPromise',
        'lastKnownFallback',
        'alternateBackend',
        'reservedLikeQuantity',
      ]) {
        expect(() => decode({ ...policy, [knob]: true })).toThrow();
      }
    }),
  );
});
