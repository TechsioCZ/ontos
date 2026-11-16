import { describe, expect, it } from 'effect-rstest';
import { DateTime, Schema } from 'effect';

import { PaymentProviderReplayGuaranteeSchema } from '../../shared/domain/evidence-contract.ts';
import type { PaymentProviderReplayGuarantee, PaymentRecoveryTrigger } from '../../shared/domain/evidence-contract.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentOperationOutcome, PaymentRecoveryMode } from '../../shared/domain/payment-vocabulary.ts';
import type { OutboxPayload as RecoveryRequested } from '../../shared/outbox/payment-core-operation-recovery-requested-v1.ts';
import {
  assessProviderReplay,
  paymentRecoveryModeAtDispatch,
  planPaymentRecovery,
  PaymentRecoveryPlan,
} from '../../src/domain/evidence-recovery.ts';
import type { PaymentRecoveryOperationView, PaymentRecoveryRequestInput } from '../../src/domain/evidence-recovery.ts';

const createdAt = DateTime.makeUnsafe('2026-11-09T10:00:00.000Z');
const minutesAfter = (minutes: number) => DateTime.add(createdAt, { minutes });
const gateway: PaymentExecutionBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'stripe-account-1',
  providerFamily: 'STRIPE',
};
const scope = {
  legalEntityId: '731198fd-f545-4770-a902-0203b7fe1884',
  tenantId: '157ca87e-c377-4620-82fb-b52675dc0b62',
};
const paymentId = 'b2de7f17-0e80-4b01-bd18-2bbf6e0549b7';
const operationId = '0c173f77-7360-47f6-ae7a-1305b5b22107';
const materialHash = 'a'.repeat(64);
const guarantee = (overrides: Partial<PaymentProviderReplayGuarantee> = {}) =>
  Schema.decodeUnknownSync(PaymentProviderReplayGuaranteeSchema)({
    ...scope,
    binding: gateway,
    endpointRef: 'stripe.payment-intents.create',
    expiresAtEpochMs: DateTime.toEpochMillis(minutesAfter(60)),
    materialHash,
    operationId,
    operationKind: 'COLLECT',
    paymentId,
    providerIdempotencyKeyHash: 'b'.repeat(64),
    providerRequestHash: 'c'.repeat(64),
    startsAtEpochMs: DateTime.toEpochMillis(createdAt),
    ...overrides,
  });

const operation = (
  outcome: PaymentOperationOutcome,
  binding: PaymentExecutionBinding = gateway,
): PaymentRecoveryOperationView => ({
  binding,
  createdAt,
  kind: 'COLLECT',
  materialHash,
  operationId,
  outcome,
  paymentId,
});

const at = (
  now: DateTime.Utc,
  trigger: PaymentRecoveryTrigger,
  requestedMode?: PaymentRecoveryMode,
  proof?: PaymentProviderReplayGuarantee,
): PaymentRecoveryRequestInput => ({ guarantee: proof, now, requestedMode, scope, trigger });

const assessmentAt = (now: DateTime.Utc, proof?: PaymentProviderReplayGuarantee) =>
  assessProviderReplay(operation('PENDING'), { guarantee: proof, now, scope });

describe('#1151 same-operation recovery planning', () => {
  it('#1151 Financial replay uses new transport admission: a covering provider window permits exact replay', () => {
    const plan = planPaymentRecovery(
      operation('INDETERMINATE'),
      at(minutesAfter(30), 'EXECUTION_OUTCOME_UNKNOWN', undefined, guarantee()),
    );
    expect(plan).toEqual(
      PaymentRecoveryPlan.Plan({
        executorWork: true,
        hold: false,
        markIndeterminate: false,
        mode: 'PROVIDER_IDEMPOTENT_REPLAY',
        modeDowngraded: false,
        providerReplay: 'COVERS_NOW',
      }),
    );
  });

  it('#1151 Provider idempotency window has expired: no replay on the local identity alone', () => {
    const plan = planPaymentRecovery(
      operation('INDETERMINATE'),
      at(minutesAfter(61), 'OPERATOR_REQUEST', 'PROVIDER_IDEMPOTENT_REPLAY', guarantee()),
    );
    expect(plan).toEqual(
      PaymentRecoveryPlan.Plan({
        executorWork: true,
        hold: false,
        markIndeterminate: false,
        mode: 'AUTHORITATIVE_LOOKUP',
        modeDowngraded: true,
        providerReplay: 'EXPIRED',
      }),
    );
  });

  it('#1151 the window boundary itself is already expired (actual now, not frozen time)', () => {
    expect(assessmentAt(minutesAfter(60), guarantee())).toBe('EXPIRED');
    expect(assessmentAt(DateTime.add(createdAt, { seconds: 3599 }), guarantee())).toBe('COVERS_NOW');
    expect(assessmentAt(minutesAfter(-1), guarantee())).toBe('NOT_PROVEN');
  });

  it('#1151 a guarantee bound to another account never proves replay of the original binding', () => {
    const foreign = guarantee({ binding: { ...gateway, providerAccountRef: 'stripe-account-2' } });
    expect(assessmentAt(minutesAfter(1), foreign)).toBe('NOT_PROVEN');
    expect(assessmentAt(minutesAfter(1), guarantee({ materialHash: 'd'.repeat(64) }))).toBe('NOT_PROVEN');
    expect(assessmentAt(minutesAfter(1))).toBe('NOT_PROVEN');
  });

  it('#1151 Lost create response does not authorize another charge: transport loss marks PENDING INDETERMINATE', () => {
    const plan = planPaymentRecovery(operation('PENDING'), at(minutesAfter(5), 'EXECUTION_OUTCOME_UNKNOWN'));
    expect(plan).toEqual(
      PaymentRecoveryPlan.Plan({
        executorWork: true,
        hold: false,
        markIndeterminate: true,
        mode: 'AUTHORITATIVE_LOOKUP',
        modeDowngraded: false,
        providerReplay: 'NOT_PROVEN',
      }),
    );
  });

  it('#1151 Business waiting does not fabricate a perpetual execution lease: bank receipt waits for evidence', () => {
    const plan = planPaymentRecovery(
      operation('PENDING', { _tag: 'BANK_ACCOUNTING_RECEIPT' }),
      at(minutesAfter(5), 'OUTCOME_OVERDUE'),
    );
    expect(plan).toEqual(
      PaymentRecoveryPlan.Plan({
        executorWork: false,
        hold: false,
        markIndeterminate: false,
        mode: 'AWAIT_QUALIFIED_EVIDENCE',
        modeDowngraded: false,
        providerReplay: 'NOT_APPLICABLE',
      }),
    );
  });

  it('#1151 missing lookup credentials or authority hold the operation for reconciliation, never NOT_EFFECTED', () => {
    const plan = planPaymentRecovery(
      operation('INDETERMINATE'),
      at(minutesAfter(1), 'LOOKUP_AUTHORITY_UNAVAILABLE', undefined, guarantee()),
    );
    expect(plan).toEqual(
      PaymentRecoveryPlan.Plan({
        executorWork: false,
        hold: true,
        markIndeterminate: false,
        mode: 'GOVERNED_RECONCILIATION',
        modeDowngraded: false,
        providerReplay: 'COVERS_NOW',
      }),
    );
  });

  it('#1151 a conflicting operation is recovered only by governed reconciliation', () => {
    const plan = planPaymentRecovery(
      operation('CONFLICT'),
      at(minutesAfter(1), 'OPERATOR_REQUEST', 'AUTHORITATIVE_LOOKUP'),
    );
    expect(PaymentRecoveryPlan.$is('Plan')(plan) && plan.mode).toBe('GOVERNED_RECONCILIATION');
  });

  it('#1151 a caller may ask for a weaker mode but never a stronger one', () => {
    const weaker = planPaymentRecovery(
      operation('PENDING'),
      at(minutesAfter(1), 'OPERATOR_REQUEST', 'AWAIT_QUALIFIED_EVIDENCE', guarantee()),
    );
    expect(weaker).toMatchObject({ executorWork: false, mode: 'AWAIT_QUALIFIED_EVIDENCE', modeDowngraded: false });
  });

  it('#1151 a definitive operation has nothing to recover', () => {
    for (const outcome of ['EFFECT_CONFIRMED', 'NOT_EFFECTED_CONFIRMED'] as const) {
      expect(planPaymentRecovery(operation(outcome), at(minutesAfter(1), 'OPERATOR_REQUEST'))).toEqual(
        PaymentRecoveryPlan.AlreadyResolved({ outcome }),
      );
    }
  });

  it('#1158 actual dispatch rechecks the retained endpoint, provider request, key and original window', () => {
    const proof = guarantee();
    const message: RecoveryRequested = {
      amount: { amountMinor: 100_000, currency: 'CZK' },
      binding: gateway,
      materialHash,
      mode: 'PROVIDER_IDEMPOTENT_REPLAY',
      operationId,
      operationKey: 'collect-a',
      operationKind: 'COLLECT',
      operationOutcome: 'INDETERMINATE',
      originalActionInvocationId: operationId,
      originalCompositionRevision: 'e'.repeat(64),
      paymentId,
      provenance: {
        actionInvocationId: operationId,
        actorPrincipalId: paymentId,
        compositionRevision: 'e'.repeat(64),
      },
      providerReplayGuarantee: proof,
      recoveryId: paymentId,
    };
    const current = { ...operation('INDETERMINATE'), provenance: message.provenance };
    const dispatch = (now: DateTime.Utc, retained?: PaymentProviderReplayGuarantee) =>
      paymentRecoveryModeAtDispatch(message, current, scope, now, retained);
    expect(dispatch(minutesAfter(59), proof)).toBe('PROVIDER_IDEMPOTENT_REPLAY');
    expect(dispatch(minutesAfter(60), proof)).toBe('AUTHORITATIVE_LOOKUP');
    expect(dispatch(minutesAfter(59))).toBe('AUTHORITATIVE_LOOKUP');
    expect(dispatch(minutesAfter(59), guarantee({ endpointRef: 'stripe.refunds.create' }))).toBe(
      'AUTHORITATIVE_LOOKUP',
    );
    expect(dispatch(minutesAfter(59), guarantee({ providerIdempotencyKeyHash: 'd'.repeat(64) }))).toBe(
      'AUTHORITATIVE_LOOKUP',
    );
    expect(
      paymentRecoveryModeAtDispatch(
        message,
        { ...current, outcome: 'EFFECT_CONFIRMED' },
        scope,
        minutesAfter(59),
        proof,
      ),
    ).toBe('ALREADY_RESOLVED');
  });
});
