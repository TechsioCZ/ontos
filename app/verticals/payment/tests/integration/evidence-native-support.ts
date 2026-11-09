import { randomUUID } from 'node:crypto';

import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { and, asc, eq } from 'drizzle-orm';
import type { PgClient } from '@effect/sql-pg';
import { DateTime, Effect, Match } from 'effect';
import type { Schema } from 'effect';

import {
  accessScopeFences,
  accessScopes,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import type { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PaymentCoverageSummary } from '../../shared/domain/lifecycle-views.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentRefundBasis } from '../../shared/domain/payment-refund-basis.ts';
import type {
  PaymentCorrectionEffectKind,
  PaymentMethod,
  PaymentObservationAcceptanceOutcome,
  PaymentObservationFactKind,
  PaymentOperationKind,
  PaymentOperationOutcome,
  PaymentReconciliationCaseKind,
  PaymentSourceAuthorityStatus,
} from '../../shared/domain/payment-vocabulary.ts';
import type { AcceptPaymentObservationPayloadSchema } from '../../shared/actions/accept-payment-observation.ts';
import type { ConfigurePaymentSourceAuthorityPayloadSchema } from '../../shared/actions/configure-payment-source-authority.ts';
import type { RecordPaymentReconciliationDecisionPayloadSchema } from '../../shared/actions/record-payment-reconciliation-decision.ts';
import type { RequestPaymentOperationRecoveryPayloadSchema } from '../../shared/actions/request-payment-operation-recovery.ts';
import type { PaymentReconciliationDebtRequestSchema } from '../../shared/apis/payment-reconciliation-debt.ts';
import { acceptPaymentObservationAction } from '../../src/actions/accept-payment-observation.action.ts';
import { configurePaymentSourceAuthorityAction } from '../../src/actions/configure-payment-source-authority.action.ts';
import { recordPaymentReconciliationDecisionAction } from '../../src/actions/record-payment-reconciliation-decision.action.ts';
import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
import { currentPaymentRead } from '../../src/api/current-payment.read.ts';
import { paymentHistoryRead } from '../../src/api/payment-history.read.ts';
import { paymentReconciliationDebtRead } from '../../src/api/payment-reconciliation-debt.read.ts';
import {
  observations,
  operationOutcomeTransitions,
  paymentOperations,
  reconciliationCases,
  reconciliationDecisions,
  recoveryRequests,
  sourceAuthorities,
  sourceAuthorityRevisions,
} from '../../src/database/schema.ts';
import { termSemanticOf } from '../../src/domain/authorization-currentness.ts';
import { paymentAggregatePersistenceForTransaction } from '../../src/persistence/payment-aggregate-persistence.ts';
import type { PaymentAggregatePersistence } from '../../src/persistence/payment-aggregate-persistence.ts';
import { paymentAuthorizationPersistenceForTransaction } from '../../src/persistence/payment-authorization-persistence.ts';
import { paymentEvidencePersistenceForTransaction } from '../../src/persistence/payment-evidence-persistence.ts';
import type { PaymentEvidencePersistence } from '../../src/persistence/payment-evidence-persistence.ts';
import { newPaymentInput, operationalScopeOf } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';

/** Approved runtime Composition revisions: R1 admitted the original work, R2 is the later compatible one. */

const isCollect = (operation: { readonly kind: PaymentOperationKind }) => operation.kind === 'COLLECT';

export const COMPOSITION_R1 = '1'.repeat(64);
export const COMPOSITION_R2 = '2'.repeat(64);
const AUTHENTICATION_NAMESPACE = 'test.payment-evidence.v1';

/** Core permission and context access opened for owner suites; #1153 owns the access matrix. */
export const evidenceAllowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };
export const evidenceContextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  ownerPermissions: (input) =>
    Effect.succeed(input.targets.map((target) => ({ decision: 'allowed' as const, key: target.target.key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

/** Admin (assertions/seeding) and shared-runtime (owner writes under RLS) connections of the worktree DB. */
export interface EvidenceNativeDatabase {
  readonly coreAdmin: TestDatabaseFromClient<typeof coreRelations>;
  readonly database: TestDatabaseFromClient<typeof coreRelations>;
  readonly runtimeClient: PgClient.PgClient;
}

/** Trusted session principal of a scope, as the gateway would present it. */
export const principalOf = (scope: PaymentTestScope) => ({
  authBindingId: scope.principalId,
  authContextRef: `better-auth-session:${scope.principalId}`,
  authenticationNamespaceId: AUTHENTICATION_NAMESPACE,
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

/** Seeds the Core identity rows the Action runner re-checks (tenant, access fences, principal binding). */
export const seedCoreScope = Effect.fn('EvidenceNative.seedCoreScope')(function* seedCoreScope(
  native: EvidenceNativeDatabase,
  scope: PaymentTestScope,
) {
  const tenantScopeId = randomUUID();
  const companyScopeId = randomUUID();
  yield* native.coreAdmin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Payment evidence native test',
    slug: `payment-evidence-${scope.tenantId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(legalEntities).values({
    legalEntityId: scope.legalEntityId,
    legalName: 'Payment evidence selling entity',
    registrationCountry: 'CZ',
    registrationNumber: `payment-evidence-${scope.legalEntityId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(accessScopes).values([
    { scopeId: tenantScopeId, tenantContextId: scope.tenantId, tenantId: scope.tenantId },
    { legalEntityId: scope.legalEntityId, scopeId: companyScopeId, tenantId: scope.tenantId },
  ]);
  yield* native.coreAdmin.insert(accessScopeFences).values([
    { revision: 1, scopeId: tenantScopeId, state: 'Ready', tenantId: scope.tenantId },
    { revision: 1, scopeId: companyScopeId, state: 'Ready', tenantId: scope.tenantId },
  ]);
  yield* native.coreAdmin.insert(principals).values({
    displayName: 'Payment evidence operator',
    kind: 'human',
    principalId: scope.principalId,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* native.coreAdmin.insert(principalAuthBindings).values({
    authenticationNamespaceId: AUTHENTICATION_NAMESPACE,
    principalAuthBindingId: scope.principalId,
    principalId: scope.principalId,
    provider: 'better_auth',
    providerSubjectId: `payment-evidence-${scope.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: scope.tenantId,
  });
});

/** Outbox rows Payment committed for one tenant and topic, oldest first. */
const outboxPayloads = (native: EvidenceNativeDatabase, tenantId: string, topic: string) =>
  native.coreAdmin
    .select({ payloadJson: outboxMessages.payloadJson })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.tenantId, tenantId),
        eq(outboxMessages.producerModuleKey, 'payment.core'),
        eq(outboxMessages.topic, topic),
      ),
    )
    .orderBy(asc(outboxMessages.createdAt))
    .pipe(Effect.map((rows) => rows.map((row) => row.payloadJson)));

/** The real Core runtimes of one approved Composition revision. */
interface EvidenceRuntimes {
  readonly actions: ActionRuntimeService;
  readonly reads: ReadRuntimeService;
}
const PROVIDER_ACCOUNT = 'gopay-account-1';

/**
 * Native #1151 evidence scenario: fresh Tenant/Selling Legal Entity, the real Core Action and Read
 * runtimes over the worktree PostgreSQL (shared native harness of the lifecycle lane) and Payment's
 * real registration, persistence and RLS. Payments and operations are created through the foundation
 * aggregate primitives (their creating Actions belong to other lanes); source authorities and
 * observations are Payment-owned ledger rows written the way the source lane records them.
 */

export const GATEWAY_BINDING: PaymentExecutionBinding = Object.freeze({
  _tag: 'GATEWAY_ACCOUNT',
  environment: 'production',
  providerAccountRef: PROVIDER_ACCOUNT,
  providerFamily: 'GOPAY',
});
export const BANK_BINDING: PaymentExecutionBinding = Object.freeze({ _tag: 'BANK_ACCOUNTING_RECEIPT' });

export const OUTCOME_CHANGED = 'payment.core.operation-outcome-changed.v1';

/** A readable `current-payment` coverage: its tag plus the money it states. */
export const coverageSummaryOf = (coverage: PaymentCoverageSummary): string =>
  Match.valueTags(coverage, {
    ESTABLISHED: ({ collected, confirmedReturned, remaining }) =>
      `Established collected=${collected.amountMinor} returned=${confirmedReturned.amountMinor} remaining=${remaining.amountMinor}`,
    HELD: ({ reason }) => `Held ${reason}`,
    NOT_COLLECTED: () => 'NotCollected',
    ZERO_PAYABLE: () => 'ZeroPayable',
  });
const currentCoverageSummary = (current: { readonly coverage: PaymentCoverageSummary }) =>
  coverageSummaryOf(current.coverage);
export const RECOVERY_REQUESTED = 'payment.core.operation-recovery-requested.v1';

export interface OperationSpec {
  readonly amountMinor: number;
  readonly binding?: PaymentExecutionBinding;
  readonly kind?: PaymentOperationKind;
  readonly materialExtras?: Readonly<Record<string, Schema.Json>>;
  readonly operationKey: string;
  readonly paymentId: string;
  readonly refundBasis?: PaymentRefundBasis;
  readonly targetOperationId?: string;
}

export interface ObservationSpec {
  readonly acceptanceOutcome?: PaymentObservationAcceptanceOutcome;
  readonly amountMinor?: number;
  readonly correctionEffect?: PaymentCorrectionEffectKind;
  readonly correctsObservationId?: string;
  readonly economicEffectKey?: string;
  readonly factKind: PaymentObservationFactKind;
  readonly occurrenceId?: string;
  readonly operationId?: string;
  readonly paymentId: string;
  readonly sourceAuthorityId: string | undefined;
}

/**
 * Every accepted SOURCE_CORRECTION records what it did to the Current interpretation (database-enforced).
 * A correction that names no amount disproves the whole statement, which reopens it to CONFLICT; a
 * partial correction must name its effect explicitly.
 */
const correctionEffectOf = (spec: ObservationSpec): PaymentCorrectionEffectKind | null => {
  if (spec.correctionEffect !== undefined) {
    return spec.correctionEffect;
  }
  const acceptedCorrection =
    spec.factKind === 'SOURCE_CORRECTION' &&
    (spec.acceptanceOutcome ?? 'ACCEPTED_OBSERVATION') === 'ACCEPTED_OBSERVATION';
  return acceptedCorrection && spec.amountMinor === undefined ? 'REOPEN_TO_CONFLICT' : null;
};

/** Built by each test file (which owns runtime construction) from the shared lifecycle harness. */
export interface EvidenceScenarioInput {
  readonly native: EvidenceNativeDatabase;
  readonly r1: EvidenceRuntimes;
  readonly r2: EvidenceRuntimes;
  readonly scope: PaymentTestScope;
}

export const evidenceScenarioOf = ({ native, r1, r2, scope }: EvidenceScenarioInput) => {
  const principal = principalOf(scope);

  const provenance = (compositionRevision = COMPOSITION_R1) => ({
    actionInvocationId: randomUUID(),
    actorPrincipalId: scope.principalId,
    compositionRevision,
  });

  /** One Core-scoped runtime transaction with both owner persistence modules. */
  const inTransaction = <Value, Failure>(
    operation: (
      aggregate: PaymentAggregatePersistence,
      evidence: PaymentEvidencePersistence,
      transaction: Effect.Success<ReturnType<typeof installOperationalScope>>,
    ) => Effect.Effect<Value, Failure>,
  ) =>
    native.database.transaction((transaction) =>
      Effect.gen(function* scopedEvidenceTransaction() {
        const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
        return yield* operation(
          paymentAggregatePersistenceForTransaction(scoped),
          paymentEvidencePersistenceForTransaction(scoped),
          scoped,
        );
      }),
    );

  const createPayment = Effect.fn('EvidenceScenario.createPayment')(function* createPayment(
    amountMinor = 100_000,
    binding: PaymentExecutionBinding = GATEWAY_BINDING,
    method: PaymentMethod = 'ONLINE_GATEWAY',
  ) {
    const input = yield* newPaymentInput(scope, amountMinor);
    const created = yield* inTransaction((aggregate) =>
      aggregate.insertPayment({ ...input, executionBinding: binding, method, provenance: provenance() }),
    );
    return created.record;
  });

  const startOperation = Effect.fn('EvidenceScenario.startOperation')(function* startOperation(spec: OperationSpec) {
    const kind = spec.kind ?? 'COLLECT';
    const base = {
      amount: { amountMinor: spec.amountMinor, currency: 'CZK' as const },
      binding: spec.binding ?? GATEWAY_BINDING,
      initialOutcome: 'PENDING' as const,
      kind,
      materialRequest: { amountMinor: spec.amountMinor, currency: 'CZK', kind, ...spec.materialExtras },
      operationKey: spec.operationKey,
      paymentId: spec.paymentId,
      provenance: provenance(),
    };
    const created = yield* inTransaction((aggregate) =>
      aggregate.insertOperation(
        spec.refundBasis === undefined || spec.targetOperationId === undefined
          ? base
          : { ...base, refundBasis: spec.refundBasis, targetOperationId: spec.targetOperationId },
      ),
    );
    return created.record;
  });

  const settle = (
    paymentId: string,
    operationId: string,
    expectedOutcomeRevision: number,
    to: PaymentOperationOutcome,
  ) =>
    inTransaction((aggregate) =>
      aggregate.transitionOperationOutcome({
        causedBy: { kind: 'OBSERVATION' },
        expectedOutcomeRevision,
        operationId,
        paymentId,
        provenance: provenance(),
        to,
      }),
    ).pipe(Effect.map((written) => written.record));

  /**
   * The authority's first revision, as the source-authority Action records it: the scope principal is
   * the bound source principal, since every statement of these scenarios is submitted as that principal.
   */
  const bindSubmitter = (
    transaction: Effect.Success<ReturnType<typeof installOperationalScope>>,
    row: typeof sourceAuthorities.$inferSelect,
  ) =>
    transaction
      .insert(sourceAuthorityRevisions)
      .values({
        actionInvocationId: row.actionInvocationId,
        actorPrincipalId: row.actorPrincipalId,
        compositionRevision: row.compositionRevision,
        legalEntityId: row.legalEntityId,
        reason: row.reason,
        recordedAt: row.configuredAt,
        refundRoute: row.refundRoute,
        revision: row.revision,
        sourceAuthorityId: row.sourceAuthorityId,
        status: row.status,
        submitterPrincipalIds: [scope.principalId],
        tenantId: row.tenantId,
      })
      .pipe(Effect.as(row.sourceAuthorityId));

  const configureAuthority = (status: PaymentSourceAuthorityStatus = 'ACTIVE') =>
    inTransaction((_aggregate, _evidence, transaction) =>
      Effect.gen(function* insertAuthorityRow() {
        const audit = provenance();
        const [row] = yield* transaction
          .insert(sourceAuthorities)
          .values({
            accountRef: PROVIDER_ACCOUNT,
            actionInvocationId: audit.actionInvocationId,
            actorPrincipalId: audit.actorPrincipalId,
            compositionRevision: audit.compositionRevision,
            configuredAt: DateTime.toDateUtc(yield* DateTime.now),
            environment: 'production',
            factFamily: 'GATEWAY_OUTCOME',
            legalEntityId: scope.legalEntityId,
            method: null,
            reason: 'Configured source authority for the evidence test',
            refundRoute: false,
            revision: 1,
            sourceKind: 'PAYMENT_GATEWAY',
            sourceSystem: `gopay-${randomUUID()}`,
            status,
            tenantId: scope.tenantId,
          })
          .returning();
        return row === undefined ? '' : yield* bindSubmitter(transaction, row);
      }),
    );

  /** Appends one observation row exactly as the source lane records evidence (append-only ledger). */
  const recordObservation = (spec: ObservationSpec, compositionRevision = COMPOSITION_R1) =>
    inTransaction((_aggregate, _evidence, transaction) =>
      Effect.gen(function* insertObservationRow() {
        const audit = provenance(compositionRevision);
        const now = DateTime.toDateUtc(yield* DateTime.now);
        const [row] = yield* transaction
          .insert(observations)
          .values({
            acceptanceOutcome: spec.acceptanceOutcome ?? 'ACCEPTED_OBSERVATION',
            accountRef: PROVIDER_ACCOUNT,
            actionInvocationId: audit.actionInvocationId,
            actorPrincipalId: audit.actorPrincipalId,
            amountMinor: spec.amountMinor ?? null,
            compositionRevision: audit.compositionRevision,
            correctionEffect: correctionEffectOf(spec),
            correctsObservationId: spec.correctsObservationId ?? null,
            currency: spec.amountMinor === undefined ? null : 'CZK',
            economicEffectKey: spec.economicEffectKey ?? null,
            environment: 'production',
            factFamily: 'GATEWAY_OUTCOME',
            factKind: spec.factKind,
            legalEntityId: scope.legalEntityId,
            operationId: spec.operationId ?? null,
            paymentId: spec.paymentId,
            receivedAt: now,
            sourceAuthorityId: spec.sourceAuthorityId ?? null,
            sourceAuthorityRevision: spec.sourceAuthorityId === undefined ? null : 1,
            sourceKind: 'PAYMENT_GATEWAY',
            sourceOccurrenceId: spec.occurrenceId ?? `occurrence-${randomUUID()}`,
            sourceRevision: 0,
            sourceSystem: 'gopay',
            tenantId: scope.tenantId,
            verifiedAt: now,
          })
          .returning({ observationId: observations.observationId });
        return row?.observationId ?? '';
      }),
    );

  /**
   * An issued prepaid proof bound to the given coverage revision (#1149 ledger row), written through
   * the real proof ledger so it carries the complete immutable proof the history read recovers.
   */
  const issuePrepaidProof = (paymentId: string, coverageRevision: number, amountMinor = 100_000) =>
    inTransaction((aggregate, _evidence, transaction) =>
      Effect.gen(function* insertProofRow() {
        const { operations, payment } = yield* aggregate.loadAggregate(paymentId);
        const collect = operations.find(isCollect);
        const issuedAt = yield* DateTime.now;
        const covered = { amountMinor, currency: 'CZK' as const };
        const proof = yield* paymentAuthorizationPersistenceForTransaction(transaction).insert({
          binding: {
            amount: covered,
            executionBinding: payment.executionBinding,
            method: payment.method,
            orderCommitmentAttemptId: `attempt-${randomUUID()}`,
            orderCommitmentTime: issuedAt,
            paymentId,
            paymentTermRef: payment.paymentTermRef,
            purchaseCorrelationId: payment.purchaseCorrelationId,
          },
          condition: {
            _tag: 'PREPAID_COLLECTION',
            collectOperationId: collect?.operationId ?? randomUUID(),
            covered,
          },
          coverageRevision,
          expiresAt: DateTime.add(issuedAt, { hours: 1 }),
          issuanceKey: `issuance-${randomUUID()}`,
          issuedAt,
          proofKind: 'PREPAID_COVERAGE',
          provenance: provenance(),
          termSemantic: termSemanticOf(payment.termSemanticEvidence),
        });
        return proof.authorizationId;
      }),
    );

  const openCase = (caseKind: PaymentReconciliationCaseKind, paymentId: string, operationId?: string) =>
    inTransaction((_aggregate, evidence) =>
      Effect.gen(function* openReconciliationCase() {
        const openedAt = yield* DateTime.now;
        const base = { caseKind, openedAt, paymentId, provenance: provenance() };
        const opened = yield* evidence.openCase(operationId === undefined ? base : { ...base, operationId });
        return opened.record.caseId;
      }),
    );

  /** The interpreter's input, loaded under the Payment row lock as the observation Action does. */
  const evidenceAggregate = (paymentId: string) =>
    inTransaction((aggregate, evidence) =>
      Effect.gen(function* loadEvidenceAggregate() {
        const current = yield* aggregate.loadAggregate(paymentId, { lock: true });
        const acceptedObservations = yield* evidence.listAcceptedObservations(paymentId);
        return { acceptedObservations, current, operations: current.operations };
      }),
    );

  const recover = (
    payload: typeof RequestPaymentOperationRecoveryPayloadSchema.Encoded,
    options: { readonly idempotencyKey?: string; readonly runtimes?: EvidenceRuntimes } = {},
  ) =>
    (options.runtimes ?? r1).actions.runAction({
      payload,
      principal,
      registration: requestPaymentOperationRecoveryAction,
      transport: { correlationId: 'payment-evidence-recovery', idempotencyKey: options.idempotencyKey ?? randomUUID() },
    });

  const decide = (
    payload: typeof RecordPaymentReconciliationDecisionPayloadSchema.Encoded,
    options: { readonly idempotencyKey?: string; readonly runtimes?: EvidenceRuntimes } = {},
  ) =>
    (options.runtimes ?? r1).actions.runAction({
      payload,
      principal,
      registration: recordPaymentReconciliationDecisionAction,
      transport: { correlationId: 'payment-evidence-decision', idempotencyKey: options.idempotencyKey ?? randomUUID() },
    });

  /** Configures one source authority through the registered Action. */
  const configureSource = (payload: typeof ConfigurePaymentSourceAuthorityPayloadSchema.Encoded) =>
    r1.actions.runAction({
      payload,
      principal,
      registration: configurePaymentSourceAuthorityAction,
      transport: { correlationId: 'payment-evidence-configure-source', idempotencyKey: randomUUID() },
    });

  /** Accepts one integration statement through the registered Action (qualification + interpretation). */
  const accept = (payload: typeof AcceptPaymentObservationPayloadSchema.Encoded) =>
    r1.actions.runAction({
      payload,
      principal,
      registration: acceptPaymentObservationAction,
      transport: { correlationId: 'payment-evidence-accept', idempotencyKey: randomUUID() },
    });

  /** The Current coverage of the governed `current-payment` Read, summarized. */
  const coverage = (paymentId: string) =>
    r1.reads
      .runRead({
        input: { paymentId },
        principal,
        registration: currentPaymentRead,
        transport: { correlationId: 'payment-evidence-current' },
      })
      .pipe(Effect.map(currentCoverageSummary));

  /** One configured REFUND_EXECUTION bank route for BANK_TRANSFER_ADVANCE refunds (#1150/#1152). */
  const configureRefundRoute = (sourceSystem: string, accountRef: string) =>
    inTransaction((_aggregate, _evidence, transaction) =>
      Effect.gen(function* insertRefundRouteRow() {
        const audit = provenance();
        const [row] = yield* transaction
          .insert(sourceAuthorities)
          .values({
            accountRef,
            actionInvocationId: audit.actionInvocationId,
            actorPrincipalId: audit.actorPrincipalId,
            compositionRevision: audit.compositionRevision,
            configuredAt: DateTime.toDateUtc(yield* DateTime.now),
            environment: 'production',
            factFamily: 'REFUND_EXECUTION',
            legalEntityId: scope.legalEntityId,
            method: 'BANK_TRANSFER_ADVANCE',
            reason: 'Configured bank refund route',
            refundRoute: true,
            revision: 1,
            sourceKind: 'BANK_ACCOUNTING',
            sourceSystem,
            status: 'ACTIVE',
            tenantId: scope.tenantId,
          })
          .returning();
        return row === undefined ? '' : yield* bindSubmitter(transaction, row);
      }),
    );

  const debt = (input: typeof PaymentReconciliationDebtRequestSchema.Encoded = {}) =>
    r1.reads.runRead({
      input,
      principal,
      registration: paymentReconciliationDebtRead,
      transport: { correlationId: 'payment-evidence-debt' },
    });

  const history = (paymentId: string) =>
    r1.reads.runRead({
      input: { paymentId },
      principal,
      registration: paymentHistoryRead,
      transport: { correlationId: 'payment-evidence-history' },
    });

  const admin = native.coreAdmin;
  const rows = {
    cases: (paymentId: string) =>
      admin
        .select()
        .from(reconciliationCases)
        .where(and(eq(reconciliationCases.tenantId, scope.tenantId), eq(reconciliationCases.paymentId, paymentId))),
    decisions: (caseId: string) =>
      admin.select().from(reconciliationDecisions).where(eq(reconciliationDecisions.caseId, caseId)),
    observation: (observationId: string) =>
      admin.select().from(observations).where(eq(observations.observationId, observationId)),
    operations: (paymentId: string) =>
      admin
        .select()
        .from(paymentOperations)
        .where(eq(paymentOperations.paymentId, paymentId))
        .orderBy(asc(paymentOperations.createdAt)),
    recoveries: (paymentId: string) =>
      admin
        .select()
        .from(recoveryRequests)
        .where(eq(recoveryRequests.paymentId, paymentId))
        .orderBy(asc(recoveryRequests.requestedAt)),
    transitions: (operationId: string) =>
      admin
        .select()
        .from(operationOutcomeTransitions)
        .where(eq(operationOutcomeTransitions.operationId, operationId))
        .orderBy(asc(operationOutcomeTransitions.outcomeRevision)),
  };
  const outbox = (topic: string) => outboxPayloads(native, scope.tenantId, topic);

  return {
    accept,
    configureAuthority,
    configureRefundRoute,
    configureSource,
    coverage,
    createPayment,
    debt,
    decide,
    evidenceAggregate,
    history,
    inTransaction,
    issuePrepaidProof,
    native,
    openCase,
    outbox,
    provenance,
    r1,
    r2,
    recordObservation,
    recover,
    rows,
    scope,
    settle,
    startOperation,
  };
};
export type EvidenceScenario = ReturnType<typeof evidenceScenarioOf>;
