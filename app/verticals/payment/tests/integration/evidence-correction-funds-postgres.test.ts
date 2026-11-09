import { randomUUID } from 'node:crypto';

import { NodeCrypto } from '@effect/platform-node';
import { Crypto, Effect } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { computePaymentFunds, PaymentFundsLedger } from '../../src/domain/coverage.ts';
import type { PaymentFundsLedgerCase } from '../../src/domain/coverage.ts';
import { paymentFundsSnapshotOf } from '../../src/persistence/payment-aggregate-persistence.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* h1NativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('CorrectionFunds.makeRuntimes')(function* makeRuntimes(
  database: EvidenceNativeDatabase,
  compositionRevision: string,
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const actions = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(compositionRevision),
    },
  );
  const reads = makeReadRuntime(
    { executor: database.database },
    openModuleEntrypointGateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

const scenario = Effect.fn('CorrectionFunds.scenario')(function* scenario() {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  return evidenceScenarioOf({ native: database, r1, r2, scope });
});

const czk = (amountMinor: number) => ({ amountMinor, currency: 'CZK' as const });

const GOPAY_SOURCE = {
  accountRef: 'gopay-account-1',
  environment: 'production',
  sourceKind: 'PAYMENT_GATEWAY',
  sourceSystem: 'GOPAY',
} as const;

const configureGopay = (evidence: EvidenceScenario) =>
  evidence.configureSource({
    factFamily: 'GATEWAY_OUTCOME',
    reason: 'GoPay callbacks are the gateway outcome authority',
    refundRoute: false,
    source: GOPAY_SOURCE,
    status: 'ACTIVE',
    submitterPrincipalIds: [evidence.scope.principalId],
  });

const gopayStatement = (fields: {
  readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
  readonly correctsObservationId?: string;
  readonly economicEffectKey?: string;
  readonly factKind: 'COLLECTION_CONFIRMED' | 'REFUND_CONFIRMED' | 'SOURCE_CORRECTION';
  readonly operationId?: string;
  readonly paymentId?: string;
}) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

/** A 1000 CZK GoPay COLLECT confirmed by one accepted callback through the registered Action. */
const confirmedCollect = Effect.fn('CorrectionFunds.confirmedCollect')(function* confirmedCollect(
  evidence: EvidenceScenario,
) {
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: `collect-${randomUUID()}`,
    paymentId: payment.paymentId,
  });
  yield* configureGopay(evidence);
  const first = yield* evidence.accept(
    gopayStatement({
      amount: czk(100_000),
      economicEffectKey: `gopay:charge:${randomUUID()}`,
      factKind: 'COLLECTION_CONFIRMED',
      operationId: collect.operationId,
      paymentId: payment.paymentId,
    }),
  );
  expect(first).toMatchObject({ acceptanceOutcome: 'ACCEPTED_OBSERVATION', interpretation: 'TRANSITION' });
  return { collect, first, payment };
});

/** Summary of the shared calculator for the persisted Payment; the Current read must state exactly this. */
const calculatorSummary = (ledger: PaymentFundsLedgerCase) =>
  PaymentFundsLedger.$match(ledger, {
    Established: ({ collected, confirmedReturned, remaining }) =>
      `Established collected=${collected.amountMinor} returned=${confirmedReturned.amountMinor} remaining=${remaining.amountMinor}`,
    Held: ({ reason }) => `Held ${reason}`,
    NotCollected: () => 'NotCollected',
  });

const calculatorOf = (evidence: EvidenceScenario, paymentId: string) =>
  evidence
    .evidenceAggregate(paymentId)
    .pipe(Effect.map((loaded) => calculatorSummary(computePaymentFunds(paymentFundsSnapshotOf(loaded.current)))));

/**
 * Invariant (#1151, money invariants 2 and 4): a Held Current coverage is held reconciliation debt, so it
 * must be visible as at least one OPEN case or unresolved operation that governed decisions can settle.
 */
it.live(
  '#1151 a correction that over-reduces a collect after a confirmed return reads Held with visible OPEN debt',
  () =>
    native(
      Effect.gen(function* s6OverReducedAfterReturn() {
        const evidence = yield* scenario();
        const { collect, first, payment } = yield* confirmedCollect(evidence);
        const routeSource = yield* evidence.configureRefundRoute('erp-primary', 'refund-account-a');
        const refund = yield* evidence.startOperation({
          amountMinor: 80_000,
          kind: 'REFUND',
          operationKey: 'refund-h1-s6',
          paymentId: payment.paymentId,
          refundBasis: {
            _tag: 'REFUNDABLE_ITEMS',
            items: [{ amountMinor: 80_000, currency: 'CZK', itemRef: 'line-s6', sourceEvidenceRef: 'order-line-s6' }],
          },
          refundExecutionRoute: yield* evidence.refundRouteOf(routeSource),
          targetOperationId: collect.operationId,
        });
        yield* evidence.settle(payment.paymentId, refund.operationId, 1, 'EFFECT_CONFIRMED');
        // 30k of the 100k collection is disproven while 80k was already returned: 70k < 80k is unexplainable.
        yield* evidence.accept(
          gopayStatement({
            amount: czk(30_000),
            correctsObservationId: first.observationId,
            economicEffectKey: `gopay:charge:partial-after-return:${randomUUID()}`,
            factKind: 'SOURCE_CORRECTION',
            operationId: collect.operationId,
            paymentId: payment.paymentId,
          }),
        );
        const coverage = yield* evidence.coverage(payment.paymentId);
        expect(coverage.startsWith('Held ')).toBe(true);
        expect(yield* calculatorOf(evidence, payment.paymentId)).toBe(coverage);
        const debt = yield* evidence.debt({ paymentId: payment.paymentId });
        expect(debt.openCases.length + debt.unresolvedOperations.length).toBeGreaterThan(0);
      }),
    ),
);

it.live('#1151 a partial correction below a PENDING refund reservation reads Held with visible OPEN debt', () =>
  native(
    Effect.gen(function* s12PendingReservationOverReduced() {
      const evidence = yield* scenario();
      const { collect, first, payment } = yield* confirmedCollect(evidence);
      const routeSource = yield* evidence.configureRefundRoute('erp-primary', 'refund-account-a');
      yield* evidence.startOperation({
        amountMinor: 80_000,
        kind: 'REFUND',
        operationKey: 'refund-h1-s12',
        paymentId: payment.paymentId,
        refundBasis: {
          _tag: 'REFUNDABLE_ITEMS',
          items: [{ amountMinor: 80_000, currency: 'CZK', itemRef: 'line-s12', sourceEvidenceRef: 'order-line-s12' }],
        },
        refundExecutionRoute: yield* evidence.refundRouteOf(routeSource),
        targetOperationId: collect.operationId,
      });
      yield* evidence.accept(
        gopayStatement({
          amount: czk(30_000),
          correctsObservationId: first.observationId,
          economicEffectKey: `gopay:charge:partial-s12:${randomUUID()}`,
          factKind: 'SOURCE_CORRECTION',
          operationId: collect.operationId,
          paymentId: payment.paymentId,
        }),
      );
      const coverage = yield* evidence.coverage(payment.paymentId);
      expect(coverage.startsWith('Held ')).toBe(true);
      expect(yield* calculatorOf(evidence, payment.paymentId)).toBe(coverage);
      const debt = yield* evidence.debt({ paymentId: payment.paymentId });
      expect(debt.openCases.length + debt.unresolvedOperations.length).toBeGreaterThan(0);
    }),
  ),
);
