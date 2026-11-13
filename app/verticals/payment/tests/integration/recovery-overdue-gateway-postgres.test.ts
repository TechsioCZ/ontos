import { randomUUID } from 'node:crypto';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { applicationCompositionDurableWork, coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { openModuleEntrypointGateway } from '../../../../packages/core-runtime/tests/support/open-module-entrypoint-gateway.ts';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Crypto, Effect, Option } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { createPaymentAction } from '../../src/actions/create-payment.action.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { payments } from '../../src/database/schema.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  LIFECYCLE_GATEWAY_BINDING,
  makeLifecycleOwnerContractFixture,
} from '../support/lifecycle-owner-contract.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope, operationalScopeOf, purchasingContextFor } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  COMPOSITION_R2,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/** Recovery overdue: create/collect/recovery lifecycle through the registered Actions on PostgreSQL. */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* recoveryOverdueNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('RecoveryOverdue.makeRuntimes')(function* makeRuntimes(
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

const CUSTOMER_CONFIGURATION = 'customer-configuration-recovery-overdue';

const setup = Effect.fn('RecoveryOverdue.setup')(function* setup() {
  const database = yield* nativeDatabase;
  const scope: PaymentTestScope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  yield* database.database.transaction((transaction) =>
    Effect.gen(function* enableGateway() {
      const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
      yield* paymentApplicabilityPersistenceForTransaction(scoped).configureEnablement({
        customerConfigurationId: CUSTOMER_CONFIGURATION,
        enabled: true,
        expectedRevision: Option.none(),
        method: 'ONLINE_GATEWAY',
        provenance: {
          actionInvocationId: randomUUID(),
          actorPrincipalId: scope.principalId,
          compositionRevision: COMPOSITION_R1,
        },
        reason: 'recovery-overdue precondition: the merchant offers this method',
      });
    }),
  );
  const owners = yield* makeLifecycleOwnerContractFixture({
    enabledBindings: [LIFECYCLE_GATEWAY_BINDING],
    gatewayAvailable: true,
    metadataRevision: 1,
    termUse: 'USABLE',
  });
  const r1 = yield* makeRuntimes(database, COMPOSITION_R1);
  const r2 = yield* makeRuntimes(database, COMPOSITION_R2);
  const ev = evidenceScenarioOf({ native: database, r1, r2, scope });
  const principal = principalOf(scope);
  const paymentTermRef = {
    moduleId: 'payment.term-catalog' as const,
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: scope.tenantId,
  };
  const intentOf = (
    overrides: { readonly predecessorPaymentId?: string; readonly purchaseCorrelationId?: string } = {},
  ) => {
    const purchaseCorrelationId = overrides.purchaseCorrelationId ?? `purchase-${randomUUID()}`;
    const base = {
      customerConfigurationId: CUSTOMER_CONFIGURATION,
      intentKey: `intent-${randomUUID()}`,
      payableAmount: { amountMinor: 100_000, currency: 'CZK' as const },
      paymentTermRef,
      purchaseCorrelationId,
      purchasingContext: purchasingContextFor(scope, purchaseCorrelationId),
      selection: { method: 'ONLINE_GATEWAY' as const, selectedBinding: LIFECYCLE_GATEWAY_BINDING },
    };
    return overrides.predecessorPaymentId === undefined
      ? base
      : { ...base, predecessorPaymentId: overrides.predecessorPaymentId };
  };
  const create = (payload: ReturnType<typeof intentOf>, runtimes = r1) =>
    runtimes.actions
      .runAction({
        payload,
        principal,
        registration: createPaymentAction,
        transport: { correlationId: 'recovery-overdue-create', idempotencyKey: randomUUID() },
      })
      .pipe(Effect.provide(owners.layer));
  const collect = (paymentId: string, operationKey: string, amountMinor = 100_000, runtimes = r1) =>
    runtimes.actions
      .runAction({
        payload: {
          amount: { amountMinor, currency: 'CZK' as const },
          method: 'ONLINE_GATEWAY' as const,
          operationKey,
          // The GoPay binding needs the payer's email (plan D-P3).
          payerContact: { email: 'payer@example.test' },
          paymentId,
        },
        principal,
        registration: startPaymentCollectionAction,
        transport: { correlationId: 'recovery-overdue-collect', idempotencyKey: randomUUID() },
      })
      .pipe(Effect.provide(owners.layer));
  const unknownWork = (operationId: string) =>
    database.coreAdmin
      .select({ originalRevision: applicationCompositionDurableWork.originalRevision })
      .from(applicationCompositionDurableWork)
      .where(
        and(
          eq(applicationCompositionDurableWork.ownerModuleKey, 'payment.core'),
          eq(applicationCompositionDurableWork.workId, `payment-operation:${scope.tenantId}:${operationId}`),
        ),
      )
      .pipe(Effect.map((rows) => rows.map((row) => row.originalRevision)));
  const successorsOf = (paymentId: string) =>
    database.coreAdmin
      .select({ paymentId: payments.paymentId })
      .from(payments)
      .where(eq(payments.predecessorPaymentId, paymentId));
  return { collect, create, database, ev, intentOf, principal, r1, r2, scope, successorsOf, unknownWork };
});

type Setup = Effect.Success<ReturnType<typeof setup>>;

it.live(
  '#1151 an overdue gateway COLLECT with no callback becomes INDETERMINATE (spec: timeout/missing callback)',
  () =>
    native(
      Effect.gen(function* overdueGatewayCollect() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
        const s: Setup = yield* setup();
        const payment = yield* s.create(s.intentOf());
        const { paymentId } = payment.payment;
        const collected = yield* s.collect(paymentId, 'collect-overdue');
        const { operationId } = collected.operation;
        const recovered = yield* s.ev.recover({
          operationId,
          paymentId,
          reason: 'No gateway callback arrived in the expected business time',
          trigger: 'OUTCOME_OVERDUE',
        });
        expect(recovered).toMatchObject({ operationOutcome: 'INDETERMINATE', previousOutcome: 'PENDING' });
        expect(yield* s.unknownWork(operationId)).toHaveLength(1);
      }),
    ),
);
