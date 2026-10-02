import {
  PricingMaterialDiscountSelectionSchema,
  PricingMaterialWholePurchaseDiscountSelectionSchema,
} from '@app/pricing-contracts/domain/material-evidence';
import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const evaluatedAt = '2026-09-28T10:00:00.000Z';

const guestSubject = {
  guestEvidenceRef: 'guest-evidence:791',
  guestSessionRef: 'guest-session:791',
  kind: 'GUEST' as const,
};

const guestSubjectEvidence = {
  currentness: { evaluatedAt, observedAt: evaluatedAt, validFrom: evaluatedAt, validTo: null },
  ownerRef: 'purchase-context:791',
  ownerRevisionRef: 'purchase-context-revision:791',
  subjectAuthority: {
    guestEvidenceAuthorityRef: 'guest-evidence-authority:791',
    guestSessionAuthorityRef: 'guest-session-authority:791',
    kind: 'GUEST' as const,
    subject: guestSubject,
    subjectAuthorityRevisionRef: 'guest-authority-revision:791',
  },
  verificationRef: 'purchase-context-verification:791',
};

const profileSubject = {
  authorizationSubject: { kind: 'RETAIL' as const },
  kind: 'PROFILE' as const,
  profileRef: {
    moduleId: 'commerce.customer-context' as const,
    resourceId: 'retail-profile:791',
    resourceType: 'commerce.customer-context.retail-customer-profile' as const,
    tenantId: '79100000-0000-4000-8000-000000000001',
  },
};

const profileSubjectEvidence = {
  ...guestSubjectEvidence,
  subjectAuthority: {
    actorPrincipalId: '79100000-0000-4000-8000-000000000002',
    kind: 'PROFILE' as const,
    partyAuthorityRef: 'party-authority:791',
    partyAuthorityRevisionRef: 'party-authority-revision:791',
    subject: profileSubject,
    subjectAuthorityRef: 'subject-authority:791',
    subjectAuthorityRevisionRef: 'subject-authority-revision:791',
  },
};

describe('Pricing material Discount selection #791', () => {
  it('retains an explicit Guest no-eligible-audience decision without inventing Discount absence', () => {
    expect(
      Schema.is(PricingMaterialDiscountSelectionSchema)({
        audienceDecision: { kind: 'GUEST' },
        kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE',
        subjectEvidence: guestSubjectEvidence,
      }),
    ).toBe(true);
  });

  it('rejects a forged Guest non-selection backed by Profile CCC subject evidence', () => {
    expect(
      Schema.is(PricingMaterialDiscountSelectionSchema)({
        audienceDecision: { kind: 'GUEST' },
        kind: 'DISCOUNT_NOT_SELECTED_NO_ELIGIBLE_AUDIENCE',
        subjectEvidence: profileSubjectEvidence,
      }),
    ).toBe(false);
  });

  it('represents assigned Price Group whole-purchase ineligibility without fabricating an owner read', () => {
    const scopeIneligible = {
      audienceKind: 'PRICE_GROUP',
      kind: 'DISCOUNT_NOT_SELECTED_SCOPE_INELIGIBLE',
      reason: 'PRICE_GROUP_LINE_SCOPE_ONLY',
      scope: 'WHOLE_PURCHASE',
      subjectEvidence: profileSubjectEvidence,
    } as const;

    expect(Schema.is(PricingMaterialWholePurchaseDiscountSelectionSchema)(scopeIneligible)).toBe(true);
    expect(Schema.is(PricingMaterialDiscountSelectionSchema)(scopeIneligible)).toBe(false);
    expect(
      Schema.is(PricingMaterialWholePurchaseDiscountSelectionSchema)({
        ...scopeIneligible,
        subjectEvidence: guestSubjectEvidence,
      }),
    ).toBe(false);
    expect(
      Schema.is(PricingMaterialWholePurchaseDiscountSelectionSchema)({
        ...scopeIneligible,
        subjectEvidence: {
          ...profileSubjectEvidence,
          subjectAuthority: {
            ...profileSubjectEvidence.subjectAuthority,
            subject: {
              ...profileSubject,
              authorizationSubject: {
                counterpartyRef: {
                  moduleId: 'party.registry',
                  resourceId: '79100000-0000-4000-8000-000000000003',
                  resourceType: 'party.registry.counterparty',
                  tenantId: profileSubject.profileRef.tenantId,
                },
                kind: 'COUNTERPARTY',
              },
              profileRef: {
                ...profileSubject.profileRef,
                resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
              },
            },
          },
        },
      }),
    ).toBe(false);
  });
});
