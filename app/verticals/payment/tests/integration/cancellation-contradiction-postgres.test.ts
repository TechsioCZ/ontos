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
import { requestPaymentCancellationAction } from '../../src/actions/request-payment-cancellation.action.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase, EvidenceScenario } from './evidence-native-support.ts';

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* cancellationNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('CancellationContradiction.makeRuntimes')(function* makeRuntimes(
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

const scenario = Effect.fn('CancellationContradiction.scenario')(function* scenario() {
  // Gateway dispatches admitted under R1 are completion-bound executor work of R1 (#1158).
  yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  const evidence = evidenceScenarioOf({ native: database, r1, r2, scope });
  return { evidence, r1, scope };
});
type CancellationScenario = Effect.Success<ReturnType<typeof scenario>>;

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

/** One GoPay callback; `fields` carries exactly the statement members the scenario names. */
const gatewayStatement = (fields: {
  readonly amount?: { readonly amountMinor: number; readonly currency: 'CZK' };
  readonly economicEffectKey?: string;
  readonly factKind:
    | 'CANCEL_CONFIRMED'
    | 'CANCEL_NOT_EFFECTED'
    | 'COLLECTION_CONFIRMED'
    | 'COLLECTION_NOT_EFFECTED'
    | 'COLLECTION_PENDING';
  readonly operationId: string;
  readonly paymentId: string;
  readonly sourceOccurrenceId?: string;
}) => ({
  factFamily: 'GATEWAY_OUTCOME' as const,
  source: GOPAY_SOURCE,
  sourceOccurrenceId: fields.sourceOccurrenceId ?? `gopay-callback-${randomUUID()}`,
  sourceRevision: 0,
  ...fields,
});

/** Registered `request-payment-cancellation` Action against the exact COLLECT of the Payment. */
const requestCancel = (ctx: CancellationScenario, paymentId: string, targetOperationId: string, operationKey: string) =>
  ctx.r1.actions
    .runAction({
      payload: {
        operationKey,
        paymentId,
        reason: 'Customer abandoned the checkout',
        targetOperationId,
      },
      principal: principalOf(ctx.scope),
      registration: requestPaymentCancellationAction,
      transport: { correlationId: 'payment-cancel', idempotencyKey: randomUUID() },
    })
    .pipe(Effect.map((result) => result.operation));

/** A 1000 CZK GoPay Payment with one live COLLECT and one CANCEL_OR_VOID of that COLLECT (PENDING). */
const cancelledCollect = Effect.fn('CancellationContradiction.cancelledCollect')(function* cancelledCollect(
  ctx: CancellationScenario,
) {
  const { evidence } = ctx;
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-1',
    paymentId: payment.paymentId,
  });
  yield* configureGopay(evidence);
  const cancel = yield* requestCancel(ctx, payment.paymentId, collect.operationId, 'cancel-1');
  return { cancel, collect, paymentId: payment.paymentId };
});

// Scenario 2: cancel CONFIRMED, then late COLLECTION_CONFIRMED of the same COLLECT (invariants 2 and 4).
it.live('#1150 a collection reported after its confirmed cancellation opens a conflict case, never a silent hold', () =>
  native(
    Effect.gen(function* cancelConfirmedThenLateCollection() {
      const ctx = yield* scenario();
      const { cancel, collect, paymentId } = yield* cancelledCollect(ctx);
      yield* ctx.evidence.accept(
        gatewayStatement({ factKind: 'CANCEL_CONFIRMED', operationId: cancel.operationId, paymentId }),
      );
      const late = yield* ctx.evidence.accept(
        gatewayStatement({
          amount: czk(100_000),
          economicEffectKey: 'gopay:payment:late',
          factKind: 'COLLECTION_CONFIRMED',
          operationId: collect.operationId,
          paymentId,
        }),
      );
      expect(late).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
      expect(yield* ctx.evidence.coverage(paymentId)).not.toMatch(/^Established/u);
      const debt = yield* ctx.evidence.debt({ paymentId });
      expect(debt.openCases.length).toBeGreaterThan(0);
    }),
  ),
);

// Scenario 3: racing collection confirmed first (cancel still PENDING), then the cancel is confirmed.
it.live(
  '#1150 a cancellation confirmed after its collection was proven opens a conflict case, never a silent hold',
  () =>
    native(
      Effect.gen(function* collectThenCancelConfirmed() {
        const ctx = yield* scenario();
        const { cancel, collect, paymentId } = yield* cancelledCollect(ctx);
        yield* ctx.evidence.accept(
          gatewayStatement({
            amount: czk(100_000),
            economicEffectKey: 'gopay:payment:race',
            factKind: 'COLLECTION_CONFIRMED',
            operationId: collect.operationId,
            paymentId,
          }),
        );
        const cancelled = yield* ctx.evidence.accept(
          gatewayStatement({ factKind: 'CANCEL_CONFIRMED', operationId: cancel.operationId, paymentId }),
        );
        expect(cancelled).toMatchObject({ acceptanceOutcome: 'CONFLICT', interpretation: 'CONFLICT' });
        expect(yield* ctx.evidence.coverage(paymentId)).toMatch(/^Held/u);
        const debt = yield* ctx.evidence.debt({ paymentId });
        expect(debt.openCases.length).toBeGreaterThan(0);
      }),
    ),
);
