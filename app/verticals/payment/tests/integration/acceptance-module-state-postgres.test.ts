import { randomUUID } from 'node:crypto';

import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { count, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Predicate, Result } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations, outboxMessages, tenantModuleStates } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import type { ModuleEntrypointAccess } from '../../../../packages/core-runtime/src/modules/module-entrypoint.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import type { ModuleStateDecision } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import {
  makeTenantModuleStateService,
  TENANT_MODULE_STATES,
} from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { TenantModuleState } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { paymentUnavailableOwnerPortsLive } from '../../api/payment-production-layers.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { ConfigurePaymentMethodEnablementPayloadSchema } from '../../shared/actions/configure-payment-method-enablement.ts';
import type { ConfigurePaymentSourceAuthorityPayloadSchema } from '../../shared/actions/configure-payment-source-authority.ts';
import type { CreatePaymentPayloadSchema } from '../../shared/actions/create-payment.ts';
import type { IssuePaymentAuthorizationPayloadSchema } from '../../shared/actions/issue-payment-authorization.ts';
import type { RecordPaymentLocalEvidencePayloadSchema } from '../../shared/actions/record-payment-local-evidence.ts';
import type { RecordPaymentReconciliationDecisionPayloadSchema } from '../../shared/actions/record-payment-reconciliation-decision.ts';
import type { RequestPaymentCancellationPayloadSchema } from '../../shared/actions/request-payment-cancellation.ts';
import type { RequestPaymentOperationRecoveryPayloadSchema } from '../../shared/actions/request-payment-operation-recovery.ts';
import type { RequestPaymentRefundPayloadSchema } from '../../shared/actions/request-payment-refund.ts';
import type { StartPaymentCollectionPayloadSchema } from '../../shared/actions/start-payment-collection.ts';
import type { PaymentMethodApplicabilityRequestSchema } from '../../shared/apis/payment-method-applicability.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentMethodEnablementAction } from '../../src/actions/configure-payment-method-enablement.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { createPaymentAction } from '../../src/actions/create-payment.action.ts';
import { issuePaymentAuthorizationAction } from '../../src/actions/issue-payment-authorization.action.ts';
import { recordPaymentLocalEvidenceAction } from '../../src/actions/record-payment-local-evidence.action.ts';
import { recordPaymentReconciliationDecisionAction } from '../../src/actions/record-payment-reconciliation-decision.action.ts';
import { requestPaymentCancellationAction } from '../../src/actions/request-payment-cancellation.action.ts';
import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
import { requestPaymentRefundAction } from '../../src/actions/request-payment-refund.action.ts';
import { startPaymentCollectionAction } from '../../src/actions/start-payment-collection.action.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import { paymentAuthorizationValidationRead } from '../../src/api/payment-authorization-validation.read.ts';
import { paymentHistoryRead } from '../../src/api/payment-history.read.ts';
import { paymentMethodApplicabilityRead } from '../../src/api/payment-method-applicability.read.ts';
import { paymentReconciliationDebtRead } from '../../src/api/payment-reconciliation-debt.read.ts';
import {
  methodEnablements,
  observations,
  paymentAuthorizations,
  paymentOperations,
  payments,
  reconciliationCases,
  reconciliationDecisions,
  recoveryRequests,
  sourceAuthorities,
} from '../../src/database/schema.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { makeTestScope } from './database-fixture.ts';
import {
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  GATEWAY_BINDING,
  principalOf,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1153 TECH-02 Module State matrix through the REAL Core Action and Read runtimes on the worktree
 * PostgreSQL: the Tenant's `core.tenant_module_states` row (or its absence) is read by the production
 * module-state gate, every registered Payment entrypoint is invoked with a valid public request, and
 * Permission/scope/context are opened so the Module State gate is the only variable. The retained
 * Payment, COLLECT, source authority, proof and reconciliation case are seeded through the foundation
 * owner persistence before the state applies, as history of an earlier active period.
 */

const COMPOSITION = '7'.repeat(64);
type StateSetup = TenantModuleState | 'missing';
type Decision = ModuleStateDecision;
type AccessClass = Exclude<ModuleEntrypointAccess, 'background'>;

/** #1153 matrix, written out literally (not derived from Core). */
const ISSUE_1153_MATRIX = {
  active: { historical_read: 'allow', read: 'allow', write: 'allow' },
  archived: { historical_read: 'allow', read: 'deny', write: 'deny' },
  deprecated: { historical_read: 'allow', read: 'allow', write: 'deny' },
  inactive: { historical_read: 'allow', read: 'deny', write: 'deny' },
  missing: { historical_read: 'deny', read: 'deny', write: 'deny' },
  quarantined: { historical_read: 'deny', read: 'deny', write: 'deny' },
  read_only: { historical_read: 'allow', read: 'allow', write: 'deny' },
  suspended: { historical_read: 'allow', read: 'deny', write: 'deny' },
} as const satisfies Readonly<Record<StateSetup, Readonly<Record<AccessClass, Decision>>>>;
const STATE_SETUPS: readonly StateSetup[] = [...TENANT_MODULE_STATES, 'missing'];

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* acceptanceNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase;
});

/** Real Core runtimes whose only closed variable is the production Module State gate. */
const makeGatedRuntimes = Effect.fn('AcceptanceModuleState.makeGatedRuntimes')(function* makeGatedRuntimes(
  database: EvidenceNativeDatabase,
  stages: string[],
) {
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate('allowed').bound;
  const gate = makeModuleStateGate(makeTenantModuleStateService({ executor: database.coreAdmin }));
  const gateway = makeModuleEntrypointGateway(gate);
  const actions: ActionRuntimeService = makeActionRuntime(
    { executor: database.database },
    makeActionRepository(crypto),
    evidenceAllowedPermission,
    testOperationalScopeResolver,
    {
      ...openActionRuntimeOptions,
      accessDecision,
      contextAccess: evidenceContextAccess,
      moduleEntrypointGateway: gateway,
      moduleStateGate: gate,
      onStage: (stage) => {
        stages.push(stage);
      },
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(COMPOSITION),
    },
  );
  const reads: ReadRuntimeService = makeReadRuntime(
    { executor: database.database },
    gateway,
    testOperationalScopeResolver,
    evidenceContextAccess,
    {
      accessDecision,
      onStage: (stage) => {
        stages.push(stage);
      },
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
    },
  );
  return { actions, reads };
});

/** Fresh Tenant/Selling Legal Entity whose Payment module is in `state`, with retained history. */
const stateScenario = Effect.fn('AcceptanceModuleState.scenario')(function* stateScenario(state: StateSetup) {
  const database = yield* nativeDatabase;
  const scope = yield* makeTestScope;
  yield* seedCoreScope(database, scope);
  const stages: string[] = [];
  const runtimes = yield* makeGatedRuntimes(database, stages);
  const evidence = evidenceScenarioOf({ native: database, r1: runtimes, r2: runtimes, scope });
  // History retained from an earlier active period, written through the foundation owner persistence.
  const payment = yield* evidence.createPayment();
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    operationKey: 'collect-retained',
    paymentId: payment.paymentId,
  });
  const authorityId = yield* evidence.configureAuthority();
  const authorizationId = yield* evidence.issuePrepaidProof(payment.paymentId, payment.coverageRevision);
  const caseId = yield* evidence.openCase('UNRESOLVED_OPERATION', payment.paymentId, collect.operationId);
  if (state !== 'missing') {
    yield* database.coreAdmin
      .insert(tenantModuleStates)
      .values({ moduleKey: 'payment.core', state, tenantId: scope.tenantId });
  }
  return { authorityId, authorizationId, caseId, collect, database, evidence, payment, runtimes, scope, stages };
});
type StateScenario = Effect.Success<ReturnType<typeof stateScenario>>;

/** Every Payment-owned row and Core Outbox message of the scenario Tenant. */
const tenantFootprint = (scenario: StateScenario) => {
  const admin = scenario.database.coreAdmin;
  const { tenantId } = scenario.scope;
  return Effect.all(
    {
      authorizations: admin
        .select({ rows: count() })
        .from(paymentAuthorizations)
        .where(eq(paymentAuthorizations.tenantId, tenantId)),
      cases: admin
        .select({ revision: reconciliationCases.revision, status: reconciliationCases.status })
        .from(reconciliationCases)
        .where(eq(reconciliationCases.tenantId, tenantId)),
      decisions: admin
        .select({ rows: count() })
        .from(reconciliationDecisions)
        .where(eq(reconciliationDecisions.tenantId, tenantId)),
      enablements: admin
        .select({ rows: count() })
        .from(methodEnablements)
        .where(eq(methodEnablements.tenantId, tenantId)),
      observations: admin.select({ rows: count() }).from(observations).where(eq(observations.tenantId, tenantId)),
      operations: admin
        .select({ outcome: paymentOperations.outcome, revision: paymentOperations.outcomeRevision })
        .from(paymentOperations)
        .where(eq(paymentOperations.tenantId, tenantId)),
      outbox: admin.select({ rows: count() }).from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      payments: admin
        .select({ aggregateVersion: payments.aggregateVersion, coverageRevision: payments.coverageRevision })
        .from(payments)
        .where(eq(payments.tenantId, tenantId)),
      recoveries: admin.select({ rows: count() }).from(recoveryRequests).where(eq(recoveryRequests.tenantId, tenantId)),
      sourceAuthorities: admin
        .select({ revision: sourceAuthorities.revision, status: sourceAuthorities.status })
        .from(sourceAuthorities)
        .where(eq(sourceAuthorities.tenantId, tenantId)),
    },
    { concurrency: 1 },
  );
};

interface Invocation {
  readonly access: AccessClass;
  readonly entrypointKey: string;
  readonly run: () => Effect.Effect<unknown, unknown>;
}

const actionTransport = () => ({ correlationId: 'payment-acceptance-module-state', idempotencyKey: randomUUID() });
const readTransport = { correlationId: 'payment-acceptance-module-state' } as const;
/** The production fail-closed owner ports, as `api/index.ts` merges them into both runtimes. */
const withProductionPorts = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(paymentUnavailableOwnerPortsLive));
const writeInvocation = (entrypointKey: string, run: Invocation['run']): Invocation => ({
  access: 'write',
  entrypointKey,
  run,
});
const readInvocation = (entrypointKey: string, run: Invocation['run'], access: AccessClass = 'read'): Invocation => ({
  access,
  entrypointKey,
  run,
});

/** One valid public request for every registered Payment entrypoint (16 = 11 Actions + 5 Reads). */
const invocations = (scenario: StateScenario): readonly Invocation[] => {
  const { authorizationId, caseId, collect, payment, runtimes, scope } = scenario;
  const { actions, reads } = runtimes;
  const principal = principalOf(scope);
  const amount = { amountMinor: 100_000, currency: 'CZK' } as const;
  const binding = {
    amount,
    executionBinding: GATEWAY_BINDING,
    method: 'ONLINE_GATEWAY' as const,
    orderCommitmentAttemptId: 'attempt-module-state',
    orderCommitmentTime: DateTime.formatIso(payment.createdAt),
    paymentId: payment.paymentId,
    paymentTermRef: payment.paymentTermRef,
    purchaseCorrelationId: payment.purchaseCorrelationId,
  };
  const enablement = {
    customerConfigurationId: 'customer-configuration-1',
    enabled: true,
    method: 'BANK_TRANSFER_ADVANCE',
    reason: 'Offer bank transfer in advance',
  } satisfies typeof ConfigurePaymentMethodEnablementPayloadSchema.Encoded;
  const authority = {
    factFamily: 'BANK_ACCOUNTING_RECEIPT',
    reason: 'Accounting owns bank receipts',
    refundRoute: false,
    source: {
      accountRef: 'CZ6508000000192000145399',
      environment: 'production',
      sourceKind: 'BANK_ACCOUNTING',
      sourceSystem: 'erp-acceptance',
    },
    status: 'ACTIVE',
  } satisfies typeof ConfigurePaymentSourceAuthorityPayloadSchema.Encoded;
  const intent = {
    customerConfigurationId: 'customer-configuration-1',
    intentKey: `intent-${randomUUID()}`,
    payableAmount: amount,
    paymentTermRef: payment.paymentTermRef,
    purchaseCorrelationId: `purchase-${randomUUID()}`,
    selection: { method: 'BANK_TRANSFER_ADVANCE' },
  } satisfies typeof CreatePaymentPayloadSchema.Encoded;
  const collection = {
    amount,
    method: 'ONLINE_GATEWAY',
    operationKey: 'collect-second',
    paymentId: payment.paymentId,
  } satisfies typeof StartPaymentCollectionPayloadSchema.Encoded;
  const issuance = {
    binding,
    issuanceKey: 'issuance-module-state',
    validitySeconds: 300,
  } satisfies typeof IssuePaymentAuthorizationPayloadSchema.Encoded;
  const cancellation = {
    operationKey: 'cancel-module-state',
    paymentId: payment.paymentId,
    reason: 'Customer abandoned the purchase',
    targetOperationId: collect.operationId,
  } satisfies typeof RequestPaymentCancellationPayloadSchema.Encoded;
  const refund = {
    amount,
    basis: {
      _tag: 'REFUNDABLE_ITEMS',
      items: [{ ...amount, itemRef: 'order-item-1', sourceEvidenceRef: 'order-item-evidence-1' }],
    },
    operationKey: 'refund-module-state',
    paymentId: payment.paymentId,
    reason: 'Customer returned the item',
  } satisfies typeof RequestPaymentRefundPayloadSchema.Encoded;
  const callback = {
    amount,
    factFamily: 'GATEWAY_OUTCOME',
    factKind: 'COLLECTION_CONFIRMED',
    operationId: collect.operationId,
    paymentId: payment.paymentId,
    source: {
      accountRef: 'gopay-account-1',
      environment: 'production',
      sourceKind: 'PAYMENT_GATEWAY',
      sourceSystem: 'gopay',
    },
    sourceOccurrenceId: `callback-${randomUUID()}`,
    sourceRevision: 1,
  } satisfies typeof AcceptPaymentObservationPayloadSchema.Encoded;
  const localEvidence = {
    amount,
    evidenceRef: 'pos-receipt-1',
    factFamily: 'LOCAL_POS_COLLECTION',
    factKind: 'COLLECTION_CONFIRMED',
    paymentId: payment.paymentId,
    pickupCapabilityRef: 'pickup-prague-1',
    reason: 'Customer paid at the pickup counter',
    source: {
      accountRef: 'pos-drawer-1',
      environment: 'production',
      sourceKind: 'LOCAL_POS_OPERATOR',
      sourceSystem: 'pos',
    },
    sourceOccurrenceId: `pos-${randomUUID()}`,
    sourceRevision: 1,
  } satisfies typeof RecordPaymentLocalEvidencePayloadSchema.Encoded;
  const recovery = {
    operationId: collect.operationId,
    paymentId: payment.paymentId,
    reason: 'The provider response was lost',
    trigger: 'EXECUTION_OUTCOME_UNKNOWN',
  } satisfies typeof RequestPaymentOperationRecoveryPayloadSchema.Encoded;
  const decision = {
    caseId,
    decision: { _tag: 'CLASSIFY_CONFLICT' },
    reason: 'Contradicting provider statements',
  } satisfies typeof RecordPaymentReconciliationDecisionPayloadSchema.Encoded;
  const applicability = {
    amount,
    branches: [{ method: 'BANK_TRANSFER_ADVANCE' }],
    customerConfigurationId: 'customer-configuration-1',
    paymentTermRef: payment.paymentTermRef,
    purchasingContext: {
      channelId: 'channel-b2b',
      contextRef: 'purchasing-context-1',
      contextRevision: 'revision-1',
      marketId: 'market-cz',
      subject: { guestEvidenceRef: 'guest-evidence-1', guestSessionRef: 'guest-session-1', kind: 'GUEST' },
    },
  } satisfies typeof PaymentMethodApplicabilityRequestSchema.Encoded;
  return [
    writeInvocation('payment.core.configure-payment-method-enablement', () =>
      withProductionPorts(
        actions.runAction({
          payload: enablement,
          principal,
          registration: configurePaymentMethodEnablementAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.configure-payment-source-authority', () =>
      withProductionPorts(
        actions.runAction({
          payload: authority,
          principal,
          registration: configurePaymentSourceAuthorityAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.create-payment', () =>
      withProductionPorts(
        actions.runAction({
          payload: intent,
          principal,
          registration: createPaymentAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.start-payment-collection', () =>
      withProductionPorts(
        actions.runAction({
          payload: collection,
          principal,
          registration: startPaymentCollectionAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.issue-payment-authorization', () =>
      withProductionPorts(
        actions.runAction({
          payload: issuance,
          principal,
          registration: issuePaymentAuthorizationAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.request-payment-cancellation', () =>
      withProductionPorts(
        actions.runAction({
          payload: cancellation,
          principal,
          registration: requestPaymentCancellationAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.request-payment-refund', () =>
      withProductionPorts(
        actions.runAction({
          payload: refund,
          principal,
          registration: requestPaymentRefundAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.accept-payment-observation', () =>
      withProductionPorts(
        actions.runAction({
          payload: callback,
          principal,
          registration: acceptPaymentObservationAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.record-payment-local-evidence', () =>
      withProductionPorts(
        actions.runAction({
          payload: localEvidence,
          principal,
          registration: recordPaymentLocalEvidenceAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.request-payment-operation-recovery', () =>
      withProductionPorts(
        actions.runAction({
          payload: recovery,
          principal,
          registration: requestPaymentOperationRecoveryAction,
          transport: actionTransport(),
        }),
      ),
    ),
    writeInvocation('payment.core.record-payment-reconciliation-decision', () =>
      withProductionPorts(
        actions.runAction({
          payload: decision,
          principal,
          registration: recordPaymentReconciliationDecisionAction,
          transport: actionTransport(),
        }),
      ),
    ),
    readInvocation('payment.core.api.payment-method-applicability', () =>
      withProductionPorts(
        reads.runRead({
          input: applicability,
          principal,
          registration: paymentMethodApplicabilityRead,
          transport: readTransport,
        }),
      ),
    ),
    readInvocation('payment.core.api.current-payment', () =>
      withProductionPorts(
        reads.runRead({
          input: { paymentId: payment.paymentId },
          principal,
          registration: currentPaymentRead,
          transport: readTransport,
        }),
      ),
    ),
    readInvocation('payment.core.api.payment-authorization-validation', () =>
      withProductionPorts(
        reads.runRead({
          input: { authorizationId, binding },
          principal,
          registration: paymentAuthorizationValidationRead,
          transport: readTransport,
        }),
      ),
    ),
    readInvocation('payment.core.api.payment-reconciliation-debt', () =>
      withProductionPorts(
        reads.runRead({ input: {}, principal, registration: paymentReconciliationDebtRead, transport: readTransport }),
      ),
    ),
    readInvocation(
      'payment.core.api.payment-history',
      () =>
        withProductionPorts(
          reads.runRead({
            input: { paymentId: payment.paymentId },
            principal,
            registration: paymentHistoryRead,
            transport: readTransport,
          }),
        ),
      'historical_read',
    ),
  ];
};

interface Observed {
  readonly decision: Decision;
  readonly entrypointKey: string;
  readonly failureTag: string | undefined;
  readonly handlerExecuted: boolean;
}

/** Runs one entrypoint and reports whether the Core gate admitted it, from the runtime's own stages. */
const observe = (scenario: StateScenario, invocation: Invocation) =>
  Effect.gen(function* observeInvocation() {
    scenario.stages.length = 0;
    const result = yield* Effect.result(invocation.run());
    const admitted = scenario.stages.some((stage) => stage === 'module_state_gate' || stage === 'module_state_checked');
    return {
      decision: admitted ? 'allow' : 'deny',
      entrypointKey: invocation.entrypointKey,
      failureTag:
        Result.isFailure(result) &&
        Predicate.hasProperty(result.failure, '_tag') &&
        Predicate.isString(result.failure._tag)
          ? result.failure._tag
          : undefined,
      handlerExecuted: scenario.stages.includes('handler_executed'),
    } satisfies Observed;
  });

for (const state of STATE_SETUPS) {
  it.live(`#1153 Module State ${state}: every registered Payment entrypoint is gated exactly as the #1153 matrix`, () =>
    native(
      Effect.gen(function* moduleStateRow() {
        const scenario = yield* stateScenario(state);
        const before = yield* tenantFootprint(scenario);
        const observed: Observed[] = [];
        const all = invocations(scenario);
        for (const invocation of all) {
          observed.push(yield* observe(scenario, invocation));
        }
        expect(observed.map((entry) => [entry.entrypointKey, entry.decision])).toEqual(
          all.map((invocation) => [invocation.entrypointKey, ISSUE_1153_MATRIX[state][invocation.access]]),
        );
        // A denial is the typed Core Module State refusal, decided before any owner handler runs.
        for (const denied of observed.filter((entry) => entry.decision === 'deny')) {
          expect([denied.entrypointKey, denied.failureTag, denied.handlerExecuted]).toEqual([
            denied.entrypointKey,
            'ModuleStateDeniedError',
            false,
          ]);
        }
        if (state !== 'active') {
          // No write is admitted outside `active`: the Tenant's Payment rows and Outbox are untouched.
          expect(yield* tenantFootprint(scenario)).toEqual(before);
        }
      }),
    ),
  );
}

it.live(
  '#1153 Historical information does not authorize suspended-module writes: history is returned, callback, refund and recovery are denied',
  () =>
    native(
      Effect.gen(function* suspendedPayment() {
        const scenario = yield* stateScenario('suspended');
        const all = invocations(scenario);
        const run = (entrypointKey: string) =>
          Effect.gen(function* runEntrypoint() {
            const invocation = all.find((candidate) => candidate.entrypointKey === entrypointKey);
            expect(invocation).toBeDefined();
            return yield* Effect.result(invocation === undefined ? Effect.void : invocation.run());
          });
        const before = yield* tenantFootprint(scenario);

        // The declared immutable projection returns the retained history of the old Payment.
        const history = yield* scenario.evidence.history(scenario.payment.paymentId);
        expect(history).toMatchObject({
          currentValidityClaimed: false,
          operations: [
            {
              binding: GATEWAY_BINDING,
              operationId: scenario.collect.operationId,
              operationKey: 'collect-retained',
              operationKind: 'COLLECT',
            },
          ],
          projection: 'HISTORICAL_IMMUTABLE',
          transitions: [{ causeKind: 'CREATION', operationId: scenario.collect.operationId, toOutcome: 'PENDING' }],
        });

        // Callback acceptance, local evidence, refund, cancellation and recovery stay denied by Core.
        for (const key of [
          'payment.core.accept-payment-observation',
          'payment.core.record-payment-local-evidence',
          'payment.core.request-payment-refund',
          'payment.core.request-payment-cancellation',
          'payment.core.request-payment-operation-recovery',
          'payment.core.record-payment-reconciliation-decision',
        ]) {
          const result = yield* run(key);
          expect([
            key,
            Result.isFailure(result) && Predicate.isTagged(result.failure, 'ModuleStateDeniedError'),
          ]).toEqual([key, true]);
        }
        // historical_read is not a fallback: the Current read of the same Payment is refused, not answered
        // from history, and Current proof validation is refused too.
        for (const key of ['payment.core.api.current-payment', 'payment.core.api.payment-authorization-validation']) {
          const result = yield* run(key);
          expect([
            key,
            Result.isFailure(result) && Predicate.isTagged(result.failure, 'ModuleStateDeniedError'),
          ]).toEqual([key, true]);
        }
        // The unresolved COLLECT keeps its original outcome; no observation, recovery or refund was recorded.
        const after = yield* tenantFootprint(scenario);
        expect(after).toEqual(before);
        expect(after.operations).toEqual([{ outcome: 'PENDING', revision: 1 }]);
      }),
    ),
);

it.live('#1153 quarantine denies every Payment entrypoint, including the historical projection', () =>
  native(
    Effect.gen(function* quarantinedPayment() {
      const scenario = yield* stateScenario('quarantined');
      const history = yield* Effect.flip(scenario.evidence.history(scenario.payment.paymentId));
      expect(Predicate.isTagged(history, 'ModuleStateDeniedError')).toBe(true);
      const debt = yield* Effect.flip(scenario.evidence.debt());
      expect(Predicate.isTagged(debt, 'ModuleStateDeniedError')).toBe(true);
      const recovery = yield* Effect.flip(
        scenario.evidence.recover({
          operationId: scenario.collect.operationId,
          paymentId: scenario.payment.paymentId,
          reason: 'Quarantined recovery attempt',
          trigger: 'EXECUTION_OUTCOME_UNKNOWN',
        }),
      );
      expect(Predicate.isTagged(recovery, 'ModuleStateDeniedError')).toBe(true);
    }),
  ),
);

it.live('#1153 inactive and archived Payment keep history readable while Current reads stay denied', () =>
  native(
    Effect.gen(function* retiredPayment() {
      for (const state of ['inactive', 'archived'] as const) {
        const scenario = yield* stateScenario(state);
        const history = yield* scenario.evidence.history(scenario.payment.paymentId);
        expect(history).toMatchObject({ currentValidityClaimed: false });
        const current = yield* Effect.flip(
          scenario.runtimes.reads.runRead({
            input: { paymentId: scenario.payment.paymentId },
            principal: principalOf(scenario.scope),
            registration: currentPaymentRead,
            transport: { correlationId: 'payment-acceptance-current' },
          }),
        );
        expect([state, Predicate.isTagged(current, 'ModuleStateDeniedError')]).toEqual([state, true]);
      }
    }),
  ),
);
