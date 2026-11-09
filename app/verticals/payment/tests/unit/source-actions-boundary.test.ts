import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import { RecordPaymentLocalEvidencePayloadSchema } from '../../shared/actions/record-payment-local-evidence.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

/**
 * The source Actions through the real registered descriptors and the Core Action runtime (#1152
 * "Public admission and runtime lifetime", #1153 gates). Denied requests never reach the handler or
 * open the owner transaction, so no canonical acceptance or "paid" acknowledgement can be fabricated.
 */

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const principal = {
  authBindingId: '55555555-5555-4555-8555-555555555555',
  authContextRef: 'better-auth-session:payment-source-boundary',
  authMethod: 'session' as const,
  legalEntityId,
  principalId: '66666666-6666-4666-8666-666666666666',
  tenantId,
};
const paymentId = '77777777-7777-4777-8777-777777777777';

const posStatement = {
  amount: { amountMinor: 100_000, currency: 'CZK' },
  evidenceRef: 'pos-receipt-881',
  factFamily: 'LOCAL_POS_COLLECTION',
  factKind: 'COLLECTION_CONFIRMED',
  paymentId,
  pickupCapabilityRef: 'pickup-prague-1',
  reason: 'Customer paid at the pickup counter',
  source: {
    accountRef: 'pos-drawer-1',
    environment: 'production',
    sourceKind: 'LOCAL_POS_OPERATOR',
    sourceSystem: 'store-pos',
  },
  sourceOccurrenceId: 'pos-receipt-881',
  sourceRevision: 1,
} as const;

const bankStatement = {
  amount: { amountMinor: 100_000, currency: 'CZK' },
  factFamily: 'BANK_ACCOUNTING_RECEIPT',
  factKind: 'COLLECTION_CONFIRMED',
  paymentId,
  source: {
    accountRef: 'CZ6508000000192000145399',
    environment: 'production',
    sourceKind: 'BANK_ACCOUNTING',
    sourceSystem: 'erp-helios',
  },
  sourceOccurredAt: '2026-11-08T09:15:00.000Z',
  sourceOccurrenceId: 'bank-line-2026-11-08-17',
  sourceRevision: 1,
} as const;

const transport = (idempotencyKey: string) => ({ correlationId: 'payment-source-boundary', idempotencyKey });

describe('#1152 source Actions at the Core boundary', () => {
  it.effect('#1152 Unauthorized manual mark paid: an operator without the local-evidence permission is denied', () =>
    Effect.gen(function* deniedOperator() {
      for (const access of ['denied', 'unavailable'] as const) {
        const harness = yield* makeActionTestHarness({ access, ownerRegistration: paymentRegistration });
        const failure = yield* harness.runtime
          .runAction({
            payload: posStatement,
            principal,
            registration: recordPaymentLocalEvidenceAction,
            transport: transport(`pos-${access}`),
          })
          .pipe(Effect.flip);
        expect(
          access === 'denied'
            ? Predicate.isTagged(failure, 'ActionPermissionDenied')
            : Predicate.isTagged(failure, 'ActionPermissionCheckError'),
        ).toBe(true);
        expect(harness.snapshot().transactionCount).toBe(0);
        expect(harness.snapshot().stages.includes('handler_executed')).toBe(false);
      }
    }),
  );

  it.effect(
    '#1152 Old fact does not grant write access: a non-active Payment module denies observation acceptance',
    () =>
      Effect.gen(function* gatedObservation() {
        for (const moduleState of ['suspended', 'inactive'] as const) {
          const harness = yield* makeActionTestHarness({
            access: 'allowed',
            moduleState,
            ownerRegistration: paymentRegistration,
          });
          const failure = yield* harness.runtime
            .runAction({
              payload: bankStatement,
              principal,
              registration: acceptPaymentObservationAction,
              transport: transport(`late-bank-${moduleState}`),
            })
            .pipe(Effect.flip);
          expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
          expect(harness.snapshot().committed).toEqual([]);
          expect(harness.snapshot().stages.includes('handler_executed')).toBe(false);
        }
      }),
  );

  it('#1152 #1153 every source entrypoint is a canonical write Action, never historical_read', () => {
    for (const action of [
      configurePaymentSourceAuthorityAction,
      acceptPaymentObservationAction,
      recordPaymentLocalEvidenceAction,
    ]) {
      expect(action.descriptor.entrypoint.access).toBe('write');
      expect(action.descriptor.idempotency).toBe('required');
      expect(action.descriptor.legalEntityScope).toBe('required');
    }
    // Operator evidence has its own critical permission, distinct from integration ingress.
    expect(recordPaymentLocalEvidenceAction.descriptor.accessDeclaration?.key).toBe(
      'payment.core.local-evidence.record',
    );
    expect(recordPaymentLocalEvidenceAction.descriptor.accessDeclaration?.risk).toBe('critical');
    expect(acceptPaymentObservationAction.descriptor.accessDeclaration?.key).toBe('payment.core.observation.accept');
  });

  it('#1152 untrusted refund destination: the public contracts carry no destination, trusted scope or provider payload', () => {
    const decodedLocal = Schema.decodeUnknownSync(RecordPaymentLocalEvidencePayloadSchema)({
      ...posStatement,
      destination: { iban: 'CZ0000000000000000000666' },
      legalEntityId: '99999999-9999-4999-8999-999999999999',
      tenantId: '99999999-9999-4999-8999-999999999999',
    });
    expect(Object.keys(decodedLocal)).not.toContain('destination');
    expect(Object.keys(decodedLocal)).not.toContain('tenantId');
    expect(Object.keys(decodedLocal)).not.toContain('legalEntityId');
    const decodedIngress = Schema.decodeUnknownSync(AcceptPaymentObservationPayloadSchema)({
      ...bankStatement,
      rawPayload: { secret: 'provider-signature' },
      variableSymbol: '20261108',
    });
    expect(Object.keys(decodedIngress)).not.toContain('rawPayload');
    expect(Object.keys(decodedIngress)).not.toContain('variableSymbol');
  });

  it('#1152 manual/local evidence requires an auditable reason and an evidence reference', () => {
    const decode = Schema.decodeUnknownResult(RecordPaymentLocalEvidencePayloadSchema);
    const { evidenceRef: _evidenceRef, ...withoutEvidence } = posStatement;
    const { reason: _reason, ...withoutReason } = posStatement;
    expect(decode(withoutEvidence)._tag).toBe('Failure');
    expect(decode(withoutReason)._tag).toBe('Failure');
    expect(decode(posStatement)._tag).toBe('Success');
  });
});
