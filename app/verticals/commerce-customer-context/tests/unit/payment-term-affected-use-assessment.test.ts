import { ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { Effect, Option, Schema } from 'effect';
import {
  PaymentTermAffectedUseAssessmentRequestSchema,
  PaymentTermAffectedUseAssessmentResponseSchema,
} from '../../shared/apis/payment-term-affected-use-assessment.ts';
import type {
  PaymentTermAffectedUseAssessmentRequest,
  PaymentTermAffectedUseAssessmentResponse,
} from '../../shared/apis/payment-term-affected-use-assessment.ts';
import {
  handlePaymentTermAffectedUseAssessment,
  makePaymentTermAffectedUseAssessmentServices,
  paymentTermAffectedUseAssessmentEntrypoint,
} from '../../src/api/payment-term-affected-use-assessment.read.ts';
import type { PaymentTermAffectedUseAssessmentServices } from '../../src/api/payment-term-affected-use-assessment.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const request: PaymentTermAffectedUseAssessmentRequest = {
  claimedAssessment: {
    currentCustomerEntitlementCount: 99,
    evidenceReference: 'caller:evidence:untrusted',
    observedAt: '2026-09-09T10:00:00.000Z',
    openPurchaseCount: 77,
  },
  claimedDisposition: { kind: 'REJECT_IF_IN_USE' },
  effectiveAt: '2026-10-01T00:00:00.000Z',
  equivalentPaymentTermRefs: [],
  paymentTermRef,
};
const scope = {
  authMethod: 'system' as const,
  correlationId: 'payment-term-affected-use-assessment',
  legalEntityId: '33333333-3333-4333-8333-333333333333',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId,
};

const context = (services: PaymentTermAffectedUseAssessmentServices) => ({
  readKey: 'commerce.customer-context.api.payment-term-affected-use-assessment',
  scope,
  services,
});

it('requires catalog-wide read authority before exact affected-use resource access', () => {
  expect(paymentTermAffectedUseAssessmentEntrypoint.authorization).toEqual({
    kind: 'context_permission',
    permission: 'payment.term_catalog.read',
  });
});

it.effect('denies a cross-Tenant Payment Term before consulting the assessment service', () =>
  Effect.gen(function* crossTenantDenied() {
    let assessmentCalls = 0;
    const failure = yield* handlePaymentTermAffectedUseAssessment(
      {
        ...request,
        paymentTermRef: {
          ...paymentTermRef,
          tenantId: '55555555-5555-4555-8555-555555555555',
        },
      },
      context({
        assess: () => {
          assessmentCalls += 1;
          return Effect.succeed({ kind: 'REJECTED', reason: 'must not be observed' });
        },
      }),
    ).pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(assessmentCalls).toBe(0);
  }),
);

it.effect('denies a cross-Tenant equivalent reference before consulting the assessment service', () =>
  Effect.gen(function* crossTenantAliasDenied() {
    let assessmentCalls = 0;
    const failure = yield* handlePaymentTermAffectedUseAssessment(
      {
        ...request,
        equivalentPaymentTermRefs: [
          {
            ...paymentTermRef,
            resourceId: '66666666-6666-4666-8666-666666666666',
            tenantId: '55555555-5555-4555-8555-555555555555',
          },
        ],
      },
      context({
        assess: () => {
          assessmentCalls += 1;
          return Effect.succeed({ kind: 'REJECTED', reason: 'must not be observed' });
        },
      }),
    ).pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(assessmentCalls).toBe(0);
  }),
);

it.effect('returns the owner-authoritative assessment instead of the caller claim', () =>
  Effect.gen(function* authoritativeAssessment() {
    const authoritative: PaymentTermAffectedUseAssessmentResponse = {
      assessment: {
        currentCustomerEntitlementCount: 3,
        evidenceReference: 'customer-context:assessment:2026-09-09',
        observedAt: '2026-09-09T12:00:00.000Z',
        openPurchaseCount: 2,
      },
      disposition: {
        gracePolicyReference: 'policy:payment-term-retirement-grace:v1',
        kind: 'GRACE_POLICY',
      },
      kind: 'VERIFIED',
    };
    const result = yield* handlePaymentTermAffectedUseAssessment(
      request,
      context({ assess: () => Effect.succeed(authoritative) }),
    );

    expect(result).toEqual({ evidence: { resultCount: 1 }, result: authoritative });
    expect(result.result).not.toEqual({
      assessment: request.claimedAssessment,
      disposition: request.claimedDisposition,
      kind: 'VERIFIED',
    });
  }),
);

it.effect('returns an explicit rejection when the owner rejects the caller claim', () =>
  Effect.gen(function* rejectedClaim() {
    const rejected = {
      kind: 'REJECTED' as const,
      reason: 'The evidence or disposition does not match authoritative affected use',
    };
    const result = yield* handlePaymentTermAffectedUseAssessment(
      request,
      context({ assess: () => Effect.succeed(rejected) }),
    );

    expect(result).toEqual({ evidence: { resultCount: 0 }, result: rejected });
  }),
);

it.effect('preserves an unavailable dependency failure from the assessment service', () =>
  Effect.gen(function* unavailableAssessment() {
    const unavailable = new ReadHandlerUnavailable({
      code: 'read_handler_unavailable',
      reason: 'Customer Payment Term affected-use evidence is unavailable',
    });
    const failure = yield* handlePaymentTermAffectedUseAssessment(
      request,
      context({ assess: () => Effect.fail(unavailable) }),
    ).pipe(Effect.flip);

    expect(failure).toBe(unavailable);
  }),
);

it.effect('fails closed before assuming zero open purchases when the Order owner is absent', () =>
  Effect.gen(function* absentOrderOwner() {
    let customerAssessmentCalls = 0;
    const services = makePaymentTermAffectedUseAssessmentServices({
      customerEntitlementUse: {
        assess: () => {
          customerAssessmentCalls += 1;
          return Effect.succeed({
            currentCustomerEntitlementCount: 0,
            evidenceReference: 'customer-context:payment-term-use:0',
            observedAt: '2026-09-09T12:00:00.000Z',
          });
        },
      },
      externalAuthority: Option.none(),
    });

    const failure = yield* services.assess(request).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('Accepted Order owner');
    expect(customerAssessmentCalls).toBe(0);
  }),
);

it.effect('inventories the canonical and every equivalent reference through both owners', () =>
  Effect.gen(function* inventoriesAllReferences() {
    const equivalentPaymentTermRef = {
      ...paymentTermRef,
      resourceId: '66666666-6666-4666-8666-666666666666',
    };
    let customerRefs: readonly (typeof paymentTermRef)[] = [];
    let purchaseRefs: readonly (typeof paymentTermRef)[] = [];
    const services = makePaymentTermAffectedUseAssessmentServices({
      customerEntitlementUse: {
        assess: ({ paymentTermRefs }) => {
          customerRefs = paymentTermRefs;
          return Effect.succeed({
            currentCustomerEntitlementCount: 0,
            evidenceReference: 'customer-context:payment-term-use:0',
            observedAt: '2026-09-09T12:00:00.000Z',
          });
        },
      },
      externalAuthority: Option.some({
        assessOpenPurchases: ({ equivalentPaymentTermRefs, paymentTermRef: canonical }) => {
          purchaseRefs = [canonical, ...equivalentPaymentTermRefs];
          return Effect.succeed({
            evidenceReference: 'accepted-order:payment-term-use:0',
            observedAt: '2026-09-09T12:00:00.000Z',
            openPurchaseCount: 0,
          });
        },
        verifyDisposition: () => Effect.succeed(true),
      }),
    });

    const result = yield* services.assess({
      ...request,
      claimedAssessment: {
        ...request.claimedAssessment,
        currentCustomerEntitlementCount: 0,
        observedAt: '2026-09-09T12:00:00.000Z',
        openPurchaseCount: 0,
      },
      equivalentPaymentTermRefs: [equivalentPaymentTermRef, equivalentPaymentTermRef],
    });

    expect(result.kind).toBe('VERIFIED');
    expect(customerRefs).toEqual([paymentTermRef, equivalentPaymentTermRef]);
    expect(purchaseRefs).toEqual([paymentTermRef, equivalentPaymentTermRef]);
  }),
);

it('rejects padded references and text plus negative, fractional, or non-finite counts', () => {
  const isRequest = Schema.is(PaymentTermAffectedUseAssessmentRequestSchema);
  const isResponse = Schema.is(PaymentTermAffectedUseAssessmentResponseSchema);

  expect(
    isRequest({
      ...request,
      paymentTermRef: { ...paymentTermRef, resourceId: ` ${paymentTermRef.resourceId} ` },
    }),
  ).toBe(false);
  expect(
    isRequest({
      ...request,
      claimedAssessment: { ...request.claimedAssessment, evidenceReference: ' padded ' },
    }),
  ).toBe(false);
  expect(
    isRequest({
      ...request,
      claimedDisposition: { kind: 'EXPLICIT_MIGRATION', migrationReference: ' padded ' },
    }),
  ).toBe(false);
  for (const invalidCount of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    expect(
      isRequest({
        ...request,
        claimedAssessment: {
          ...request.claimedAssessment,
          currentCustomerEntitlementCount: invalidCount,
        },
      }),
    ).toBe(false);
  }
  expect(isResponse({ kind: 'REJECTED', reason: ' padded ' })).toBe(false);
});
