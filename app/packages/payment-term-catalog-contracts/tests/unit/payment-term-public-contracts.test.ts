import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
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
  PaymentTermDefinitionSchema,
  PaymentTermInstantSchema,
} from '../../src/domain/payment-term.ts';
import { PaymentTermReferenceResolutionSchema } from '../../src/domain/payment-term-reference.ts';
import {
  PaymentTermRefSchema,
  paymentTermResourceDescriptor,
} from '../../src/resources/payment-term.ts';

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
  calculationRuleVersion: 1 as const,
  calendarRule: 'CALENDAR_DAYS_UTC' as const,
  days: 30,
  dueDateAnchor: 'INVOICE_ISSUED_AT' as const,
  kind: 'NET_DAYS' as const,
};
const definition = {
  code: 'NET_30',
  compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
  compatibleWith: ['customer-payment-terms.v1' as const],
  created: provenance,
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  description: 'Payment is due thirty UTC calendar days after invoice issue.',
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
    expect(executeCurrentPaymentTermsWithAuthorization).toBe(
      directExecuteCurrentPaymentTermsWithAuthorization,
    );
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
    expect(() =>
      decode({ ...paymentTermRef, resourceType: 'payment.term-catalog.other' }),
    ).toThrow();
    expect(() => decode({ ...paymentTermRef, tenantId: ` ${tenantId}` })).toThrow();
    expect(() =>
      decode({ ...paymentTermRef, privateCatalogId: 'must-not-cross-boundary' }),
    ).toThrow();
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

  it('keeps lifecycle state, effective period, compatibility, and provenance consistent', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermDefinitionSchema);

    expect(decode(definition)).toMatchObject({ code: 'NET_30', metadataRevision: 1 });
    expect(() =>
      decode({
        ...definition,
        lifecycle: { ...definition.lifecycle, effectiveTo: '2026-10-01T00:00:00.000Z' },
      }),
    ).toThrow();
    expect(() => decode({ ...definition, compatibleWith: [] })).toThrow();
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

    expect(Schema.decodeUnknownSync(CurrentPaymentTermsResponseSchema)(response)).toMatchObject({
      current: [{ code: 'NET_30' }],
      referenceOutcomes: [missingOutcome],
    });
    expect(Schema.decodeUnknownSync(PaymentTermReferenceResolutionSchema)(missingOutcome)).toEqual(
      missingOutcome,
    );
    expect(() =>
      Schema.decodeUnknownSync(PaymentTermReferenceResolutionSchema)({
        kind: 'AVAILABLE',
        requestedPaymentTermRef: paymentTermRef,
      }),
    ).toThrow();
  });
});
