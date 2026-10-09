import type { PricingQuotationBinding, PricingQuotationGuestBinding } from '@app/pricing-contracts/domain/quotation';
import { PricingQuotationBindingSchema } from '@app/pricing-contracts/domain/quotation';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makePricingGuestQuotationAuthorityService,
  PricingGuestPurchaseContextRejected,
  PricingGuestPurchaseContextUnavailable,
  PricingGuestQuotationAuthorityRejected,
  PricingGuestQuotationAuthorityUnavailable,
} from '../../src/services/guest-quotation-authority.service.ts';
import type { PricingGuestPurchaseContextAuthorityPort } from '../../src/services/guest-quotation-authority.service.ts';
import {
  candidateRef,
  makeIssue779PreRoundScenario,
  requireIssue779ProductUnitRef,
} from './support/issue-779-line-value.fixture.ts';

const quotationRef = 'pricing-quotation:guest:783';

const guestSubject = {
  guestEvidenceRef: 'guest-evidence:783',
  guestSessionRef: 'guest-session:783',
  kind: 'GUEST',
  purchaseContext: {
    contextRef: 'purchase-context:783',
    contextRevision: 'purchase-context-revision:783',
  },
} satisfies PricingQuotationGuestBinding;

const bindingFixture = Effect.fn('test.issue783GuestBinding')(function* issue783GuestBinding() {
  const { preRound } = yield* makeIssue779PreRoundScenario();
  const { decision } = preRound;
  return yield* Schema.decodeEffect(PricingQuotationBindingSchema)({
    candidateRef,
    commercialScope: decision.commercialScope,
    currencyCode: decision.currencyCode,
    lines: decision.lines.map((line) => ({
      occurrenceId: line.occurrenceId,
      quantity: {
        amount: line.catalog.quantity.resulting,
        unitRef: requireIssue779ProductUnitRef(line.catalog.unitRef),
      },
      selection: line.catalog.selection,
    })),
    monetaryBoundary: decision.monetaryBoundary,
    subject: guestSubject,
    tenantId: decision.tenantId,
  });
});

const successfulOwner = () => {
  const attempts: unknown[] = [];
  const port: PricingGuestPurchaseContextAuthorityPort = {
    verifyGuestPurchaseContext: (input) => {
      attempts.push(input);
      return Effect.succeed({
        binding: input.binding,
        kind: 'GUEST_PURCHASE_CONTEXT_AUTHORITY_VERIFIED' as const,
      });
    },
  };
  return {
    attempts,
    port,
  } as const;
};

describe('Guest Pricing Quotation authority', () => {
  it.effect('requires the owner to verify the exact Guest context and full quoted purchase binding', () =>
    Effect.gen(function* verifiesExactGuestAuthority() {
      const binding = yield* bindingFixture();
      const owner = successfulOwner();
      const service = makePricingGuestQuotationAuthorityService(owner.port);

      const verified = yield* service.verify({
        quotationRef,
        quotedBinding: binding,
        requestedBinding: binding,
        requestOriginRef: 'storefront:one',
      });

      expect(verified).toEqual({
        binding,
        kind: 'PRICING_GUEST_QUOTATION_AUTHORITY_VERIFIED',
        quotationRef,
      });
      expect(owner.attempts).toEqual([{ binding, quotationRef }]);
    }),
  );

  it.effect('does not let Storefront origin change economics, binding, or authority', () =>
    Effect.gen(function* ignoresOriginForAuthority() {
      const binding = yield* bindingFixture();
      const owner = successfulOwner();
      const service = makePricingGuestQuotationAuthorityService(owner.port);

      const fromOne = yield* service.verify({
        quotationRef,
        quotedBinding: binding,
        requestedBinding: binding,
        requestOriginRef: 'storefront:one',
      });
      const fromTwo = yield* service.verify({
        quotationRef,
        quotedBinding: binding,
        requestedBinding: binding,
        requestOriginRef: 'storefront:two',
      });

      expect(fromTwo).toEqual(fromOne);
      expect(owner.attempts).toEqual([
        { binding, quotationRef },
        { binding, quotationRef },
      ]);
    }),
  );

  it.effect(
    'rejects a different Guest session, context, evidence, candidate, seller, Channel, Market, or currency',
    () =>
      Effect.gen(function* rejectsMaterialChanges() {
        const binding = yield* bindingFixture();
        const changedBindings: PricingQuotationBinding[] = [
          {
            ...binding,
            subject: { ...guestSubject, guestSessionRef: 'guest-session:different' },
          },
          {
            ...binding,
            subject: {
              ...guestSubject,
              purchaseContext: { ...guestSubject.purchaseContext, contextRef: 'purchase-context:different' },
            },
          },
          {
            ...binding,
            subject: { ...guestSubject, guestEvidenceRef: 'guest-evidence:different' },
          },
          { ...binding, candidateRef: 'candidate:different' },
          {
            ...binding,
            commercialScope: {
              ...binding.commercialScope,
              sellingLegalEntityId: '90909090-9090-4090-8090-909090909090',
            },
          },
          {
            ...binding,
            commercialScope: {
              ...binding.commercialScope,
              channelId: binding.commercialScope.channelId === 'B2C' ? 'B2B' : 'B2C',
            },
          },
          { ...binding, commercialScope: { ...binding.commercialScope, marketId: 'market:different' } },
          { ...binding, currencyCode: 'EUR' },
        ];
        const owner = successfulOwner();
        const service = makePricingGuestQuotationAuthorityService(owner.port);

        for (const requestedBinding of changedBindings) {
          const failure = yield* service
            .verify({ quotationRef, quotedBinding: binding, requestedBinding })
            .pipe(Effect.flip);
          expect(failure).toEqual(
            new PricingGuestQuotationAuthorityRejected({ reason: 'EXACT_GUEST_BINDING_MISMATCH' }),
          );
        }
        expect(owner.attempts).toHaveLength(0);
      }),
  );

  it.effect('rejects Guest-to-authenticated transition and fake subject/profile/principal claims', () =>
    Effect.gen(function* rejectsIdentitySubstitution() {
      const binding = yield* bindingFixture();
      const owner = successfulOwner();
      const service = makePricingGuestQuotationAuthorityService(owner.port);
      const authenticated: PricingQuotationBinding = {
        ...binding,
        subject: {
          kind: 'AUTHENTICATED',
          purchaseContext: guestSubject.purchaseContext,
          subjectEvidenceRef: 'subject-evidence:783',
          subjectRef: {
            moduleId: 'commerce-customer-context',
            resourceId: 'profile:783',
            resourceType: 'CUSTOMER_PROFILE',
            tenantId: binding.tenantId,
          },
        },
      };

      const transition = yield* service
        .verify({ quotationRef, quotedBinding: binding, requestedBinding: authenticated })
        .pipe(Effect.flip);
      expect(transition).toEqual(
        new PricingGuestQuotationAuthorityRejected({ reason: 'GUEST_TO_AUTHENTICATED_TRANSITION' }),
      );

      const fakeSubject = {
        quotationRef,
        quotedBinding: binding,
        requestedBinding: {
          ...binding,
          subject: {
            ...guestSubject,
            principalRef: 'principal:fake',
            profileRef: 'profile:fake',
            purchasingSubjectRef: 'purchasing-subject:fake',
          },
        },
      };
      const fakeFailure = yield* service.verify(fakeSubject).pipe(Effect.flip);
      expect(fakeFailure).toEqual(new PricingGuestQuotationAuthorityRejected({ reason: 'INVALID_REQUEST' }));
      expect(owner.attempts).toHaveLength(0);
    }),
  );

  it.effect('never treats knowledge of a quotation reference as Guest authority', () =>
    Effect.gen(function* rejectsBearerKnowledge() {
      const owner = successfulOwner();
      const failure = yield* makePricingGuestQuotationAuthorityService(owner.port)
        // @ts-expect-error Intentionally proves a bare bearer reference cannot cross the runtime decoder.
        .verify({ quotationRef })
        .pipe(Effect.flip);

      expect(failure).toEqual(new PricingGuestQuotationAuthorityRejected({ reason: 'INVALID_REQUEST' }));
      expect(owner.attempts).toHaveLength(0);
    }),
  );

  it.effect('keeps owner denial and owner unavailability typed and fail-closed', () =>
    Effect.gen(function* keepsOwnerFailuresTyped() {
      const binding = yield* bindingFixture();
      const request = { quotationRef, quotedBinding: binding, requestedBinding: binding };
      const denied = yield* makePricingGuestQuotationAuthorityService({
        verifyGuestPurchaseContext: () =>
          Effect.fail(new PricingGuestPurchaseContextRejected({ reason: 'SESSION_NOT_AUTHORIZED' })),
      })
        .verify(request)
        .pipe(Effect.flip);
      expect(denied).toEqual(new PricingGuestQuotationAuthorityRejected({ reason: 'OWNER_REJECTED' }));

      const unavailable = yield* makePricingGuestQuotationAuthorityService({
        verifyGuestPurchaseContext: () =>
          Effect.fail(
            new PricingGuestPurchaseContextUnavailable({
              reason: 'OWNER_VERIFICATION_UNAVAILABLE',
              retryable: true,
            }),
          ),
      })
        .verify(request)
        .pipe(Effect.flip);
      expect(unavailable).toEqual(
        new PricingGuestQuotationAuthorityUnavailable({
          reason: 'OWNER_VERIFICATION_UNAVAILABLE',
          retryable: true,
        }),
      );
    }),
  );

  it.effect('fails typed when owner verification returns a different or malformed binding', () =>
    Effect.gen(function* rejectsUnverifiableOwnerEvidence() {
      const binding = yield* bindingFixture();
      const service = makePricingGuestQuotationAuthorityService({
        verifyGuestPurchaseContext: ({ binding: requestedBinding }) =>
          Effect.succeed({
            binding: { ...requestedBinding, candidateRef: 'candidate:owner-mismatch' },
            kind: 'GUEST_PURCHASE_CONTEXT_AUTHORITY_VERIFIED',
          }),
      });
      const failure = yield* service
        .verify({ quotationRef, quotedBinding: binding, requestedBinding: binding })
        .pipe(Effect.flip);

      expect(failure).toEqual(
        new PricingGuestQuotationAuthorityUnavailable({
          reason: 'OWNER_EVIDENCE_UNVERIFIABLE',
          retryable: true,
        }),
      );
    }),
  );
});
