import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import {
  PaymentTermAffectedUseAssessmentSchema as CanonicalPaymentTermAffectedUseAssessmentSchema,
  PaymentTermAffectedUseDispositionSchema as CanonicalPaymentTermAffectedUseDispositionSchema,
} from '@app/payment-term-catalog-contracts/payment-term';

import {
  PaymentTermAffectedUseAssessmentSchema,
  PaymentTermAffectedUseAssessmentRequestSchema,
  PaymentTermAffectedUseAssessmentResponseSchema,
  PaymentTermAffectedUseDispositionSchema,
  executePaymentTermAffectedUseAssessment,
  executePaymentTermAffectedUseAssessmentWithAuthorization,
} from '../../src/index.ts';

const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '11111111-1111-4111-8111-111111111111',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId: '22222222-2222-4222-8222-222222222222',
};

const request = {
  claimedAssessment: {
    currentCustomerEntitlementCount: 2,
    evidenceReference: 'customer-entitlements:revision-42',
    observedAt: '2026-09-09T10:00:00.000Z',
    openPurchaseCount: 0,
  },
  claimedDisposition: { kind: 'REJECT_IF_IN_USE' as const },
  effectiveAt: '2026-09-10T10:00:00.000Z',
  equivalentPaymentTermRefs: [],
  paymentTermRef,
};

describe('Customer-owned Payment Term affected-use public contract', () => {
  it('publishes one canonical schema and generated client surface', () => {
    expect(PaymentTermAffectedUseAssessmentSchema).toBe(CanonicalPaymentTermAffectedUseAssessmentSchema);
    expect(PaymentTermAffectedUseDispositionSchema).toBe(CanonicalPaymentTermAffectedUseDispositionSchema);
    expect(executePaymentTermAffectedUseAssessment).toBeTypeOf('function');
    expect(executePaymentTermAffectedUseAssessmentWithAuthorization).toBeTypeOf('function');
    expect(Schema.decodeSync(PaymentTermAffectedUseAssessmentRequestSchema)(request)).toEqual(request);
  });

  it('preserves exact Payment references, millisecond timestamps, and response outcomes', () => {
    expect(
      Schema.decodeSync(PaymentTermAffectedUseAssessmentResponseSchema)({
        assessment: request.claimedAssessment,
        disposition: request.claimedDisposition,
        kind: 'VERIFIED',
      }),
    ).toMatchObject({ kind: 'VERIFIED' });
    expect(() =>
      Schema.decodeSync(PaymentTermAffectedUseAssessmentRequestSchema)({
        ...request,
        effectiveAt: '2026-09-10T10:00:00Z',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PaymentTermAffectedUseAssessmentRequestSchema)({
        ...request,
        claimedAssessment: {
          ...request.claimedAssessment,
          observedAt: '2026-09-09T10:00:00Z',
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PaymentTermAffectedUseAssessmentRequestSchema)({
        ...request,
        paymentTermRef: { ...paymentTermRef, tenantId: ` ${paymentTermRef.tenantId}` },
      }),
    ).toThrow();
  });
});
