import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { IssuePaymentAuthorizationPayloadSchema } from '../../shared/actions/issue-payment-authorization.ts';
import type { IssuePaymentAuthorizationPayload } from '../../shared/actions/issue-payment-authorization.ts';
import { PaymentAuthorizationValidationRequestSchema } from '../../shared/apis/payment-authorization-validation.ts';
import type { PaymentAuthorizationValidationRequest } from '../../shared/apis/payment-authorization-validation.ts';
import type { PaymentAuthorizationBinding } from '../../shared/domain/authorization-proof.ts';
import { issuePaymentAuthorizationAction } from '../../src/actions/issue-payment-authorization.action.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import {
  paymentAuthorizationValidationRead,
  validatePaymentAuthorization,
} from '../../src/api/payment-authorization-validation.read.ts';
import { paymentAggregatePersistenceForTransaction } from '../../src/persistence/payment-aggregate-persistence.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentAuthorizationPersistenceForTransaction } from '../../src/persistence/payment-authorization-persistence.ts';
import { paymentRefundPersistenceForTransaction } from '../../src/persistence/payment-refund-persistence.ts';
import type { PaymentRefundPersistence } from '../../src/persistence/payment-refund-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeAuthorizationOwnerEvidenceFixture } from '../support/authorization-owner-evidence.fixture.ts';
import { refundCaseFor } from '../support/refund-action-driver.ts';
import type { RefundCase } from '../support/refund-action-driver.ts';
import {
  loadPaymentAggregate,
  refundRuntimeContextAccess,
  refundRuntimePermission,
  withScopedTransaction,
} from '../support/refund-native-runtime.ts';
import type { RefundNativeRuntime } from '../support/refund-native-runtime.ts';
import { paymentTestRelations } from './database-fixture.ts';

// One funds snapshot for every reader (#1150, #1149): Current coverage, prepaid proof issuance and prepaid proof
// validation all build the snapshot through the refund persistence builder (selectFunds), so they read the same
// collection and the same prior returns.

const native = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeRuntime = Effect.gen(function* acquireFundsSnapshotRuntime() {
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

/** The registered Read runtime over the worktree database, as the Current inspection and validation run. */
const readsOf = (refundCase: RefundCase) =>
  makeReadRuntime(
    { executor: refundCase.native.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    refundRuntimeContextAccess,
    {
      accessDecision: makeScriptedBoundAccessGate('allowed').bound,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );

const currentCoverageOf = (refundCase: RefundCase) =>
  readsOf(refundCase)
    .runRead({
      input: { paymentId: refundCase.payment.paymentId },
      principal: refundCase.principal,
      registration: currentPaymentRead,
      transport: { correlationId: 'funds-snapshot-current' },
    })
    .pipe(Effect.map((current) => current.coverage));

/** The binding of one new prepaid Attempt of the seeded Payment (its immutable purchase meaning). */
const prepaidBindingOf = Effect.fn('FundsSnapshotTest.prepaidBindingOf')(function* prepaidBindingOf(
  refundCase: RefundCase,
  attemptId: string,
) {
  const { payment } = yield* loadPaymentAggregate(
    refundCase.native.database,
    refundCase.scope,
    refundCase.payment.paymentId,
  );
  return {
    amount: payment.amount,
    executionBinding: payment.executionBinding,
    method: payment.method,
    orderCommitmentAttemptId: attemptId,
    orderCommitmentTime: DateTime.makeUnsafe('2026-11-10T08:00:00.000Z'),
    paymentId: payment.paymentId,
    paymentTermRef: payment.paymentTermRef,
    purchaseCorrelationId: payment.purchaseCorrelationId,
  } satisfies PaymentAuthorizationBinding;
});

/** Issues a prepaid proof through the registered issuance Action. */
const issuePrepaidProof = Effect.fn('FundsSnapshotTest.issuePrepaidProof')(function* issuePrepaidProof(
  refundCase: RefundCase,
  binding: PaymentAuthorizationBinding,
  validitySeconds = 300,
) {
  const owner = yield* makeAuthorizationOwnerEvidenceFixture;
  const request: IssuePaymentAuthorizationPayload = { binding, issuanceKey: randomUUID(), validitySeconds };
  const encoded = yield* Schema.encodeEffect(IssuePaymentAuthorizationPayloadSchema)(request);
  return yield* refundCase.native.actionRuntime
    .runAction({
      payload: encoded,
      principal: refundCase.principal,
      registration: issuePaymentAuthorizationAction,
      transport: { correlationId: 'funds-snapshot-issue', idempotencyKey: randomUUID() },
    })
    .pipe(Effect.provide(owner.layer));
});

/** Validates an issued proof at actual use through the registered validation Read. */
const validateProof = Effect.fn('FundsSnapshotTest.validateProof')(function* validateProof(
  refundCase: RefundCase,
  input: PaymentAuthorizationValidationRequest,
) {
  const owner = yield* makeAuthorizationOwnerEvidenceFixture;
  const encoded = yield* Schema.encodeEffect(PaymentAuthorizationValidationRequestSchema)(input);
  return yield* readsOf(refundCase)
    .runRead({
      input: encoded,
      principal: refundCase.principal,
      registration: paymentAuthorizationValidationRead,
      transport: { correlationId: 'funds-snapshot-validate' },
    })
    .pipe(Effect.provide(owner.layer));
});

it.live(
  '#1150 a collected Payment without return evidence reads Established, issues and validates its prepaid proof',
  () =>
    native(
      Effect.gen(function* collectedWithoutReturn() {
        const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
        const coverage = yield* currentCoverageOf(refundCase);
        expect(coverage).toMatchObject({ remaining: { amountMinor: 100_000 } });
        const binding = yield* prepaidBindingOf(refundCase, 'attempt-no-return');
        const issued = yield* issuePrepaidProof(refundCase, binding);
        expect(issued.issuance).toBe('ISSUED');
        const validation = yield* validateProof(refundCase, {
          authorizationId: issued.proof.authorizationId,
          binding,
        });
        expect(validation.outcome).toBe('VALID');
      }),
    ),
);

/** The real refund persistence, whose funds lookup returns when the clock has reached `answeredAt`. */
const refundsAnsweringAt = (refunds: PaymentRefundPersistence, answeredAt: DateTime.Utc): PaymentRefundPersistence => ({
  ...refunds,
  selectFunds: (aggregate) =>
    refunds.selectFunds(aggregate).pipe(Effect.tap(() => TestClock.setTime(DateTime.toEpochMillis(answeredAt)))),
});

it.live('#1149 a prepaid proof that expires while the funds are read is not acknowledged as VALID', () =>
  native(
    Effect.gen(function* prepaidExpiresDuringFundsLookup() {
      const refundCase = yield* refundCaseFor(yield* nativeRuntime, { amountMinor: 100_000, collected: true });
      const binding = yield* prepaidBindingOf(refundCase, 'attempt-slow-funds');
      const issued = yield* issuePrepaidProof(refundCase, binding);
      const { authorizationId, expiresAt, issuedAt } = issued.proof;
      const owner = yield* makeAuthorizationOwnerEvidenceFixture;
      // The handler with its real owner persistence. The test clock starts inside the validity window
      // and passes the expiry while the funds are read.
      const validation = yield* Effect.gen(function* validateWhileFundsAreRead() {
        yield* TestClock.setTime(DateTime.toEpochMillis(issuedAt) + 1000);
        return yield* withScopedTransaction(refundCase.native.database, refundCase.scope, (transaction) => {
          const refunds = paymentRefundPersistenceForTransaction(transaction);
          return validatePaymentAuthorization({ authorizationId, binding }, refundCase.scope, {
            aggregate: paymentAggregatePersistenceForTransaction(transaction),
            applicability: paymentApplicabilityPersistenceForTransaction(transaction),
            authorizations: paymentAuthorizationPersistenceForTransaction(transaction),
            refunds: refundsAnsweringAt(refunds, expiresAt),
          }).pipe(Effect.provide(owner.layer));
        });
      }).pipe(Effect.provide(TestClock.layer()));
      expect(validation).toMatchObject({ outcome: 'NOT_VALID', reasons: ['EXPIRED'] });
      expect(DateTime.isGreaterThanOrEqualTo(validation.validatedAt, expiresAt)).toBe(true);
    }),
  ),
);
