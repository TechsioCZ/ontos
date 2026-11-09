import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate, Result } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  checkModuleEntrypoint,
  makeModuleStateSnapshot,
} from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { recordPaymentReconciliationDecisionAction } from '../../src/actions/record-payment-reconciliation-decision.action.ts';
import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
import { paymentHistoryRead } from '../../src/api/payment-history.read.ts';
import { paymentReconciliationDebtRead } from '../../src/api/payment-reconciliation-debt.read.ts';
import { paymentRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principal = {
  authBindingId: '33333333-3333-4333-8333-333333333333',
  authContextRef: 'better-auth-session:payment-evidence-gate',
  authMethod: 'session' as const,
  legalEntityId,
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
};

const entrypoints = [
  acceptPaymentObservationAction.descriptor.entrypoint,
  requestPaymentOperationRecoveryAction.descriptor.entrypoint,
  recordPaymentReconciliationDecisionAction.descriptor.entrypoint,
  paymentReconciliationDebtRead.descriptor.entrypoint,
  paymentHistoryRead.descriptor.entrypoint,
];

const gateOutcome = (state: 'active' | 'suspended' | 'quarantined', entrypoint: (typeof entrypoints)[number]) =>
  checkModuleEntrypoint(
    makeModuleStateSnapshot(tenantId, entrypoints, [{ moduleKey: 'payment.core', state }]),
    entrypoint,
  ).pipe(
    Effect.result,
    Effect.map((result) => (Result.isSuccess(result) ? 'allow' : 'deny')),
  );

describe('#1151 TECH-02 evidence entrypoints under the Core module-state gate', () => {
  it('#1151 declares callback, recovery and reconciliation as write, debt as read and history as historical_read', () => {
    expect(entrypoints.map((entrypoint) => [entrypoint.entrypointKey, entrypoint.access])).toEqual([
      ['payment.core.accept-payment-observation', 'write'],
      ['payment.core.request-payment-operation-recovery', 'write'],
      ['payment.core.record-payment-reconciliation-decision', 'write'],
      ['payment.core.api.payment-reconciliation-debt', 'read'],
      ['payment.core.api.payment-history', 'historical_read'],
    ]);
  });

  it.effect(
    '#1151 Suspended Payment permits no callback mutation while the declared history follows its own gate',
    () =>
      Effect.gen(function* suspendedGate() {
        const suspended = yield* Effect.all(entrypoints.map((entrypoint) => gateOutcome('suspended', entrypoint)));
        expect(suspended).toEqual(['deny', 'deny', 'deny', 'deny', 'allow']);
        const active = yield* Effect.all(entrypoints.map((entrypoint) => gateOutcome('active', entrypoint)));
        expect(active).toEqual(['allow', 'allow', 'allow', 'allow', 'allow']);
        // historical_read is never a fallback: quarantine denies even history.
        const quarantined = yield* Effect.all(entrypoints.map((entrypoint) => gateOutcome('quarantined', entrypoint)));
        expect(quarantined).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
      }),
  );

  it.effect(
    '#1151 a suspended recovery request is denied by the real Action runtime before any business mutation',
    () =>
      Effect.gen(function* suspendedRecovery() {
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          actionPermission: 'allowed',
          moduleState: 'suspended',
          ownerRegistration: paymentRegistration,
        });
        const failure = yield* harness.runtime
          .runAction({
            payload: {
              operationId: '44444444-4444-4444-8444-444444444444',
              paymentId: '55555555-5555-4555-8555-555555555555',
              reason: 'Recover the lost collection response',
              trigger: 'EXECUTION_OUTCOME_UNKNOWN',
            },
            principal,
            registration: requestPaymentOperationRecoveryAction,
            transport: { correlationId: 'payment-evidence-suspended', idempotencyKey: 'recovery-suspended-1' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(failure, 'ModuleStateDeniedError')).toBe(true);
        expect(harness.snapshot().stages.includes('handler_executed')).toBe(false);
        expect(harness.snapshot().committed).toHaveLength(0);
      }),
  );
});
