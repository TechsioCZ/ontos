import type { PaymentTermDefinitionSnapshot } from '@app/payment-term-catalog-contracts/payment-term';
import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Deferred, Duration, Effect, Fiber, Option, Predicate, Result, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  accessScopeFences,
  accessScopes,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import {
  makeTenantModuleStateService,
  TENANT_MODULE_STATES,
} from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { TenantModuleState } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import type { TestAccessOutcome } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
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
import {
  PaymentAuthorizationCodDeliveryOfferSchema,
  PaymentAuthorizationDeferredNetDaysSchema,
  PaymentAuthorizationPickupCapabilitySchema,
  PaymentAuthorizationPrepaidCollectionSchema,
  PaymentAuthorizationZeroPayableSchema,
} from '../../shared/domain/authorization-proof.ts';
import type { PaymentAuthorizationBinding } from '../../shared/domain/authorization-proof.ts';
import type { PaymentExecutionBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentMethod, PaymentOperationOutcome } from '../../shared/domain/payment-vocabulary.ts';
import { issuePaymentAuthorizationAction } from '../../src/actions/issue-payment-authorization.action.ts';
import { paymentAuthorizationValidationRead } from '../../src/api/payment-authorization-validation.read.ts';
import { paymentHistoryRead } from '../../src/api/payment-history.read.ts';
import { paymentAuthorizations } from '../../src/database/schema.ts';
import { proofKindForMethod } from '../../src/domain/authorization-currentness.ts';
import type { PaymentRecord } from '../../src/persistence/payment-aggregate-persistence.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  AUTHORIZATION_COD_CARRIER,
  authorizationNetDaysSnapshot,
  authorizationTermRefFor,
  makeAuthorizationOwnerEvidenceFixture,
} from '../support/authorization-owner-evidence.fixture.ts';
import { configuredRefundExecutionRouteFor } from '../support/refund-execution-route.fixture.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import {
  collectInput,
  COMPOSITION_REVISION,
  inScope,
  makeTestScope,
  newPaymentInput,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  purchasingContextFor,
  randomUuid,
  withPersistence,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * #1149 Payment Authorization through the REAL registered Action/Read descriptors, the Core Action
 * and Read runtimes and native PostgreSQL (worktree database). Payments and their operation
 * outcomes are written with the foundation aggregate primitives (the same ones the owning Payment
 * Actions use); downstream owners appear only as the named public-contract fixtures of the ports.
 */

const R1 = '1'.repeat(64);
const isPrepaidCollection = Schema.is(PaymentAuthorizationPrepaidCollectionSchema);
const isZeroPayable = Schema.is(PaymentAuthorizationZeroPayableSchema);
const isCodDeliveryOffer = Schema.is(PaymentAuthorizationCodDeliveryOfferSchema);
const isPickupCapability = Schema.is(PaymentAuthorizationPickupCapabilitySchema);
const isDeferredNetDays = Schema.is(PaymentAuthorizationDeferredNetDaysSchema);
const R2 = '2'.repeat(64);

const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };
const contextAccess: ContextAccessService = {
  legalEntities: ({ legalEntityIds }) =>
    Effect.succeed(legalEntityIds.map((key) => ({ decision: 'allowed' as const, key }))),
  modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
  ownerPermissions: ({ targets }) =>
    Effect.succeed(targets.map((target) => ({ decision: 'allowed' as const, key: target.target.key }))),
  resources: ({ resources }) =>
    Effect.succeed(
      resources.map(({ moduleId, resourceId, resourceType }) => ({
        decision: 'allowed' as const,
        key: `${moduleId}:${resourceType}:${resourceId}`,
      })),
    ),
  tenants: ({ tenantIds }) => Effect.succeed(tenantIds.map((key) => ({ decision: 'allowed' as const, key }))),
};

type ModuleStateSetup = TenantModuleState | 'MISSING' | 'OPEN';

interface HarnessOptions {
  readonly access?: TestAccessOutcome;
  readonly moduleState?: ModuleStateSetup;
}

/** Seeds the Core identity rows a protected, Legal-Entity-scoped Action needs for one random scope. */
const seedCore = Effect.fn('AuthorizationNativeTests.seedCore')(function* seedCore(
  admin: PaymentTestDatabase,
  scope: PaymentTestScope,
  moduleState: ModuleStateSetup,
) {
  const [tenantScopeId, legalEntityScopeId, authBindingId] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
    concurrency: 1,
  });
  yield* admin.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Payment Authorization native tests',
    slug: `payment-authorization-${scope.tenantId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* admin.insert(legalEntities).values({
    legalEntityId: scope.legalEntityId,
    legalName: 'Payment Authorization legal entity',
    registrationCountry: 'CZ',
    registrationNumber: `PAY-${scope.legalEntityId}`,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* admin.insert(accessScopes).values([
    { scopeId: tenantScopeId, tenantContextId: scope.tenantId, tenantId: scope.tenantId },
    { legalEntityId: scope.legalEntityId, scopeId: legalEntityScopeId, tenantId: scope.tenantId },
  ]);
  yield* admin.insert(accessScopeFences).values(
    [tenantScopeId, legalEntityScopeId].map((scopeId) => ({
      revision: 1,
      scopeId,
      state: 'Ready' as const,
      tenantId: scope.tenantId,
    })),
  );
  yield* admin.insert(principals).values({
    displayName: 'Payment Authorization operator',
    kind: 'human',
    principalId: scope.principalId,
    status: 'active',
    tenantId: scope.tenantId,
  });
  yield* admin.insert(principalAuthBindings).values({
    authenticationNamespaceId: 'test.payment-authorization.v1',
    principalAuthBindingId: authBindingId,
    principalId: scope.principalId,
    provider: 'better_auth',
    providerSubjectId: `payment-authorization-${scope.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: scope.tenantId,
  });
  if (moduleState !== 'MISSING' && moduleState !== 'OPEN') {
    yield* admin
      .insert(tenantModuleStates)
      .values({ moduleKey: 'payment.core', state: moduleState, tenantId: scope.tenantId });
  }
  return {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId: 'test.payment-authorization.v1',
    authMethod: 'session' as const,
    legalEntityId: scope.legalEntityId,
    principalId: scope.principalId,
    tenantId: scope.tenantId,
  };
});

/** One native harness: random scope, Core rows, owner fixtures and the real Core runtimes. */
const makeHarness = Effect.fn('AuthorizationNativeTests.makeHarness')(function* makeHarness(
  options: HarnessOptions = {},
) {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, paymentTestRelations);
  const database = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  const scope = yield* makeTestScope;
  const moduleState = options.moduleState ?? 'OPEN';
  const principal = yield* seedCore(admin, scope, moduleState);
  const evidence = yield* makeAuthorizationOwnerEvidenceFixture;
  const gate = makeModuleStateGate(makeTenantModuleStateService({ executor: admin }));
  const gateway = moduleState === 'OPEN' ? openModuleEntrypointGateway : makeModuleEntrypointGateway(gate);
  const crypto = yield* Crypto.Crypto;
  const accessDecision = makeScriptedBoundAccessGate(options.access ?? 'allowed').bound;
  const actionRuntimeAt = (compositionRevision: string) =>
    makeActionRuntime(
      { executor: database },
      makeActionRepository(crypto),
      allowedPermission,
      testOperationalScopeResolver,
      {
        ...openActionRuntimeOptions,
        accessDecision,
        contextAccess,
        moduleEntrypointGateway: gateway,
        moduleStateGate: moduleState === 'OPEN' ? openActionRuntimeOptions.moduleStateGate : gate,
        ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
        ownerRegistration: paymentRegistration,
        resolveCompositionRevision: () => Effect.succeed(compositionRevision),
      },
    );
  const readRuntime = makeReadRuntime({ executor: database }, gateway, testOperationalScopeResolver, contextAccess, {
    accessDecision,
    ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
    ownerRegistration: paymentRegistration,
  });
  const atR1 = actionRuntimeAt(R1);
  const atR2 = actionRuntimeAt(R2);

  const issue = (payload: IssuePaymentAuthorizationPayload, compositionRevision: string = R1) =>
    Effect.all([randomUuid, Schema.encodeEffect(IssuePaymentAuthorizationPayloadSchema)(payload)], {
      concurrency: 1,
    }).pipe(
      Effect.flatMap(([key, encoded]) =>
        (compositionRevision === R2 ? atR2 : atR1).runAction({
          payload: encoded,
          principal,
          registration: issuePaymentAuthorizationAction,
          transport: { correlationId: `issue-${key}`, idempotencyKey: `issue-${key}` },
        }),
      ),
      Effect.provide(evidence.layer),
    );

  const validate = (input: PaymentAuthorizationValidationRequest) =>
    Schema.encodeEffect(PaymentAuthorizationValidationRequestSchema)(input).pipe(
      Effect.flatMap((encoded) =>
        readRuntime.runRead({
          input: encoded,
          principal,
          registration: paymentAuthorizationValidationRead,
          transport: { correlationId: 'payment-authorization-validation' },
        }),
      ),
      Effect.provide(evidence.layer),
    );

  const history = (paymentId: string) =>
    readRuntime.runRead({
      input: { paymentId },
      principal,
      registration: paymentHistoryRead,
      transport: { correlationId: 'payment-history' },
    });

  return { admin, adminClient, database, evidence, history, issue, runtimeClient, scope, validate };
});
type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

interface PaymentMeaningOverrides {
  readonly amountMinor?: number;
  /** The buyer of the trusted Purchasing Context the Payment is created for (`purchasingContextFor`). */
  readonly buyer?: string;
  readonly customerConfigurationId?: string;
  /** The merchant already enabled the method for this Customer Configuration in this test. */
  readonly enablementConfigured?: boolean;
  readonly executionBinding?: PaymentExecutionBinding;
  readonly method?: PaymentMethod;
  readonly termSnapshot?: PaymentTermDefinitionSnapshot;
}

/**
 * The real #1147 merchant enablement write (Current row + revision history) of one method for one
 * Customer Configuration; `expectedRevision` is absent only for its first configuration.
 */
const configureEnablement = (
  harness: Harness,
  input: {
    readonly customerConfigurationId: string;
    readonly enabled: boolean;
    readonly expectedRevision?: number;
    readonly method: PaymentMethod;
  },
) =>
  provenanceFor(harness.scope).pipe(
    Effect.flatMap((provenance) =>
      harness.database.transaction((transaction) =>
        installOperationalScope(transaction, operationalScopeOf(harness.scope)).pipe(
          Effect.flatMap((scoped) =>
            paymentApplicabilityPersistenceForTransaction(scoped).configureEnablement({
              customerConfigurationId: input.customerConfigurationId,
              enabled: input.enabled,
              expectedRevision: Option.fromNullishOr(input.expectedRevision),
              method: input.method,
              provenance,
              reason: input.enabled ? 'The merchant offers this method' : 'The merchant withdraws this method',
            }),
          ),
        ),
      ),
    ),
    Effect.map(({ record }) => record),
  );

/**
 * Inserts the Payment with the foundation primitive. A pre-collection method-condition Payment exists
 * only for a method the merchant enabled (#1147), so its enablement is configured first.
 */
const createPayment = Effect.fn('AuthorizationNativeTests.createPayment')(function* createPayment(
  harness: Harness,
  overrides: PaymentMeaningOverrides = {},
) {
  const base = yield* newPaymentInput(harness.scope, overrides.amountMinor ?? 100_000);
  const termSemanticEvidence = overrides.termSnapshot ?? base.termSemanticEvidence;
  const customerConfigurationId = overrides.customerConfigurationId ?? base.customerConfigurationId;
  const method = overrides.method ?? base.method;
  if (proofKindForMethod(method) === 'METHOD_CONDITION' && overrides.enablementConfigured !== true) {
    yield* configureEnablement(harness, { customerConfigurationId, enabled: true, method });
  }
  const created = yield* withPersistence(harness.database, harness.scope, (persistence) =>
    persistence.insertPayment({
      ...base,
      customerConfigurationId,
      executionBinding: overrides.executionBinding ?? base.executionBinding,
      method,
      paymentTermRef: termSemanticEvidence.paymentTermRef,
      purchasingContext:
        overrides.buyer === undefined ? base.purchasingContext : purchasingContextFor(harness.scope, overrides.buyer),
      termSemanticEvidence,
    }),
  );
  return created.record;
});

/** The CCC buyer subject whose entitlement the term owner fixture keys its periods by. */
const buyerOf = (harness: Harness, buyer: string) => purchasingContextFor(harness.scope, buyer).subject;

/** Stands in for #1151's qualified collection evidence: the COLLECT reaches EFFECT_CONFIRMED. */
const confirmCollect = Effect.fn('AuthorizationNativeTests.confirmCollect')(function* confirmCollect(
  harness: Harness,
  payment: PaymentRecord,
) {
  const key = yield* randomUuid;
  const input = yield* collectInput(
    harness.scope,
    { amountMinor: payment.amount.amountMinor, paymentId: payment.paymentId },
    `collect-${key}`,
  );
  const provenance = yield* provenanceFor(harness.scope);
  return yield* withPersistence(harness.database, harness.scope, (persistence) =>
    persistence.insertOperation({ ...input, binding: payment.executionBinding }).pipe(
      Effect.flatMap(({ record }) =>
        persistence.transitionOperationOutcome({
          causedBy: { kind: 'OBSERVATION' },
          expectedOutcomeRevision: record.outcomeRevision,
          operationId: record.operationId,
          paymentId: payment.paymentId,
          provenance,
          to: 'EFFECT_CONFIRMED',
        }),
      ),
      Effect.map(({ record }) => record),
    ),
  );
});

/** Stands in for #1150's refund start: a full-amount REFUND reservation on the proven collection. */
const startRefund = Effect.fn('AuthorizationNativeTests.startRefund')(function* startRefund(
  harness: Harness,
  payment: PaymentRecord,
  collectOperationId: string,
  initialOutcome: 'PENDING' | 'INDETERMINATE' = 'PENDING',
) {
  const [provenance, key, refundExecutionRoute] = yield* Effect.all(
    [
      provenanceFor(harness.scope),
      randomUuid,
      configuredRefundExecutionRouteFor(harness.database, harness.scope, payment.executionBinding),
    ],
    { concurrency: 1 },
  );
  const amount = { amountMinor: payment.amount.amountMinor, currency: 'CZK' as const };
  const created = yield* withPersistence(harness.database, harness.scope, (persistence) =>
    persistence.insertOperation({
      amount,
      binding: payment.executionBinding,
      initialOutcome,
      kind: 'REFUND',
      materialRequest: { amountMinor: amount.amountMinor, item: 'item-1', kind: 'REFUND' },
      operationKey: `refund-${key}`,
      paymentId: payment.paymentId,
      provenance,
      refundBasis: {
        _tag: 'REFUNDABLE_ITEMS',
        items: [{ ...amount, itemRef: 'item-1', sourceEvidenceRef: 'order-item-evidence-1' }],
      },
      refundExecutionRoute,
      targetOperationId: collectOperationId,
    }),
  );
  return created.record;
});

const settleOperation = Effect.fn('AuthorizationNativeTests.settleOperation')(function* settleOperation(
  harness: Harness,
  paymentId: string,
  operation: { readonly operationId: string; readonly outcomeRevision: number },
  to: PaymentOperationOutcome,
) {
  const provenance = yield* provenanceFor(harness.scope);
  return yield* withPersistence(harness.database, harness.scope, (persistence) =>
    persistence.transitionOperationOutcome({
      causedBy: { kind: 'OBSERVATION' },
      expectedOutcomeRevision: operation.outcomeRevision,
      operationId: operation.operationId,
      paymentId,
      provenance,
      to,
    }),
  );
});

const bindingFor = (
  payment: PaymentRecord,
  orderCommitmentAttemptId: string,
  orderCommitmentTime: DateTime.Utc,
): PaymentAuthorizationBinding => ({
  amount: payment.amount,
  executionBinding: payment.executionBinding,
  method: payment.method,
  orderCommitmentAttemptId,
  orderCommitmentTime,
  paymentId: payment.paymentId,
  paymentTermRef: payment.paymentTermRef,
  purchaseCorrelationId: payment.purchaseCorrelationId,
});

const issuePayload = (
  binding: PaymentAuthorizationBinding,
  issuanceKey: string,
  validitySeconds = 300,
): IssuePaymentAuthorizationPayload => ({ binding, issuanceKey, validitySeconds });

/** The actual PostgreSQL clock (`clock_timestamp()`), read outside any proof decision. */
const databaseNow = (adminClient: PgClient.PgClient) =>
  adminClient
    .unsafe<{ readonly now: Date }>('select clock_timestamp() as now')
    .pipe(Effect.map(([row]) => DateTime.fromDateUnsafe(row?.now ?? new Date(0))));

/** A whole-second frozen business T `seconds` before the actual database time. */
const frozenT = (harness: Harness, seconds: number) =>
  harness.adminClient
    .unsafe<{ readonly t: Date }>("select date_trunc('second', clock_timestamp() - make_interval(secs => $1)) as t", [
      seconds,
    ])
    .pipe(Effect.map(([row]) => DateTime.fromDateUnsafe(row?.t ?? new Date(0))));

/**
 * Holds the Payment row lock in a separate runtime-role transaction. After `proceed` completes it
 * keeps holding the lock inside PostgreSQL (`pg_sleep`) until `holdUntil`, then commits.
 */
const holdPaymentRowLock = (
  harness: Harness,
  paymentId: string,
  locked: Deferred.Deferred<number>,
  proceed: Deferred.Deferred<boolean>,
  holdUntil?: DateTime.Utc,
) =>
  inScope(
    harness.runtimeClient,
    harness.scope,
    Effect.gen(function* holdLock() {
      const [row] = yield* harness.runtimeClient.unsafe<{ readonly pid: number }>(
        'select pg_backend_pid() as pid from payment.payments where payment_id = $1 for update',
        [paymentId],
      );
      yield* Deferred.succeed(locked, row?.pid ?? 0);
      yield* Deferred.await(proceed);
      if (holdUntil !== undefined) {
        yield* harness.runtimeClient.unsafe(
          'select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))))',
          [DateTime.formatIso(holdUntil)],
        );
      }
    }),
  );

/** Polls until PostgreSQL itself reports `expected` backends queued (directly or transitively) behind `holder`. */
const awaitWaitersBehind = (adminClient: PgClient.PgClient, holder: number, expected: number) => {
  const waiting = adminClient
    .unsafe<{ readonly waiting: number }>(
      `with recursive blocked(pid) as (
         select pid from pg_catalog.pg_stat_activity where $1 = any(pg_catalog.pg_blocking_pids(pid))
         union
         select activity.pid from pg_catalog.pg_stat_activity activity
           join blocked on blocked.pid = any(pg_catalog.pg_blocking_pids(activity.pid))
       ) select count(*)::integer as waiting from blocked`,
      [holder],
    )
    .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
  const poll = (remaining: number): Effect.Effect<number, Effect.Error<typeof waiting>> =>
    waiting.pipe(
      Effect.flatMap((count) =>
        count >= expected || remaining === 0 ? Effect.succeed(count) : Effect.suspend(() => poll(remaining - 1)),
      ),
    );
  return poll(5000);
};

const outboxCount = (harness: Harness) =>
  harness.admin
    .select({ id: outboxMessages.outboxMessageId })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.tenantId, harness.scope.tenantId),
        eq(outboxMessages.topic, 'payment.core.authorization-issued.v1'),
      ),
    )
    .pipe(Effect.map((rows) => rows.length));

const operationCount = (harness: Harness, paymentId: string) =>
  withPersistence(harness.database, harness.scope, (persistence) => persistence.loadAggregate(paymentId)).pipe(
    Effect.map((aggregate) => aggregate.operations.length),
  );

const storedProof = (harness: Harness, authorizationId: string) =>
  harness.admin
    .select()
    .from(paymentAuthorizations)
    .where(eq(paymentAuthorizations.authorizationId, authorizationId))
    .pipe(Effect.map(([row]) => row));

const codeOf = <Failure>(failure: Failure): string =>
  Predicate.hasProperty(failure, 'code') && Predicate.isString(failure.code) ? failure.code : 'unknown';

const failureCode = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
  Effect.result(operation).pipe(
    Effect.map((result) => (Result.isFailure(result) ? codeOf(result.failure) : 'succeeded')),
  );

/** Native PostgreSQL runs use the live runner Clock: proof times and lock waits are real. */
const nativeRun = <A, E>(body: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(body).pipe(Effect.provide(NodeCrypto.layer));

// ---------------------------------------------------------------------------------------------
// Prepaid coverage
// ---------------------------------------------------------------------------------------------

it.live('#1149 Online payment returned to success page without financial proof issues no prepaid proof', () =>
  nativeRun(
    Effect.gen(function* onlineSuccessPage() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      const binding = bindingFor(payment, 'attempt-1', yield* frozenT(harness, 1));
      // The browser returned to the success URL; nothing is authoritatively proven yet.
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'before-collect')))).toBe(
        'payment_authorization_coverage_insufficient',
      );
      // A provider request ACK / a live PENDING collection is still not collection.
      const collect = yield* collectInput(
        harness.scope,
        { amountMinor: payment.amount.amountMinor, paymentId: payment.paymentId },
        'collect-pending',
      );
      yield* withPersistence(harness.database, harness.scope, (persistence) => persistence.insertOperation(collect));
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'while-pending')))).toBe(
        'payment_authorization_coverage_insufficient',
      );
      expect(yield* outboxCount(harness)).toBe(0);
    }),
  ),
);

it.live('#1149 bank receipt versus QR: the QR instruction never yields a proof, the bank receipt does', () =>
  nativeRun(
    Effect.gen(function* bankReceiptVersusQr() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness, {
        executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        method: 'BANK_TRANSFER_ADVANCE',
      });
      const binding = bindingFor(payment, 'attempt-bank', yield* frozenT(harness, 1));
      // Showing the QR payment instruction creates no Payment fact at all.
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'qr-shown')))).toBe(
        'payment_authorization_coverage_insufficient',
      );
      const collected = yield* confirmCollect(harness, payment);
      const issued = yield* harness.issue(issuePayload(binding, 'bank-received'));
      expect(issued.issuance).toBe('ISSUED');
      expect(issued.proof.proofKind).toBe('PREPAID_COVERAGE');
      expect(isPrepaidCollection(issued.proof.condition)).toBe(true);
      expect(issued.proof.condition).toMatchObject({
        collectOperationId: collected.operationId,
        covered: payment.amount,
      });
      // The confirmed collection bumped the coverage revision; the proof binds the Current one.
      expect(issued.proof.coverageRevision).toBe(2);
      const validation = yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding });
      expect(validation).toMatchObject({ currentCoverageRevision: 2, outcome: 'VALID', reasons: [] });
      expect(yield* outboxCount(harness)).toBe(1);
    }),
  ),
);

it.live('#1149 one collection never backs Current prepaid proofs for two different Order Commitment Attempts', () =>
  nativeRun(
    Effect.gen(function* twoAttemptsOneCollection() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const T = yield* frozenT(harness, 1);
      const bindingA = bindingFor(payment, 'attempt-A', T);
      const bindingB = bindingFor(payment, 'attempt-B', T);
      const proofA = yield* harness.issue(issuePayload(bindingA, 'key-A'));
      // Attempt A holds the Current coverage: the same funds cannot also commit Attempt B.
      expect(yield* failureCode(harness.issue(issuePayload(bindingB, 'key-B')))).toBe(
        'payment_authorization_issuance_conflict',
      );
      // The same Attempt may still be served again under the same coverage.
      expect((yield* harness.issue(issuePayload(bindingA, 'key-A2'))).issuance).toBe('ISSUED');
      const validA = yield* harness.validate({ authorizationId: proofA.proof.authorizationId, binding: bindingA });
      expect(validA.outcome).toBe('VALID');
      expect(yield* outboxCount(harness)).toBe(2);
    }),
  ),
);

it.live('#1149 a different Attempt may be authorized only after every proof of the previous Attempt expired', () =>
  nativeRun(
    Effect.gen(function* afterPreviousAttemptExpired() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const T = yield* frozenT(harness, 1);
      const bindingA = bindingFor(payment, 'attempt-A', T);
      const bindingB = bindingFor(payment, 'attempt-B', T);
      const proofA = yield* harness.issue(issuePayload(bindingA, 'key-A', 1));
      expect(yield* failureCode(harness.issue(issuePayload(bindingB, 'key-B')))).toBe(
        'payment_authorization_issuance_conflict',
      );
      // Wait inside PostgreSQL until the actual time is past A's expiry.
      yield* harness.adminClient.unsafe(
        'select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))))',
        [DateTime.formatIso(DateTime.addDuration(proofA.proof.expiresAt, Duration.millis(100)))],
      );
      expect(
        (yield* harness.validate({ authorizationId: proofA.proof.authorizationId, binding: bindingA })).reasons,
      ).toEqual(['EXPIRED']);
      const proofB = yield* harness.issue(issuePayload(bindingB, 'key-B'));
      const validations = yield* Effect.all(
        [
          harness.validate({ authorizationId: proofA.proof.authorizationId, binding: bindingA }),
          harness.validate({ authorizationId: proofB.proof.authorizationId, binding: bindingB }),
        ],
        { concurrency: 1 },
      );
      expect(validations.map(({ outcome }) => outcome)).toEqual(['NOT_VALID', 'VALID']);
    }),
  ),
);

it.live('#1149 zero payable purchase issues an explicit ZERO_PAYABLE proof without any collection', () =>
  nativeRun(
    Effect.gen(function* zeroPayable() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness, { amountMinor: 0 });
      const binding = bindingFor(payment, 'attempt-zero', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'zero'));
      expect(isZeroPayable(issued.proof.condition)).toBe(true);
      expect(issued.proof.condition).toMatchObject({ required: { amountMinor: 0, currency: 'CZK' } });
      expect(yield* operationCount(harness, payment.paymentId)).toBe(0);
      expect((yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding })).outcome).toBe(
        'VALID',
      );
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Method conditions
// ---------------------------------------------------------------------------------------------

it.live('#1149 COD commitment before handover issues a method-condition proof and records no collection', () =>
  nativeRun(
    Effect.gen(function* codBeforeHandover() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness, {
        executionBinding: {
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: 'offer-evidence-1',
          carrier: AUTHORIZATION_COD_CARRIER,
          deliveryOfferRef: 'offer-1',
        },
        method: 'CASH_ON_DELIVERY',
      });
      yield* harness.evidence.setCod('offer-1', 'SUPPORTED');
      const binding = bindingFor(payment, 'attempt-cod', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'cod'));
      expect(issued.proof.proofKind).toBe('METHOD_CONDITION');
      expect(isCodDeliveryOffer(issued.proof.condition)).toBe(true);
      expect(issued.proof.condition).toMatchObject({
        capabilityEvidenceRef: 'cod-capability:offer-1',
        deliveryOfferRef: 'offer-1',
      });
      expect(issued.proof.coverageRevision).toBeUndefined();
      expect(yield* operationCount(harness, payment.paymentId)).toBe(0);
      const { authorizationId } = issued.proof;
      expect((yield* harness.validate({ authorizationId, binding })).outcome).toBe('VALID');
      // The offer stops being COD-capable: the same proof fails Current validation.
      yield* harness.evidence.setCod('offer-1', 'OFFER_NOT_COD_CAPABLE');
      expect(yield* harness.validate({ authorizationId, binding })).toMatchObject({
        outcome: 'NOT_VALID',
        reasons: ['METHOD_CONDITION_NOT_MET'],
      });
      // A Delivery owner outage is never valid and never absence.
      yield* harness.evidence.setCod('offer-1', 'UNAVAILABLE');
      expect((yield* harness.validate({ authorizationId, binding })).outcome).toBe('UNAVAILABLE_TO_VERIFY');
    }),
  ),
);

it.live(
  '#1149 Carrier later proves COD collection: collection is recorded separately, the proof is not converted',
  () =>
    nativeRun(
      Effect.gen(function* carrierProvesCollection() {
        const harness = yield* makeHarness();
        const payment = yield* createPayment(harness, {
          executionBinding: {
            _tag: 'COD_DELIVERY_OFFER',
            capabilityEvidenceRef: 'offer-evidence-2',
            carrier: AUTHORIZATION_COD_CARRIER,
            deliveryOfferRef: 'offer-2',
          },
          method: 'CASH_ON_DELIVERY',
        });
        yield* harness.evidence.setCod('offer-2', 'SUPPORTED');
        const binding = bindingFor(payment, 'attempt-cod-2', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'cod-2'));
        // Qualified carrier customer-collection evidence (accepted through #1151) confirms the COLLECT.
        const collected = yield* confirmCollect(harness, payment);
        expect(collected.outcome).toBe('EFFECT_CONFIRMED');
        const stored = yield* storedProof(harness, issued.proof.authorizationId);
        expect(stored?.proofKind).toBe('METHOD_CONDITION');
        expect(stored?.coverageRevision).toBeNull();
        expect(yield* harness.issue(issuePayload(binding, 'cod-2'))).toEqual({
          issuance: 'REPLAYED',
          proof: issued.proof,
        });
      }),
    ),
);

it.live('#1149 pickup capability denial refuses the proof; an owner outage is unavailable, never absence', () =>
  nativeRun(
    Effect.gen(function* pickupDenial() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness, {
        executionBinding: {
          _tag: 'PICKUP_CAPABILITY',
          capabilityEvidenceRef: 'store-evidence',
          pickupCapabilityRef: 'store-1',
        },
        method: 'PAY_ON_PICKUP_OR_ON_SITE',
      });
      const binding = bindingFor(payment, 'attempt-pickup', yield* frozenT(harness, 1));
      yield* harness.evidence.setPickup('store-1', 'COLLECTION_NOT_SUPPORTED');
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'pickup-denied')))).toBe(
        'payment_authorization_method_condition_not_met',
      );
      yield* harness.evidence.setPickup('store-1', 'UNAVAILABLE');
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'pickup-outage')))).toBe(
        'payment_owner_evidence_unavailable',
      );
      yield* harness.evidence.setPickup('store-1', 'SUPPORTED');
      const issued = yield* harness.issue(issuePayload(binding, 'pickup-ok'));
      expect(isPickupCapability(issued.proof.condition)).toBe(true);
      expect(issued.proof.condition).toMatchObject({ pickupCapabilityRef: 'store-1' });
      expect(yield* operationCount(harness, payment.paymentId)).toBe(0);
    }),
  ),
);

it.live('#1149 a deferred proof that expires while the term owner answers is not acknowledged as VALID', () =>
  nativeRun(
    Effect.gen(function* deferredExpiresDuringOwnerCheck() {
      const harness = yield* makeHarness();
      const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
      const snapshot = authorizationNetDaysSnapshot(termRef, 14);
      const payment = yield* createPayment(harness, {
        buyer: 'buyer-a',
        customerConfigurationId: 'ccc-a',
        executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        method: 'DEFERRED_INVOICE',
        termSnapshot: snapshot,
      });
      yield* harness.evidence.putEntitlementPeriod({
        buyer: buyerOf(harness, 'buyer-a'),
        entitlementEvidenceRef: 'entitlement-a',
        semanticSnapshot: snapshot,
        status: 'CURRENT',
      });
      const binding = bindingFor(payment, 'attempt-slow-owner', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'slow-owner', 1));
      const { authorizationId, expiresAt } = issued.proof;
      // The owner answers only after the one-second proof has expired.
      yield* harness.evidence.setTermEvidenceDelay(Duration.millis(1300));
      const validation = yield* harness.validate({ authorizationId, binding });
      expect(validation).toMatchObject({ outcome: 'NOT_VALID', reasons: ['EXPIRED'] });
      expect(DateTime.isGreaterThanOrEqualTo(validation.validatedAt, expiresAt)).toBe(true);
    }),
  ),
);

it.live('#1149 Deferred term is supported without a concrete invoice', () =>
  nativeRun(
    Effect.gen(function* deferredWithoutInvoice() {
      const harness = yield* makeHarness();
      const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
      const snapshot = authorizationNetDaysSnapshot(termRef, 14);
      const payment = yield* createPayment(harness, {
        buyer: 'buyer-a',
        customerConfigurationId: 'ccc-a',
        executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        method: 'DEFERRED_INVOICE',
        termSnapshot: snapshot,
      });
      yield* harness.evidence.putEntitlementPeriod({
        buyer: buyerOf(harness, 'buyer-a'),
        entitlementEvidenceRef: 'entitlement-a',
        semanticSnapshot: snapshot,
        status: 'CURRENT',
      });
      const binding = bindingFor(payment, 'attempt-deferred', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'deferred'));
      expect(isDeferredNetDays(issued.proof.condition)).toBe(true);
      expect(issued.proof.condition).toMatchObject({ entitlementEvidenceRef: 'entitlement-a', netDays: 14 });
      expect(issued.proof.termSemantic).toEqual({
        semanticFingerprint: snapshot.semanticFingerprint,
        semanticRevisionId: snapshot.semanticRevisionId,
      });
      // No pre-collection, and no invoice issue DATE or concrete due DATE is fabricated.
      expect(yield* operationCount(harness, payment.paymentId)).toBe(0);
      expect(new Set(Object.keys(issued.proof))).toEqual(
        new Set([
          'authorizationId',
          'binding',
          'condition',
          'expiresAt',
          'issuanceKey',
          'issuedAt',
          'proofKind',
          'provenance',
          'termSemantic',
        ]),
      );
      expect((yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding })).outcome).toBe(
        'VALID',
      );
    }),
  ),
);

it.live(
  '#1149 Deferred B2B invoice: once DEFERRED_INVOICE is withdrawn it no longer remains applicable for issuance or validation',
  () =>
    nativeRun(
      Effect.gen(function* deferredWithdrawn() {
        const harness = yield* makeHarness();
        const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
        const snapshot = authorizationNetDaysSnapshot(termRef, 14);
        const payment = yield* createPayment(harness, {
          buyer: 'buyer-withdrawn',
          customerConfigurationId: 'ccc-withdrawn',
          executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
          method: 'DEFERRED_INVOICE',
          termSnapshot: snapshot,
        });
        yield* harness.evidence.putEntitlementPeriod({
          buyer: buyerOf(harness, 'buyer-withdrawn'),
          entitlementEvidenceRef: 'entitlement-withdrawn',
          semanticSnapshot: snapshot,
          status: 'CURRENT',
        });
        const binding = bindingFor(payment, 'attempt-withdrawn', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'before-withdrawal'));
        expect(issued.issuance).toBe('ISSUED');
        const validate = harness.validate({ authorizationId: issued.proof.authorizationId, binding });
        expect((yield* validate).outcome).toBe('VALID');
        // The merchant withdraws DEFERRED_INVOICE for this Customer Configuration (revision 2).
        const withdrawn = yield* configureEnablement(harness, {
          customerConfigurationId: 'ccc-withdrawn',
          enabled: false,
          expectedRevision: 1,
          method: 'DEFERRED_INVOICE',
        });
        expect(withdrawn).toMatchObject({ enabled: false, revision: 2 });
        // The CCC entitlement is still Current, but the method itself is no longer applicable.
        expect(yield* failureCode(harness.issue(issuePayload(binding, 'after-withdrawal')))).toBe(
          'payment_authorization_method_condition_not_met',
        );
        expect(yield* validate).toMatchObject({ outcome: 'NOT_VALID', reasons: ['METHOD_CONDITION_NOT_MET'] });
        expect(yield* outboxCount(harness)).toBe(1);
      }),
    ),
);

it.live('#1149 COD method withdrawn by the merchant: the COD proof is no longer Current and none is issued', () =>
  nativeRun(
    Effect.gen(function* codWithdrawn() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness, {
        executionBinding: {
          _tag: 'COD_DELIVERY_OFFER',
          capabilityEvidenceRef: 'offer-evidence-withdrawn',
          carrier: AUTHORIZATION_COD_CARRIER,
          deliveryOfferRef: 'offer-withdrawn',
        },
        method: 'CASH_ON_DELIVERY',
      });
      yield* harness.evidence.setCod('offer-withdrawn', 'SUPPORTED');
      const binding = bindingFor(payment, 'attempt-cod-withdrawn', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'cod-before-withdrawal'));
      yield* configureEnablement(harness, {
        customerConfigurationId: payment.customerConfigurationId,
        enabled: false,
        expectedRevision: 1,
        method: 'CASH_ON_DELIVERY',
      });
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'cod-after-withdrawal')))).toBe(
        'payment_authorization_method_condition_not_met',
      );
      expect(yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding })).toMatchObject({
        outcome: 'NOT_VALID',
        reasons: ['METHOD_CONDITION_NOT_MET'],
      });
    }),
  ),
);

it.live(
  "#1149 two buyers under one merchant configuration: only the exact buyer's Current entitlement authorizes its Payment",
  () =>
    nativeRun(
      Effect.gen(function* entitlementPeriods() {
        const harness = yield* makeHarness();
        const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
        const snapshot = authorizationNetDaysSnapshot(termRef, 30);
        // Two buyers purchase under the SAME merchant Customer Configuration: the merchant configuration
        // never identifies the buyer, so only each Payment's stored Purchasing Context scopes its entitlement.
        const deferred = (buyer: string, enablementConfigured: boolean) =>
          createPayment(harness, {
            buyer,
            customerConfigurationId: 'ccc-shared',
            enablementConfigured,
            executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
            method: 'DEFERRED_INVOICE',
            termSnapshot: snapshot,
          });
        const paymentA = yield* deferred('buyer-a', false);
        const paymentB = yield* deferred('buyer-b', true);
        const periodA = {
          buyer: buyerOf(harness, 'buyer-a'),
          entitlementEvidenceRef: 'period-a',
          semanticSnapshot: snapshot,
        };
        const periodB = {
          buyer: buyerOf(harness, 'buyer-b'),
          entitlementEvidenceRef: 'period-b',
          semanticSnapshot: snapshot,
        };
        yield* harness.evidence.putEntitlementPeriod({ ...periodA, status: 'CURRENT' });
        // B's future entitlement was cancelled: the term definition exists, but that is not entitlement.
        yield* harness.evidence.putEntitlementPeriod({ ...periodB, status: 'CANCELLED' });
        const T = yield* frozenT(harness, 1);
        const bindingA = bindingFor(paymentA, 'attempt-a', T);
        expect(yield* failureCode(harness.issue(issuePayload(bindingFor(paymentB, 'attempt-b', T), 'b')))).toBe(
          'payment_authorization_method_condition_not_met',
        );
        const issuedA = yield* harness.issue(issuePayload(bindingA, 'a'));
        const validateA = harness.validate({ authorizationId: issuedA.proof.authorizationId, binding: bindingA });
        // Cancelling unrelated B does not invalidate the still-authorized entitlement A of the same term.
        yield* harness.evidence.putEntitlementPeriod({ ...periodB, status: 'CANCELLED' });
        expect((yield* validateA).outcome).toBe('VALID');
        // A replacement entitlement never silently renews a proof bound to the original one.
        yield* harness.evidence.putEntitlementPeriod({
          ...periodA,
          entitlementEvidenceRef: 'period-a2',
          status: 'CURRENT',
        });
        expect(yield* validateA).toMatchObject({ outcome: 'NOT_VALID', reasons: ['METHOD_CONDITION_NOT_MET'] });
        yield* harness.evidence.putEntitlementPeriod({ ...periodA, status: 'CANCELLED' });
        expect(yield* validateA).toMatchObject({ outcome: 'NOT_VALID', reasons: ['METHOD_CONDITION_NOT_MET'] });
        yield* harness.evidence.setTermEvidenceUnavailable(true);
        expect((yield* validateA).outcome).toBe('UNAVAILABLE_TO_VERIFY');
      }),
    ),
);

it.live('#1149 term semantic change produces a new Ref; neither the old Payment nor its proof is re-qualified', () =>
  nativeRun(
    Effect.gen(function* termSemanticChange() {
      const harness = yield* makeHarness();
      const oldRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
      const newRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
      const oldSnapshot = authorizationNetDaysSnapshot(oldRef, 14);
      const payment = yield* createPayment(harness, {
        buyer: 'buyer-term',
        customerConfigurationId: 'ccc-term',
        executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
        method: 'DEFERRED_INVOICE',
        termSnapshot: oldSnapshot,
      });
      const period = {
        buyer: buyerOf(harness, 'buyer-term'),
        entitlementEvidenceRef: 'period-term',
        status: 'CURRENT' as const,
      };
      yield* harness.evidence.putEntitlementPeriod({ ...period, semanticSnapshot: oldSnapshot });
      const binding = bindingFor(payment, 'attempt-term', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'term-old'));
      // The Attempt now carries the new Ref of the changed meaning: it is not this Payment's purchase.
      expect(yield* failureCode(harness.issue(issuePayload({ ...binding, paymentTermRef: newRef }, 'term-new')))).toBe(
        'payment_authorization_binding_mismatch',
      );
      // The owner reports a different meaning under the old Ref: the retained meaning no longer holds.
      yield* harness.evidence.putEntitlementPeriod({
        ...period,
        semanticSnapshot: authorizationNetDaysSnapshot(oldRef, 30, 'c'.repeat(64)),
      });
      expect(yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding })).toMatchObject({
        outcome: 'NOT_VALID',
        reasons: ['METHOD_CONDITION_NOT_MET'],
      });
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'term-after-change')))).toBe(
        'payment_authorization_method_condition_not_met',
      );
    }),
  ),
);

it.live(
  '#1149 a USABLE owner answer carrying an already retired C15 snapshot neither issues nor keeps a deferred proof Current',
  () =>
    nativeRun(
      Effect.gen(function* retiredTermSnapshot() {
        const harness = yield* makeHarness();
        const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
        const active = authorizationNetDaysSnapshot(termRef, 14);
        const payment = yield* createPayment(harness, {
          buyer: 'buyer-retired',
          customerConfigurationId: 'ccc-retired',
          executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
          method: 'DEFERRED_INVOICE',
          termSnapshot: active,
        });
        const period = {
          buyer: buyerOf(harness, 'buyer-retired'),
          entitlementEvidenceRef: 'entitlement-retired',
          status: 'CURRENT' as const,
        };
        yield* harness.evidence.putEntitlementPeriod({ ...period, semanticSnapshot: active });
        const binding = bindingFor(payment, 'attempt-retired', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'before-retirement'));
        const validate = harness.validate({ authorizationId: issued.proof.authorizationId, binding });
        expect((yield* validate).outcome).toBe('VALID');
        // Same Ref, same semantic meaning, still "USABLE" with a Current entitlement, but the owner's own
        // snapshot says the term was retired in the past: contradictory evidence, never a Current condition.
        const retired: PaymentTermDefinitionSnapshot = {
          ...active,
          lifecycle: {
            effectiveFrom: active.lifecycle.effectiveFrom,
            effectiveTo: '2026-02-01T00:00:00.000Z',
            state: 'RETIRED',
          },
        };
        yield* harness.evidence.putEntitlementPeriod({ ...period, semanticSnapshot: retired });
        expect(yield* failureCode(harness.issue(issuePayload(binding, 'after-retirement')))).toBe(
          'payment_authorization_method_condition_not_met',
        );
        expect(yield* validate).toMatchObject({ outcome: 'NOT_VALID', reasons: ['METHOD_CONDITION_NOT_MET'] });
      }),
    ),
);

// ---------------------------------------------------------------------------------------------
// Exact Attempt / binding / scope
// ---------------------------------------------------------------------------------------------

it.live('#1149 exact foreign or mismatched Attempt or binding never produces or validates a proof', () =>
  nativeRun(
    Effect.gen(function* foreignOrMismatched() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const T = yield* frozenT(harness, 1);
      const binding = bindingFor(payment, 'attempt-exact', T);
      const otherAccount: PaymentExecutionBinding = {
        _tag: 'GATEWAY_ACCOUNT',
        environment: 'production',
        providerAccountRef: 'gopay-account-2',
        providerFamily: 'GOPAY',
      };
      const mismatched = [
        { ...binding, executionBinding: otherAccount },
        { ...binding, amount: { amountMinor: 99_999, currency: 'CZK' as const } },
        { ...binding, purchaseCorrelationId: 'other-purchase' },
        { ...binding, method: 'BANK_TRANSFER_ADVANCE' as const },
      ];
      for (const [index, candidate] of mismatched.entries()) {
        expect(yield* failureCode(harness.issue(issuePayload(candidate, `mismatch-${index}`)))).toBe(
          'payment_authorization_binding_mismatch',
        );
      }
      const issued = yield* harness.issue(issuePayload(binding, 'exact'));
      const { authorizationId } = issued.proof;
      expect(
        yield* harness.validate({
          authorizationId,
          binding: { ...binding, orderCommitmentAttemptId: 'attempt-other' },
        }),
      ).toMatchObject({ outcome: 'NOT_VALID', reasons: ['ATTEMPT_MISMATCH'] });
      expect(
        yield* harness.validate({ authorizationId, binding: { ...binding, executionBinding: otherAccount } }),
      ).toMatchObject({ outcome: 'NOT_VALID', reasons: ['BINDING_MISMATCH'] });
      expect(
        yield* harness.validate({
          authorizationId,
          binding: { ...binding, orderCommitmentTime: DateTime.subtractDuration(T, Duration.seconds(5)) },
        }),
      ).toMatchObject({ outcome: 'NOT_VALID', reasons: ['COMMITMENT_TIME_MISMATCH'] });
      // A foreign Tenant/Selling Legal Entity neither sees the proof nor reaches the Payment.
      const foreign = yield* makeHarness();
      const foreignValidation = yield* foreign.validate({ authorizationId, binding });
      expect(foreignValidation).toMatchObject({ outcome: 'NOT_VALID', reasons: ['PROOF_UNKNOWN'] });
      expect(foreignValidation.proof).toBeUndefined();
      expect(yield* failureCode(foreign.issue(issuePayload(binding, 'foreign')))).toBe('payment_not_found');
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Actual time versus frozen business T
// ---------------------------------------------------------------------------------------------

it.live('#1149 Actual valid use occurs after frozen business T', () =>
  nativeRun(
    Effect.gen(function* actualUseAfterT() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      // T lies two seconds before the actual issuance (T = 10:00:00, issuance at ~10:00:02).
      const T = yield* frozenT(harness, 2);
      const binding = bindingFor(payment, 'attempt-time', T);
      const issued = yield* harness.issue(issuePayload(binding, 'time'));
      // Issuance is recorded at the actual owner time (>= T + 2 s), never backdated to T.
      expect(DateTime.isGreaterThan(issued.proof.issuedAt, DateTime.addDuration(T, Duration.seconds(1)))).toBe(true);
      // Use at ~10:00:03: valid against the actual use time even though T precedes issuance.
      const validation = yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding });
      expect(validation.outcome).toBe('VALID');
      expect(DateTime.isGreaterThanOrEqualTo(validation.validatedAt, issued.proof.issuedAt)).toBe(true);
      // T is preserved exactly and separately from the actual times.
      expect(DateTime.Equivalence(issued.proof.binding.orderCommitmentTime, T)).toBe(true);
      const stored = yield* storedProof(harness, issued.proof.authorizationId);
      expect(stored?.issuedAt.getTime()).toBe(DateTime.toEpochMillis(issued.proof.issuedAt));
      expect(stored?.methodConditionEvidence).toMatchObject({ orderCommitmentTime: DateTime.formatIso(T) });
    }),
  ),
);

it.live('#1149 Proof expires while execution waits; replay and a refreshed Composition do not extend it', () =>
  nativeRun(
    Effect.gen(function* expiresWhileWaiting() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-expiry', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'expiring', 1));
      const { authorizationId, expiresAt, issuedAt } = issued.proof;
      expect(DateTime.toEpochMillis(expiresAt) - DateTime.toEpochMillis(issuedAt)).toBe(1000);

      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const holdUntil = DateTime.addDuration(expiresAt, Duration.millis(150));
      const holder = yield* holdPaymentRowLock(harness, payment.paymentId, locked, release, holdUntil).pipe(
        Effect.forkChild,
      );
      const holderPid = yield* Deferred.await(locked);
      // The request starts before E ...
      const requestStart = yield* databaseNow(harness.adminClient);
      expect(DateTime.isLessThan(requestStart, expiresAt)).toBe(true);
      const validation = yield* harness.validate({ authorizationId, binding }).pipe(Effect.forkChild);
      // ... and PostgreSQL proves it waits on the Payment row lock (not merely slow) ...
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 1)).toBe(1);
      // ... while the lock holder keeps the row inside PostgreSQL until after E.
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      const waited = yield* Fiber.join(validation);
      expect(waited).toMatchObject({ outcome: 'NOT_VALID', reasons: ['EXPIRED'] });
      // The actual boundary is after the wait, at or after E, regardless of T or the request start.
      expect(DateTime.isGreaterThanOrEqualTo(waited.validatedAt, expiresAt)).toBe(true);
      // Exact replay recovers the original proof and times; it never refreshes the expiry.
      expect(yield* harness.issue(issuePayload(binding, 'expiring', 1))).toEqual({
        issuance: 'REPLAYED',
        proof: issued.proof,
      });
      // A refreshed runtime Composition R2 does not revive it; the original provenance stays R1.
      const replayAtR2 = yield* harness.issue(issuePayload(binding, 'expiring', 1), R2);
      expect(replayAtR2.proof.provenance.compositionRevision).toBe(R1);
      expect((yield* harness.validate({ authorizationId, binding })).reasons).toEqual(['EXPIRED']);
    }),
  ),
);

// ---------------------------------------------------------------------------------------------
// Coverage reduction and the shared owner concurrency boundary
// ---------------------------------------------------------------------------------------------

it.live('#1149 Refund races with prepaid proof issuance: refund first, issuance waits and is refused', () =>
  nativeRun(
    Effect.gen(function* refundBeforeIssuance() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      const collected = yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-race-a', yield* frozenT(harness, 1));
      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const holder = yield* holdPaymentRowLock(harness, payment.paymentId, locked, release).pipe(Effect.forkChild);
      const holderPid = yield* Deferred.await(locked);
      const refund = yield* startRefund(harness, payment, collected.operationId).pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 1)).toBe(1);
      const issuance = yield* failureCode(harness.issue(issuePayload(binding, 'race-a'))).pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 2)).toBe(2);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      expect((yield* Fiber.join(refund)).outcome).toBe('PENDING');
      // Issuance decided under the lock after the refund committed: no proof against stale full coverage.
      expect(yield* Fiber.join(issuance)).toBe('payment_authorization_coverage_insufficient');
      expect(yield* outboxCount(harness)).toBe(0);
    }),
  ),
);

it.live('#1149 Refund races with prepaid proof issuance: issuance first, the proof dies with the refund start', () =>
  nativeRun(
    Effect.gen(function* issuanceBeforeRefund() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      const collected = yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-race-b', yield* frozenT(harness, 1));
      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const holder = yield* holdPaymentRowLock(harness, payment.paymentId, locked, release).pipe(Effect.forkChild);
      const holderPid = yield* Deferred.await(locked);
      const issuance = yield* harness.issue(issuePayload(binding, 'race-b')).pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 1)).toBe(1);
      const refund = yield* startRefund(harness, payment, collected.operationId).pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 2)).toBe(2);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      const issued = yield* Fiber.join(issuance);
      yield* Fiber.join(refund);
      // Both committed, but never against the same coverage revision: the proof is no longer Current.
      expect(yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding })).toMatchObject({
        outcome: 'NOT_VALID',
        reasons: ['COVERAGE_REVISION_CHANGED', 'COVERAGE_INSUFFICIENT'],
      });
    }),
  ),
);

it.live('#1149 Refund races with prepaid proof validation: validation waits on the lock and sees the refund', () =>
  nativeRun(
    Effect.gen(function* refundBeforeValidation() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      const collected = yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-race-c', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'race-c'));
      const validate = harness.validate({ authorizationId: issued.proof.authorizationId, binding });
      expect((yield* validate).outcome).toBe('VALID');
      const locked = yield* Deferred.make<number>();
      const release = yield* Deferred.make<boolean>();
      const holder = yield* holdPaymentRowLock(harness, payment.paymentId, locked, release).pipe(Effect.forkChild);
      const holderPid = yield* Deferred.await(locked);
      const refund = yield* startRefund(harness, payment, collected.operationId).pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 1)).toBe(1);
      const validation = yield* validate.pipe(Effect.forkChild);
      expect(yield* awaitWaitersBehind(harness.adminClient, holderPid, 2)).toBe(2);
      yield* Deferred.succeed(release, true);
      yield* Fiber.join(holder);
      yield* Fiber.join(refund);
      expect(yield* Fiber.join(validation)).toMatchObject({
        outcome: 'NOT_VALID',
        reasons: ['COVERAGE_REVISION_CHANGED', 'COVERAGE_INSUFFICIENT'],
      });
    }),
  ),
);

it.live('#1149 Refund races with prepaid proof issuance: an unordered race never leaves a Current proof', () =>
  nativeRun(
    Effect.gen(function* unorderedRace() {
      const harness = yield* makeHarness();
      const payment = yield* createPayment(harness);
      const collected = yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-race-d', yield* frozenT(harness, 1));
      const [issuance, refund] = yield* Effect.all(
        [
          Effect.result(harness.issue(issuePayload(binding, 'race-d'))),
          startRefund(harness, payment, collected.operationId),
        ],
        { concurrency: 2 },
      );
      expect(refund.outcome).toBe('PENDING');
      if (Result.isFailure(issuance)) {
        expect(Predicate.hasProperty(issuance.failure, 'code') ? issuance.failure.code : 'unknown').toBe(
          'payment_authorization_coverage_insufficient',
        );
      } else {
        const validation = yield* harness.validate({
          authorizationId: issuance.success.proof.authorizationId,
          binding,
        });
        expect(validation.outcome).toBe('NOT_VALID');
      }
    }),
  ),
);

it.live(
  '#1149 confirmed and indeterminate coverage reduction make the prepaid proof unusable and block new issuance',
  () =>
    nativeRun(
      Effect.gen(function* coverageReduction() {
        yield* installPaymentTestCompositionAuthority(COMPOSITION_REVISION);
        const harness = yield* makeHarness();
        const payment = yield* createPayment(harness);
        const collected = yield* confirmCollect(harness, payment);
        const binding = bindingFor(payment, 'attempt-reduction', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'reduction'));
        const validate = harness.validate({ authorizationId: issued.proof.authorizationId, binding });
        // An indeterminate return does not mean money is still safely available for commitment.
        const refund = yield* startRefund(harness, payment, collected.operationId, 'INDETERMINATE');
        expect(yield* validate).toMatchObject({
          outcome: 'NOT_VALID',
          reasons: ['COVERAGE_REVISION_CHANGED', 'COVERAGE_INSUFFICIENT'],
        });
        expect(yield* failureCode(harness.issue(issuePayload(binding, 'reduction-indeterminate')))).toBe(
          'payment_authorization_coverage_insufficient',
        );
        // A confirmed reduction cannot coexist with a valid prepaid proof for the reduced amount.
        yield* settleOperation(harness, payment.paymentId, refund, 'EFFECT_CONFIRMED');
        expect(yield* failureCode(harness.issue(issuePayload(binding, 'reduction-confirmed')))).toBe(
          'payment_authorization_coverage_insufficient',
        );
        expect(yield* validate).toMatchObject({
          outcome: 'NOT_VALID',
          reasons: ['COVERAGE_REVISION_CHANGED', 'COVERAGE_INSUFFICIENT'],
        });
      }),
    ),
);

it.live(
  '#1149 correct historical replay versus Current validation: replay returns the original, validation refuses it',
  () =>
    nativeRun(
      Effect.gen(function* replayVersusValidation() {
        const harness = yield* makeHarness();
        const payment = yield* createPayment(harness);
        const collected = yield* confirmCollect(harness, payment);
        const binding = bindingFor(payment, 'attempt-replay', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'replay'));
        yield* startRefund(harness, payment, collected.operationId);
        // The original immutable proof, times and provenance; no new Outbox fact.
        expect(yield* harness.issue(issuePayload(binding, 'replay'))).toEqual({
          issuance: 'REPLAYED',
          proof: issued.proof,
        });
        expect(yield* outboxCount(harness)).toBe(1);
        const validation = yield* harness.validate({ authorizationId: issued.proof.authorizationId, binding });
        expect(validation.outcome).toBe('NOT_VALID');
        expect(validation.proof).toEqual(issued.proof);
        // The same issuance key with different Attempt material is a conflict, never a second proof.
        expect(yield* failureCode(harness.issue(issuePayload(binding, 'replay', 60)))).toBe(
          'payment_authorization_issuance_conflict',
        );
        expect(
          yield* failureCode(
            harness.issue(issuePayload({ ...binding, orderCommitmentAttemptId: 'attempt-2' }, 'replay')),
          ),
        ).toBe('payment_authorization_issuance_conflict');
      }),
    ),
);

it.live(
  '#1149 admitted runtime and late evidence: R2 checks Current state with new provenance and never rewrites R1',
  () =>
    nativeRun(
      Effect.gen(function* admittedRuntime() {
        const harness = yield* makeHarness();
        const payment = yield* createPayment(harness);
        yield* confirmCollect(harness, payment);
        const binding = bindingFor(payment, 'attempt-runtime', yield* frozenT(harness, 1));
        const atR1 = yield* harness.issue(issuePayload(binding, 'runtime-r1'), R1);
        expect(atR1.proof.provenance.compositionRevision).toBe(R1);
        const atR2 = yield* harness.issue(issuePayload(binding, 'runtime-r2'), R2);
        expect(atR2.issuance).toBe('ISSUED');
        expect(atR2.proof.provenance.compositionRevision).toBe(R2);
        expect(atR2.proof.authorizationId).not.toBe(atR1.proof.authorizationId);
        expect((yield* harness.issue(issuePayload(binding, 'runtime-r1'), R2)).proof.provenance).toEqual(
          atR1.proof.provenance,
        );
        const validation = yield* harness.validate({ authorizationId: atR1.proof.authorizationId, binding });
        expect(validation.outcome).toBe('VALID');
        expect(validation.proof?.provenance).toEqual(atR1.proof.provenance);
        // Late evidence (a refund start recorded by a later invocation) applies to the original lineage.
        const {
          operations: [collect],
        } = yield* withPersistence(harness.database, harness.scope, (persistence) =>
          persistence.loadAggregate(payment.paymentId),
        );
        if (collect !== undefined) {
          yield* startRefund(harness, payment, collect.operationId);
        }
        expect((yield* harness.validate({ authorizationId: atR1.proof.authorizationId, binding })).outcome).toBe(
          'NOT_VALID',
        );
        expect((yield* storedProof(harness, atR1.proof.authorizationId))?.compositionRevision).toBe(R1);
      }),
    ),
);

// ---------------------------------------------------------------------------------------------
// Core Module State matrix and Current permission (#1153 classification of these two entrypoints)
// ---------------------------------------------------------------------------------------------

const READ_CAPABLE_STATES: ReadonlySet<TenantModuleState> = new Set(['active', 'deprecated', 'read_only']);

it.live('#1149 all supported Core states: issuance needs active, Current validation needs a read-capable state', () =>
  nativeRun(
    Effect.gen(function* moduleStateMatrix() {
      const harness = yield* makeHarness({ moduleState: 'active' });
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-state', yield* frozenT(harness, 1));
      const issued = yield* harness.issue(issuePayload(binding, 'state-active'));
      const validate = harness.validate({ authorizationId: issued.proof.authorizationId, binding });
      const outcomes: (readonly [string, string, string])[] = [];
      for (const state of TENANT_MODULE_STATES) {
        yield* harness.admin
          .update(tenantModuleStates)
          .set({ state })
          .where(
            and(
              eq(tenantModuleStates.tenantId, harness.scope.tenantId),
              eq(tenantModuleStates.moduleKey, 'payment.core'),
            ),
          );
        const issuance = yield* failureCode(harness.issue(issuePayload(binding, `state-${state}`)));
        const validation = yield* Effect.result(validate);
        const validationOutcome = Result.isSuccess(validation)
          ? validation.success.outcome
          : codeOf(validation.failure);
        outcomes.push([state, issuance, validationOutcome]);
      }
      expect(outcomes).toEqual(
        TENANT_MODULE_STATES.map((state) => [
          state,
          state === 'active' ? 'succeeded' : 'module_state_denied',
          READ_CAPABLE_STATES.has(state) ? 'VALID' : 'module_state_denied',
        ]),
      );
      // Missing module state denies everything; there is no fallback to retained evidence.
      const missing = yield* makeHarness({ moduleState: 'MISSING' });
      expect(yield* failureCode(missing.issue(issuePayload(binding, 'state-missing')))).toBe('module_state_denied');
      expect(yield* failureCode(missing.validate({ authorizationId: issued.proof.authorizationId, binding }))).toBe(
        'module_state_denied',
      );
    }),
  ),
);

it.live(
  '#1149 Historical proof is recovered while Payment is archived: payment-history returns the original proof and times',
  () =>
    nativeRun(
      Effect.gen(function* historicalRecoveryWhileArchived() {
        const harness = yield* makeHarness({ moduleState: 'active' });
        const termRef = authorizationTermRefFor(harness.scope.tenantId, yield* randomUuid);
        const snapshot = authorizationNetDaysSnapshot(termRef, 14);
        const payment = yield* createPayment(harness, {
          buyer: 'buyer-history',
          customerConfigurationId: 'ccc-history',
          executionBinding: { _tag: 'BANK_ACCOUNTING_RECEIPT' },
          method: 'DEFERRED_INVOICE',
          termSnapshot: snapshot,
        });
        yield* harness.evidence.putEntitlementPeriod({
          buyer: buyerOf(harness, 'buyer-history'),
          entitlementEvidenceRef: 'entitlement-history',
          semanticSnapshot: snapshot,
          status: 'CURRENT',
        });
        const binding = bindingFor(payment, 'attempt-history', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'history'));
        yield* harness.admin
          .update(tenantModuleStates)
          .set({ state: 'archived' })
          .where(
            and(
              eq(tenantModuleStates.tenantId, harness.scope.tenantId),
              eq(tenantModuleStates.moduleKey, 'payment.core'),
            ),
          );
        // Current validation is denied while archived; the declared historical capability is not.
        expect(yield* failureCode(harness.validate({ authorizationId: issued.proof.authorizationId, binding }))).toBe(
          'module_state_denied',
        );
        const history = yield* harness.history(payment.paymentId);
        expect(history.currentValidityClaimed).toBe(false);
        // The original immutable proof P: exact Attempt binding with frozen T, the satisfied condition
        // and its source evidence, the term semantic reference, the issuance key and original times.
        expect(history.authorizations).toEqual([issued.proof]);
      }),
    ),
);

it.live(
  '#1149 Historical proof while Payment is archived or quarantined: Current validation and new issuance are denied',
  () =>
    nativeRun(
      Effect.gen(function* archivedOrQuarantined() {
        const harness = yield* makeHarness({ moduleState: 'active' });
        const payment = yield* createPayment(harness);
        yield* confirmCollect(harness, payment);
        const binding = bindingFor(payment, 'attempt-archived', yield* frozenT(harness, 1));
        const issued = yield* harness.issue(issuePayload(binding, 'archived'));
        for (const state of ['archived', 'quarantined'] as const) {
          yield* harness.admin
            .update(tenantModuleStates)
            .set({ state })
            .where(
              and(
                eq(tenantModuleStates.tenantId, harness.scope.tenantId),
                eq(tenantModuleStates.moduleKey, 'payment.core'),
              ),
            );
          expect(yield* failureCode(harness.validate({ authorizationId: issued.proof.authorizationId, binding }))).toBe(
            'module_state_denied',
          );
          expect(yield* failureCode(harness.issue(issuePayload(binding, `archived-${state}`)))).toBe(
            'module_state_denied',
          );
        }
        // The retained proof itself is untouched; its historical recovery is covered by payment-history above.
        const stored = yield* storedProof(harness, issued.proof.authorizationId);
        expect(stored?.issuedAt.getTime()).toBe(DateTime.toEpochMillis(issued.proof.issuedAt));
      }),
    ),
);

it.live('#1149 Historical evidence does not bypass revoked access: Current validation and issuance are refused', () =>
  nativeRun(
    Effect.gen(function* revokedAccess() {
      const harness = yield* makeHarness({ access: 'denied' });
      const payment = yield* createPayment(harness);
      yield* confirmCollect(harness, payment);
      const binding = bindingFor(payment, 'attempt-revoked', yield* frozenT(harness, 1));
      expect(yield* failureCode(harness.issue(issuePayload(binding, 'revoked')))).toBe('action_permission_denied');
      expect(
        yield* failureCode(harness.validate({ authorizationId: '00000000-0000-4000-8000-000000000001', binding })),
      ).toBe('read_permission_denied');
      expect(yield* outboxCount(harness)).toBe(0);
    }),
  ),
);
