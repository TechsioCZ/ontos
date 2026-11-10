import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect, Predicate, Result } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { paymentTestRelations } from './database-fixture.ts';
import {
  acceptObservation,
  itemsRefund,
  refundCaseFor,
  refundItem,
  requestRefund,
} from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import { refundRuntimeContextAccess, refundRuntimePermission } from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRuntime = Effect.gen(function* acquireRefundEvidenceRuntime() {
  const { admin, runtime } = yield* testDatabaseClients;
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, paymentTestRelations);
  const actionRuntime = makeActionRuntime(
    { executor: database },
    makeActionRepository(yield* Crypto.Crypto),
    refundRuntimePermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      contextAccess: refundRuntimeContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actionRuntime, admin, coreAdmin, database } satisfies RefundNativeRuntime;
});

const GATEWAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const CZK = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

/** The outcome of a request: `committed`, or the typed refusal code. */
const outcomeOf = <A, E extends { readonly code?: unknown }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.result(effect).pipe(
    Effect.map((result) => {
      if (Result.isSuccess(result)) {
        return 'committed';
      }
      return Predicate.hasProperty(result.failure, 'code') ? String(result.failure.code) : 'unknown';
    }),
  );

const A = refundItem('A', 10_000);
const P90_1 = refundItem('P90_1', 90_001);
const owners = { items: [A, P90_1] };

/** A GoPay REFUND_NOT_EFFECTED statement of `amountMinor` correlated to `operationId`. */
const notEffectedStatement = (refundCase: RefundCase, operationId: string, amountMinor: number, occurrence: string) =>
  acceptObservation(refundCase, {
    amount: CZK(amountMinor),
    economicEffectKey: 'gopay:refund:x',
    factFamily: 'REFUND_EXECUTION',
    factKind: 'REFUND_NOT_EFFECTED',
    operationId,
    paymentId: refundCase.payment.paymentId,
    source: GATEWAY_SOURCE,
    sourceOccurrenceId: occurrence,
    sourceRevision: 0,
  });

// #1150/#1151: a REFUND_NOT_EFFECTED that states 4 000 CZK for a PENDING 10 000 CZK refund is not a definitive
// non-execution of that refund. Its 10 000 CZK funds reservation must stay, so 90 001 CZK stays refused.
it.live('#1150 a REFUND_NOT_EFFECTED with a different amount does not release the 10 000 CZK reservation (funds)', () =>
  native(
    Effect.gen(function* notEffectedWrongAmountFunds() {
      const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
      const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
      yield* notEffectedStatement(refundCase, first.operation.operationId, 4000, 'gopay-nef-4000');
      expect(
        yield* outcomeOf(requestRefund(refundCase, itemsRefund(refundCase, 'over-after-nef', [P90_1]), owners)),
      ).not.toBe('committed');
    }),
  ),
);

// #1151 "one economic effect": the same wrong-amount NOT_EFFECTED must not free item A, which the PENDING refund still reserves.
it.live(
  '#1150 a REFUND_NOT_EFFECTED with a different amount does not release item A of the 10 000 CZK refund (items)',
  () =>
    native(
      Effect.gen(function* notEffectedWrongAmountItems() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const first = yield* requestRefund(refundCase, itemsRefund(refundCase, 'refund-a', [A]), owners);
        yield* notEffectedStatement(refundCase, first.operation.operationId, 4000, 'gopay-nef-4000-items');
        expect(yield* outcomeOf(requestRefund(refundCase, itemsRefund(refundCase, 'a-again', [A]), owners))).not.toBe(
          'committed',
        );
      }),
    ),
);
