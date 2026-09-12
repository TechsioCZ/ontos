import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';
import { NetDaysPaymentTermSemanticsSchema, PaymentTermDefinitionSchema } from '../../shared/domain/payment-term.ts';
import {
  calculatePaymentTermDueDate,
  canonicalPaymentTermSemantics,
  paymentTermCompatibilityId,
  paymentTermIsCurrentAt,
  paymentTermSemanticsAreEquivalent,
} from '../../src/domain/payment-term-behavior.ts';
import { PaymentTermReferenceResolutionSchema } from '../../shared/domain/payment-term-reference.ts';
import type { PaymentTermRef } from '../../shared/resources/payment-term.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
} satisfies PaymentTermRef;
const provenance = {
  actionInvocationId: '33333333-3333-4333-8333-333333333333',
  actorPrincipalId: '44444444-4444-4444-8444-444444444444',
  at: '2026-09-09T10:00:00.000Z',
  reason: 'Approved launch catalog definition',
} as const;
const immediate = {
  calculationRuleVersion: 1,
  calendarRule: 'NOT_APPLICABLE',
  kind: 'IMMEDIATE',
} as const;
const net30 = {
  calculationRuleVersion: 1,
  calendarRule: 'CALENDAR_DAYS_UTC',
  days: 30,
  dueDateAnchor: 'INVOICE_ISSUED_AT',
  kind: 'NET_DAYS',
} as const;
const definition = {
  code: 'NET_30',
  compatibilityId: paymentTermCompatibilityId(net30),
  compatibleWith: ['customer-payment-terms.v1'],
  created: provenance,
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  description: 'Payment is due thirty UTC calendar days after invoice issue.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
  semantics: net30,
  updated: provenance,
} as const;

describe('Payment Term semantics', () => {
  it('accepts only non-negative whole NET_DAYS with the exact launch anchor', () => {
    const decode = Schema.decodeUnknownSync(NetDaysPaymentTermSemanticsSchema);

    expect(decode(net30)).toEqual(net30);
    expect(() => decode({ ...net30, days: -1 })).toThrow();
    expect(() => decode({ ...net30, days: 1.5 })).toThrow();
    expect(decode({ ...net30, days: 100_000 }).days).toBe(100_000);
    expect(decode({ ...net30, days: Number.MAX_SAFE_INTEGER }).days).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => decode({ ...net30, dueDateAnchor: 'ORDER_ACCEPTED_AT' })).toThrow();
  });

  it('calculates launch semantics deterministically in UTC calendar days', () => {
    expect(
      calculatePaymentTermDueDate(immediate, {
        acceptedAt: '2026-01-31T23:15:00.000Z',
      }),
    ).toEqual({ dueAt: '2026-01-31T23:15:00.000Z', kind: 'CALCULATED' });
    expect(
      calculatePaymentTermDueDate(net30, {
        acceptedAt: '2026-01-01T00:00:00.000Z',
        invoiceIssuedAt: '2026-01-31T23:15:00.000Z',
      }),
    ).toEqual({ dueAt: '2026-03-02T23:15:00.000Z', kind: 'CALCULATED' });
    expect(
      calculatePaymentTermDueDate(net30, {
        acceptedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toEqual({ anchor: 'INVOICE_ISSUED_AT', kind: 'MISSING_ANCHOR' });
    expect(
      calculatePaymentTermDueDate(
        { ...net30, days: Number.MAX_SAFE_INTEGER },
        {
          acceptedAt: '2026-01-01T00:00:00.000Z',
          invoiceIssuedAt: '2026-01-01T00:00:00.000Z',
        },
      ),
    ).toEqual({
      kind: 'OUT_OF_RANGE',
      reason: 'DUE_DATE_OUTSIDE_SUPPORTED_INSTANT_RANGE',
    });
  });

  it('derives compatibility from the kind contract while preserving exact semantics separately', () => {
    expect(paymentTermCompatibilityId(net30)).toBe('net_days.invoice_issued_at.calendar_days_utc.v1');
    expect(canonicalPaymentTermSemantics(net30)).toContain('/30/');
    expect(paymentTermSemanticsAreEquivalent(net30, { ...net30, days: 14 })).toBe(false);
  });
});

describe('Payment Term lifecycle and reference contracts', () => {
  it('uses a half-open effective period', () => {
    const retired = {
      ...definition,
      lifecycle: {
        ...definition.lifecycle,
        effectiveTo: '2026-10-01T00:00:00.000Z',
        state: 'RETIRED',
      },
      retired: { ...provenance, at: '2026-10-01T00:00:00.000Z' },
    } as const;

    expect(paymentTermIsCurrentAt(retired, '2026-09-30T23:59:59.999Z')).toBe(true);
    expect(paymentTermIsCurrentAt(retired, '2026-10-01T00:00:00.000Z')).toBe(false);
  });

  it('keeps immutable semantic evidence in every definition revision', () => {
    const decoded = Schema.decodeUnknownSync(PaymentTermDefinitionSchema)(definition);

    expect(decoded.definitionRevisionId).toBe('55555555-5555-4555-8555-555555555555');
    expect(decoded.semanticRevisionId).toBe('66666666-6666-4666-8666-666666666666');
    expect(decoded.semanticFingerprint).toHaveLength(64);
  });

  it('rejects contradictory lifecycle, period, and retirement provenance', () => {
    const decode = Schema.decodeUnknownSync(PaymentTermDefinitionSchema);

    expect(() =>
      decode({
        ...definition,
        lifecycle: { ...definition.lifecycle, effectiveTo: '2026-10-01T00:00:00.000Z' },
      }),
    ).toThrow();
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

  it('distinguishes a broken reference from absence or retirement', () => {
    const outcome = Schema.decodeUnknownSync(PaymentTermReferenceResolutionSchema)({
      kind: 'BROKEN',
      reason: 'Stored definition failed its semantic invariant',
      requestedPaymentTermRef: paymentTermRef,
    });

    expect(outcome.kind).toBe('BROKEN');
  });
});
