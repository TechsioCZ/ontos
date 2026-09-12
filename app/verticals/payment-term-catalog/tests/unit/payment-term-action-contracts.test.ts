import { describe, expect, it } from 'effect-rstest';
import { Effect, Predicate, Schema } from 'effect';
import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { getActionResourcePermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadResourcePermissionTargetResolver } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { CurrentPaymentTermsRequestSchema } from '../../shared/apis/current-payment-terms.ts';
import {
  CreatePaymentTermPayloadSchema,
  createPaymentTermAction,
} from '../../src/actions/create-payment-term.action.ts';
import {
  CorrectPaymentTermPayloadSchema,
  correctPaymentTermAction,
} from '../../src/actions/correct-payment-term.action.ts';
import {
  ReconcilePaymentTermReferencePayloadSchema,
  reconcilePaymentTermReferenceAction,
} from '../../src/actions/reconcile-payment-term-reference.action.ts';
import {
  RetirePaymentTermPayloadSchema,
  retirePaymentTermAction,
} from '../../src/actions/retire-payment-term.action.ts';
import { currentPaymentTermsRead } from '../../src/api/current-payment-terms.read.ts';
import { paymentTermHistoryRead } from '../../src/api/payment-term-history.read.ts';
import type { PaymentTermRef } from '../../shared/resources/payment-term.ts';
import { OutboxPayloadSchema as CreatedOutboxPayloadSchema } from '../../shared/outbox/payment-term-catalog-payment-term-created-v1.ts';
import { OutboxPayloadSchema as CorrectedOutboxPayloadSchema } from '../../shared/outbox/payment-term-catalog-payment-term-metadata-corrected-v1.ts';
import { OutboxPayloadSchema as ReconciledOutboxPayloadSchema } from '../../shared/outbox/payment-term-catalog-payment-term-reference-reconciled-v1.ts';
import { OutboxPayloadSchema as RetiredOutboxPayloadSchema } from '../../shared/outbox/payment-term-catalog-payment-term-retired-v1.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentTermRef = (resourceId: string): PaymentTermRef => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});
const first = paymentTermRef('22222222-2222-4222-8222-222222222222');
const second = paymentTermRef('33333333-3333-4333-8333-333333333333');
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const scope = {
  authBindingId: '77777777-7777-4777-8777-777777777777',
  authContextRef: 'better-auth-session:payment-term-contract',
  authMethod: 'session' as const,
  correlationId: 'payment-term-contract',
  legalEntityId,
  principalId: '88888888-8888-4888-8888-888888888888',
  tenantId,
};

describe('Payment Term mutation contracts', () => {
  it('rejects blank and padded user-facing text', () => {
    const create = {
      activeFrom: '2026-01-01T00:00:00.000Z',
      code: 'NET_30',
      description: 'Due in thirty days.',
      name: 'Net 30',
      reason: 'Approved catalog definition',
      semantics: {
        calculationRuleVersion: 1,
        calendarRule: 'CALENDAR_DAYS_UTC',
        days: 30,
        dueDateAnchor: 'INVOICE_ISSUED_AT',
        kind: 'NET_DAYS',
      },
    } as const;
    const decode = Schema.decodeUnknownSync(CreatePaymentTermPayloadSchema);

    expect(() => decode({ ...create, name: '   ' })).toThrow();
    expect(() => decode({ ...create, name: ' Net 30' })).toThrow();
    expect(() => decode({ ...create, description: 'Due in thirty days. ' })).toThrow();
    expect(() => decode({ ...create, reason: '\t' })).toThrow();
  });

  it('caps reference-resolution batches at 200', () => {
    const request = {
      at: '2026-01-01T00:00:00.000Z',
      limit: 50,
      references: Array.from({ length: 201 }, () => ({ paymentTermRef: first })),
    };

    expect(() => Schema.decodeUnknownSync(CurrentPaymentTermsRequestSchema)(request)).toThrow();
    expect(
      Schema.decodeUnknownSync(CurrentPaymentTermsRequestSchema)({
        ...request,
        references: request.references.slice(0, 200),
      }).references,
    ).toHaveLength(200);
  });

  it('allows only cosmetic fields in correction and requires a stale-write guard', () => {
    const decode = Schema.decodeUnknownSync(CorrectPaymentTermPayloadSchema, {
      onExcessProperty: 'error',
    });
    const valid = {
      description: 'Clarified wording without contractual change.',
      expectedMetadataRevision: 2,
      name: 'Net 30',
      paymentTermRef: first,
      reason: 'Correct a typographical error',
    };

    expect(decode(valid).expectedMetadataRevision).toBe(2);
    expect(() => decode({ ...valid, semantics: { kind: 'IMMEDIATE' } })).toThrow();
    expect(() => decode({ ...valid, expectedMetadataRevision: 0 })).toThrow();
  });

  it('requires the observed revision for retirement', () => {
    const decode = Schema.decodeUnknownSync(RetirePaymentTermPayloadSchema);

    expect(
      decode({
        affectedUseAssessment: {
          currentCustomerEntitlementCount: 0,
          evidenceReference: 'commerce-read:abc',
          observedAt: '2026-09-09T10:00:00.000Z',
          openPurchaseCount: 0,
        },
        affectedUseDisposition: { kind: 'REJECT_IF_IN_USE' },
        effectiveAt: '2026-10-01T00:00:00.000Z',
        expectedMetadataRevision: 3,
        paymentTermRef: first,
        reason: 'Retire from new commercial use',
      }).expectedMetadataRevision,
    ).toBe(3);
  });

  it('guards both sides of explicit duplicate reconciliation', () => {
    const decode = Schema.decodeUnknownSync(ReconcilePaymentTermReferencePayloadSchema);

    expect(
      decode({
        aliasPaymentTermRef: first,
        canonicalPaymentTermRef: second,
        expectedAliasMetadataRevision: 1,
        expectedCanonicalMetadataRevision: 4,
        reason: 'Verified genuinely equivalent migrated definitions',
      }),
    ).toMatchObject({
      expectedAliasMetadataRevision: 1,
      expectedCanonicalMetadataRevision: 4,
    });
  });

  it('publishes exact safe payloads instead of generic JSON envelopes', () => {
    const definitionEvidence = {
      compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
      definitionRevisionId: '44444444-4444-4444-8444-444444444444',
      metadataRevision: 2,
      paymentTermRef: first,
      semanticRevisionId: '55555555-5555-4555-8555-555555555555',
    };

    expect(Schema.decodeUnknownSync(CreatedOutboxPayloadSchema)(definitionEvidence)).toEqual(definitionEvidence);
    expect(
      Schema.decodeUnknownSync(CorrectedOutboxPayloadSchema)({
        ...definitionEvidence,
        changed: true,
      }),
    ).toMatchObject({ changed: true });
    expect(
      Schema.decodeUnknownSync(RetiredOutboxPayloadSchema)({
        ...definitionEvidence,
        changed: true,
        retiredEffectiveAt: '2026-10-01T00:00:00.000Z',
      }),
    ).toMatchObject({ retiredEffectiveAt: '2026-10-01T00:00:00.000Z' });
    expect(
      Schema.decodeUnknownSync(ReconciledOutboxPayloadSchema)({
        aliasPaymentTermRef: first,
        canonicalPaymentTermRef: second,
        changed: true,
      }),
    ).toMatchObject({ changed: true });
    expect(() => Schema.decodeUnknownSync(CreatedOutboxPayloadSchema)({ data: {} })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CorrectedOutboxPayloadSchema)({
        ...definitionEvidence,
        changed: false,
      }),
    ).toThrow();
  });

  it('targets the exact catalog root or Payment Term resource before execution', () => {
    const createPayload = {
      activeFrom: '2026-01-01T00:00:00.000Z',
      code: 'NET_30',
      description: 'Due in thirty days.',
      name: 'Net 30',
      reason: 'Approved catalog definition',
      semantics: {
        calculationRuleVersion: 1,
        calendarRule: 'CALENDAR_DAYS_UTC',
        days: 30,
        dueDateAnchor: 'INVOICE_ISSUED_AT',
        kind: 'NET_DAYS',
      },
    } as const;
    const existingPayload = {
      description: 'Updated copy.',
      expectedMetadataRevision: 1,
      name: 'Net 30',
      paymentTermRef: first,
      reason: 'Copy correction',
    };

    expect(getActionResourcePermissionTargetResolver(createPaymentTermAction)?.(createPayload, scope)).toEqual({
      permission: 'write',
      resource: {
        moduleId: 'payment.term-catalog',
        resourceId: legalEntityId,
        resourceType: 'payment.term-catalog.payment-term-catalog-root',
      },
    });
    expect(getActionResourcePermissionTargetResolver(correctPaymentTermAction)?.(existingPayload, scope)).toEqual({
      permission: 'write',
      resource: first,
    });
    expect(
      getActionResourcePermissionTargetResolver(retirePaymentTermAction)?.(
        {
          affectedUseAssessment: {
            currentCustomerEntitlementCount: 0,
            evidenceReference: 'commerce-read:abc',
            observedAt: '2026-09-09T10:00:00.000Z',
            openPurchaseCount: 0,
          },
          affectedUseDisposition: { kind: 'REJECT_IF_IN_USE' },
          effectiveAt: '2026-10-01T00:00:00.000Z',
          expectedMetadataRevision: 1,
          paymentTermRef: first,
          reason: 'Retire term',
        },
        scope,
      ),
    ).toEqual({ permission: 'write', resource: first });
    expect(
      getActionResourcePermissionTargetResolver(reconcilePaymentTermReferenceAction)?.(
        {
          aliasPaymentTermRef: first,
          canonicalPaymentTermRef: second,
          expectedAliasMetadataRevision: 1,
          expectedCanonicalMetadataRevision: 1,
          reason: 'Equivalent definitions',
        },
        scope,
      ),
    ).toEqual({ permission: 'write', resource: first });
    expect(
      getReadResourcePermissionTargetResolver(currentPaymentTermsRead)?.(
        { at: '2026-09-09T10:00:00.000Z', limit: 20, references: [] },
        scope,
      ),
    ).toEqual({
      permission: 'read',
      resource: {
        moduleId: 'payment.term-catalog',
        resourceId: legalEntityId,
        resourceType: 'payment.term-catalog.payment-term-catalog-root',
      },
    });
    expect(getReadResourcePermissionTargetResolver(paymentTermHistoryRead)?.({ paymentTermRef: first }, scope)).toEqual(
      { permission: 'read', resource: first },
    );
  });

  it.effect('denies unavailable or refused exact catalog authority before owner execution', () =>
    Effect.gen(function* exactCatalogAuthority() {
      const payload = {
        activeFrom: '2026-01-01T00:00:00.000Z',
        code: 'NET_30',
        description: 'Due in thirty days.',
        name: 'Net 30',
        reason: 'Approved catalog definition',
        semantics: {
          calculationRuleVersion: 1,
          calendarRule: 'CALENDAR_DAYS_UTC',
          days: 30,
          dueDateAnchor: 'INVOICE_ISSUED_AT',
          kind: 'NET_DAYS',
        },
      } as const;
      const principal = {
        authBindingId: '55555555-5555-4555-8555-555555555555',
        authContextRef: 'better-auth-session:payment-term-catalog-permission',
        authMethod: 'session' as const,
        legalEntityId,
        principalId: '66666666-6666-4666-8666-666666666666',
        tenantId,
      };
      const request = {
        payload,
        principal,
        registration: createPaymentTermAction,
        transport: {
          correlationId: 'payment-term-catalog-permission',
          idempotencyKey: 'create-net-30',
        },
      } as const;

      for (const resourcePermission of ['denied', 'unavailable'] as const) {
        const harness = yield* makeActionTestHarness({
          actionPermission: 'allowed',
          resourcePermission,
        });
        const failure = yield* harness.runtime.runAction(request).pipe(Effect.flip);
        expect(
          resourcePermission === 'denied'
            ? Predicate.isTagged(failure, 'ActionPermissionDenied')
            : Predicate.isTagged(failure, 'ActionPermissionCheckError'),
        ).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().stages.includes('handler_executed')).toBe(false);
      }
    }),
  );
});
