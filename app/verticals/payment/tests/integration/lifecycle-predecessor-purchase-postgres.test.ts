import { defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { randomUUID } from 'node:crypto';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
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
import { eq } from 'drizzle-orm';
import { Crypto, Effect, Option } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { createPaymentAction } from '../../src/actions/create-payment.action.ts';
import { payments } from '../../src/database/schema.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  LIFECYCLE_GATEWAY_BINDING,
  makeLifecycleOwnerContractFixture,
} from '../support/lifecycle-owner-contract.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { failureCodeOf, makeTestScope, operationalScopeOf, purchasingContextFor } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1148 lifecycle regressions. Real Actions over the worktree
 * PostgreSQL.
 */

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* predecessorNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

const makeRuntimes = Effect.fn('PredecessorPurchase.makeRuntimes')(function* makeRuntimes(
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
      databaseIdentities: defineDatabaseIdentityEnrollment([]),
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

const CUSTOMER_CONFIGURATION = 'customer-configuration-predecessor-purchase';

const setup = Effect.fn('PredecessorPurchase.setup')(function* setup() {
  const database = yield* nativeDatabase;
  const scope: PaymentTestScope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  yield* database.database.transaction((transaction) =>
    Effect.gen(function* enableGateway() {
      const scoped = yield* installOperationalScope(
        transaction,
        operationalScopeOf(scope),
        defineDatabaseIdentityEnrollment([]),
      );
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
        reason: 'Test precondition: the merchant offers this method',
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
  const principal = principalOf(scope);
  const paymentTermRef = {
    moduleId: 'payment.term-catalog' as const,
    resourceId: randomUUID(),
    resourceType: 'payment.term-catalog.payment-term' as const,
    tenantId: scope.tenantId,
  };
  const intent = (
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
  const create = (payload: ReturnType<typeof intent>) =>
    r1.actions
      .runAction({
        payload,
        principal,
        registration: createPaymentAction,
        transport: { correlationId: 'predecessor-purchase-create', idempotencyKey: randomUUID() },
      })
      .pipe(Effect.provide(owners.layer));
  return { create, database, intent };
});

it.live('#1148 a successor cannot name a predecessor that belongs to a different purchase', () =>
  native(
    Effect.gen(function* scenarioForeignPredecessor() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const s = yield* setup();
      const foreign = yield* s.create(s.intent());
      expect(yield* failureCodeOf(s.create(s.intent({ predecessorPaymentId: foreign.payment.paymentId })))).toBe(
        'payment_predecessor_unresolved_conflict',
      );
      const successors = yield* s.database.coreAdmin
        .select({ paymentId: payments.paymentId })
        .from(payments)
        .where(eq(payments.predecessorPaymentId, foreign.payment.paymentId));
      expect(successors).toHaveLength(0);
    }),
  ),
);

it.live('#1148 a successor may name a predecessor of its own purchase', () =>
  native(
    Effect.gen(function* scenarioSamePurchasePredecessor() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const s = yield* setup();
      const purchaseCorrelationId = `purchase-${randomUUID()}`;
      const original = yield* s.create(s.intent({ purchaseCorrelationId }));
      const successor = yield* s.create(
        s.intent({ predecessorPaymentId: original.payment.paymentId, purchaseCorrelationId }),
      );
      expect(successor.payment.predecessorPaymentId).toStrictEqual(Option.some(original.payment.paymentId));
    }),
  ),
);
