import { describe, expect, it } from 'effect-rstest';
import { DateTime } from 'effect';

import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentOperationOutcome, PaymentRecoveryMode } from '../../shared/domain/payment-vocabulary.ts';
import { assessProviderReplay, planPaymentRecovery, PaymentRecoveryPlan } from '../../src/domain/evidence-recovery.ts';
import type { PaymentRecoveryOperationView, PaymentRecoveryRequestInput } from '../../src/domain/evidence-recovery.ts';
import type { PaymentRecoveryTrigger } from '../../shared/domain/evidence-contract.ts';

const createdAt = DateTime.makeUnsafe('2026-11-09T10:00:00.000Z');
const minutesAfter = (minutes: number) => DateTime.add(createdAt, { minutes });
const gateway: PaymentExecutionBinding = {
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: 'stripe-account-1',
  providerFamily: 'STRIPE',
};
const guarantee = (windowSeconds: number, providerAccountRef = 'stripe-account-1') => ({
  providerIdempotency: {
    environment: 'production',
    providerAccountRef,
    providerFamily: 'STRIPE',
    providerIdempotencyKey: 'payment-op-key-1',
    windowSeconds,
  },
});

const operation = (
  outcome: PaymentOperationOutcome,
  materialExtras: Readonly<Record<string, ReturnType<typeof guarantee>['providerIdempotency']>> = {},
  binding: PaymentExecutionBinding = gateway,
): PaymentRecoveryOperationView => ({
  binding,
  createdAt,
  materialRequest: { amountMinor: 100_000, currency: 'CZK', kind: 'COLLECT', ...materialExtras },
  outcome,
});

const at = (
  now: DateTime.Utc,
  trigger: PaymentRecoveryTrigger,
  requestedMode?: PaymentRecoveryMode,
): PaymentRecoveryRequestInput => ({ now, requestedMode, trigger });

describe('#1151 same-operation recovery planning', () => {
  it('#1151 Financial replay uses new transport admission: a covering provider window permits exact replay', () => {
    const plan = planPaymentRecovery(
      operation('INDETERMINATE', guarantee(3600)),
      at(minutesAfter(30), 'EXECUTION_OUTCOME_UNKNOWN'),
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
      operation('INDETERMINATE', guarantee(3600)),
      at(minutesAfter(61), 'OPERATOR_REQUEST', 'PROVIDER_IDEMPOTENT_REPLAY'),
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
    expect(assessProviderReplay(operation('PENDING', guarantee(3600)), minutesAfter(60))).toBe('EXPIRED');
    expect(
      assessProviderReplay(operation('PENDING', guarantee(3600)), DateTime.add(createdAt, { seconds: 3599 })),
    ).toBe('COVERS_NOW');
  });

  it('#1151 a guarantee bound to another account never proves replay of the original binding', () => {
    expect(assessProviderReplay(operation('PENDING', guarantee(3600, 'stripe-account-2')), minutesAfter(1))).toBe(
      'NOT_PROVEN',
    );
    expect(assessProviderReplay(operation('PENDING'), minutesAfter(1))).toBe('NOT_PROVEN');
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
      operation('PENDING', {}, { _tag: 'BANK_ACCOUNTING_RECEIPT' }),
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
      operation('INDETERMINATE', guarantee(3600)),
      at(minutesAfter(1), 'LOOKUP_AUTHORITY_UNAVAILABLE'),
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
      operation('PENDING', guarantee(3600)),
      at(minutesAfter(1), 'OPERATOR_REQUEST', 'AWAIT_QUALIFIED_EVIDENCE'),
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
});
