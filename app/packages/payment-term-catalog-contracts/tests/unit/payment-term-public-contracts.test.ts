import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import {
  CurrentPaymentTermsRequestSchema as PublicCurrentPaymentTermsRequestSchema,
  PaymentTermDefinitionSchema as PublicPaymentTermDefinitionSchema,
  PaymentTermRefSchema as PublicPaymentTermRefSchema,
  executeCurrentPaymentTerms,
  executeCurrentPaymentTermsWithAuthorization,
} from '../../src/index.ts';
import {
  CurrentPaymentTermsRequestSchema,
  CurrentPaymentTermsResponseSchema,
} from '../../src/apis/current-payment-terms.ts';
import {
  executeCurrentPaymentTerms as directExecuteCurrentPaymentTerms,
  executeCurrentPaymentTermsWithAuthorization as directExecuteCurrentPaymentTermsWithAuthorization,
} from '../../src/api/current-payment-terms-client.ts';
import {
  PaymentTermCanonicalSemanticsSchema,
  PaymentTermDefinitionSchema,
  PaymentTermDefinitionSnapshotSchema,
  PaymentTermInstantSchema,
  PaymentTermSemanticsSchema,
} from '../../src/domain/payment-term.ts';
import {
  PaymentTermReferenceRequestSchema,
  PaymentTermReferenceResolutionSchema,
} from '../../src/domain/payment-term-reference.ts';
import { PaymentTermRefSchema, paymentTermResourceDescriptor } from '../../src/resources/payment-term.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const provenance = {
  actionInvocationId: '33333333-3333-4333-8333-333333333333',
  actorPrincipalId: '44444444-4444-4444-8444-444444444444',
  at: '2026-09-09T10:00:00.000Z',
  reason: 'Approved launch catalog definition',
};
const net30 = {
  calculationRuleVersion: 2 as const,
  calendarRule: 'CALENDAR_DAYS' as const,
  days: 30,
  dueDateAnchor: 'INVOICE_ISSUE_DATE' as const,
  kind: 'NET_DAYS' as const,
};
const definition = {
  code: 'NET_30',
  compatibilityId: 'net_days.invoice_issue_date.calendar_days.v2',
  created: provenance,
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  description: 'Payment is due thirty calendar days after invoice issue.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE' as const,
  },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
  semantics: net30,
  updated: provenance,
};

describe('canonical Payment Term package surface', () => {
  it('publishes the canonical schemas and generated client functions from one package entrypoint', () => {
    expect(PublicPaymentTermRefSchema).toBe(PaymentTermRefSchema);
    expect(PublicPaymentTermDefinitionSchema).toBe(PaymentTermDefinitionSchema);
    expect(PublicCurrentPaymentTermsRequestSchema).toBe(CurrentPaymentTermsRequestSchema);
    expect(executeCurrentPaymentTerms).toBe(directExecuteCurrentPaymentTerms);
    expect(executeCurrentPaymentTermsWithAuthorization).toBe(directExecuteCurrentPaymentTermsWithAuthorization);
  });

  it('owns the exact stable ResourceRef identity and rejects boundary expansion', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermRefSchema, {
      onExcessProperty: 'error',
    });

    expect(decode(paymentTermRef)).toEqual(paymentTermRef);
    expect(paymentTermResourceDescriptor).toMatchObject({
      key: 'payment.term-catalog.payment-term',
      owningModuleId: 'payment.term-catalog',
    });
    expect(() => decode({ ...paymentTermRef, moduleId: 'commerce.customer-context' })).toThrow();
    expect(() => decode({ ...paymentTermRef, resourceType: 'payment.term-catalog.other' })).toThrow();
    expect(() => decode({ ...paymentTermRef, tenantId: ` ${tenantId}` })).toThrow();
    expect(() => decode({ ...paymentTermRef, privateCatalogId: 'must-not-cross-boundary' })).toThrow();
  });
});

describe('canonical Payment Term domain contract', () => {
  it('accepts canonical UTC instants and rejects normalized or impossible timestamps', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermInstantSchema);

    expect(decode('2026-09-09T10:00:00Z')).toBe('2026-09-09T10:00:00.000Z');
    expect(decode('2026-09-09T10:00:00.123Z')).toBe('2026-09-09T10:00:00.123Z');
    expect(() => decode('2026-09-09T12:00:00+02:00')).toThrow();
    expect(() => decode('2026-02-30T10:00:00.000Z')).toThrow();
  });

  it.effect('publishes only reusable semantics without consumer identities or an invoice evaluator', () =>
    Effect.gen(function* publicSemanticsSurface() {
      const publicContracts = yield* Effect.promise(() => import('../../src/index.ts'));
      expect(yield* Schema.decodeEffect(PaymentTermCanonicalSemanticsSchema)(net30)).toEqual(net30);
      expect(
        yield* Schema.decodeEffect(PaymentTermCanonicalSemanticsSchema)({
          calculationRuleVersion: 2,
          calendarRule: 'NOT_APPLICABLE',
          kind: 'IMMEDIATE',
        }),
      ).toEqual({ calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' });
      expect(publicContracts).not.toHaveProperty('PaymentTermConsumerCompatibilitySchema');
      expect(publicContracts).not.toHaveProperty('PaymentTermDueDateInputSchema');
      expect(publicContracts).not.toHaveProperty('PaymentTermDueDateResultSchema');
      expect(publicContracts).not.toHaveProperty('calculatePaymentTermDueDate');
    }),
  );

  it('bounds canonical net days to non-negative safe whole calendar days', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermCanonicalSemanticsSchema);
    for (const days of [0, 30, Number.MAX_SAFE_INTEGER]) {
      expect(decode({ ...net30, days })).toMatchObject({ days });
    }
    for (const days of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => decode({ ...net30, days })).toThrow();
    }
    expect(() => decode({ ...net30, kind: 'COD' })).toThrow();
    expect(() => decode({ ...net30, dueDateAnchor: 'INVOICE_ISSUED_AT' })).toThrow();
    expect(() => decode({ ...net30, calendarRule: 'CALENDAR_DAYS_UTC' })).toThrow();
  });

  it('retains legacy interpretation and identity without permitting it as new canonical meaning', () => {
    const legacySemantics = {
      ...net30,
      calculationRuleVersion: 1,
      calendarRule: 'CALENDAR_DAYS_UTC',
      dueDateAnchor: 'INVOICE_ISSUED_AT',
    };
    const legacy = {
      ...definition,
      compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
      compatibleWith: ['customer-payment-terms.v1'],
      semantics: legacySemantics,
    };
    expect(Schema.decodeUnknownSync(PaymentTermDefinitionSchema)(legacy)).toMatchObject({
      definitionRevisionId: definition.definitionRevisionId,
      paymentTermRef,
      semanticFingerprint: definition.semanticFingerprint,
      semanticRevisionId: definition.semanticRevisionId,
      semantics: legacySemantics,
    });
    expect(
      Schema.decodeSync(PaymentTermSemanticsSchema)({
        calculationRuleVersion: 1,
        calendarRule: 'NOT_APPLICABLE',
        kind: 'IMMEDIATE',
      }),
    ).toMatchObject({ calculationRuleVersion: 1 });
    expect(() => Schema.decodeUnknownSync(PaymentTermCanonicalSemanticsSchema)(legacySemantics)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(PaymentTermSemanticsSchema)({
        ...net30,
        calculationRuleVersion: 1,
      }),
    ).toThrow();
  });

  it('derives the consumer snapshot from owner fields and preserves lifecycle invariants', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermDefinitionSnapshotSchema);
    const snapshot = decode(definition);
    expect(snapshot).toMatchObject({ code: definition.code, paymentTermRef, semantics: net30 });
    expect(snapshot).not.toHaveProperty('created');
    expect(snapshot).not.toHaveProperty('compatibleWith');
    expect(() => decode({ ...definition, lifecycle: { ...definition.lifecycle, state: 'RETIRED' } })).toThrow();
    expect(() =>
      decode({
        ...definition,
        lifecycle: {
          effectiveFrom: '2026-10-02T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
          state: 'RETIRED',
        },
      }),
    ).toThrow();
    expect(
      decode({
        ...definition,
        lifecycle: {
          ...definition.lifecycle,
          effectiveTo: '2026-10-01T00:00:00.000Z',
          state: 'RETIRED',
        },
      }),
    ).toMatchObject({ lifecycle: { state: 'RETIRED' } });
  });

  it('keeps lifecycle state, effective period, and provenance consistent', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermDefinitionSchema);

    expect(decode(definition)).toMatchObject({ code: 'NET_30', metadataRevision: 1 });
    expect(() =>
      decode({
        ...definition,
        lifecycle: { ...definition.lifecycle, effectiveTo: '2026-10-01T00:00:00.000Z' },
      }),
    ).toThrow();
    expect(decode(definition)).not.toHaveProperty('compatibleWith');
    expect(() =>
      decode({
        ...definition,
        lifecycle: {
          effectiveFrom: '2026-10-02T00:00:00.000Z',
          effectiveTo: '2026-10-01T00:00:00.000Z',
          state: 'RETIRED',
        },
        retired: provenance,
      }),
    ).toThrow();
  });
});

describe('canonical current Payment Terms read contract', () => {
  it('bounds limits and reference-resolution batches at the public contract', () => {
    const decode = Schema.decodeUnknownSync(CurrentPaymentTermsRequestSchema);
    const reference = { paymentTermRef };
    const request = {
      at: '2026-09-09T10:00:00.000Z',
      limit: 200,
      references: Array.from({ length: 200 }, () => reference),
    };

    expect(decode(request).references).toHaveLength(200);
    expect(() => decode({ ...request, limit: 0 })).toThrow();
    expect(() => decode({ ...request, limit: 201 })).toThrow();
    expect(() => decode({ ...request, references: [...request.references, reference] })).toThrow();
  });

  it('checks owner semantic expectations without a consumer identity', () => {
    const request = {
      expectedCompatibilityId: definition.compatibilityId,
      expectedSemanticRevisionId: definition.semanticRevisionId,
      paymentTermRef,
    };
    expect(Schema.decodeSync(PaymentTermReferenceRequestSchema)(request)).toEqual(request);
    expect(() =>
      Schema.decodeUnknownSync(PaymentTermReferenceRequestSchema, {
        onExcessProperty: 'error',
      })({ ...request, expectedConsumerCompatibility: 'customer-payment-terms.v1' }),
    ).toThrow();
    const outcome = {
      actualCompatibilityId: definition.compatibilityId,
      actualSemanticRevisionId: definition.semanticRevisionId,
      definition,
      expectedCompatibilityId: 'different.owner.meaning.v2',
      kind: 'INCOMPATIBLE',
      requestedPaymentTermRef: paymentTermRef,
    };
    expect(Schema.decodeUnknownSync(PaymentTermReferenceResolutionSchema)(outcome)).toEqual(outcome);
  });

  it('decodes current definitions and discriminated reference outcomes together', () => {
    const missingOutcome = {
      kind: 'MISSING' as const,
      requestedPaymentTermRef: paymentTermRef,
    };
    const response = {
      current: [definition],
      effectiveAt: '2026-09-09T10:00:00.000Z',
      observedAt: '2026-09-09T10:00:01.000Z',
      referenceOutcomes: [missingOutcome],
      truncated: false,
    };

    expect(Schema.decodeSync(CurrentPaymentTermsResponseSchema)(response)).toMatchObject({
      current: [{ code: 'NET_30' }],
      referenceOutcomes: [missingOutcome],
    });
    expect(Schema.decodeSync(PaymentTermReferenceResolutionSchema)(missingOutcome)).toEqual(missingOutcome);
    expect(() =>
      Schema.decodeUnknownSync(PaymentTermReferenceResolutionSchema)({
        kind: 'AVAILABLE',
        requestedPaymentTermRef: paymentTermRef,
      }),
    ).toThrow();
  });
});
