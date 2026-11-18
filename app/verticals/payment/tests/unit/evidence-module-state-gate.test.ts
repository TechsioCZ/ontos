import { makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Predicate } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
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

describe('#1151 TECH-02 evidence entrypoints under the Core module-state gate', () => {
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
