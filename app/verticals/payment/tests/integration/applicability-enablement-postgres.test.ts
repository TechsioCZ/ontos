import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { DateTime, Deferred, Effect, Fiber, Option, Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import type { ConfigurePaymentMethodEnablementPayload } from '../../shared/actions/configure-payment-method-enablement.ts';
import type { PaymentMethodApplicabilityRequest } from '../../shared/apis/payment-method-applicability.ts';
import { PaymentMethodEnablementConflict } from '../../shared/domain/applicability-errors.ts';
import { paymentUnavailable, PaymentUnavailable } from '../../shared/domain/payment-unavailable.ts';
import type { PaymentMethod } from '../../shared/domain/payment-vocabulary.ts';
import { configurePaymentMethodEnablementAction } from '../../src/actions/configure-payment-method-enablement.action.ts';
import { paymentMethodApplicabilityRead } from '../../src/api/payment-method-applicability.read.ts';
import { paymentApplicabilityPersistenceForTransaction } from '../../src/persistence/payment-applicability-persistence.ts';
import type {
  ConfigurePaymentMethodEnablementInput,
  PaymentApplicabilityPersistence,
} from '../../src/persistence/payment-applicability-persistence.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import {
  applicabilityOwnerEvidenceFixture,
  codSupported,
  GOPAY_PRODUCTION,
  netDaysSnapshot,
  OWNER_EVIDENCE_UNAVAILABLE,
  pickupSupported,
  termRefFor,
  usableTerm,
} from '../support/applicability-owner-evidence.fixture.ts';
import {
  failureCodeOf,
  inScope,
  makeTestScope,
  operationalScopeOf,
  paymentTestRelations,
  provenanceFor,
  randomUuid,
} from './database-fixture.ts';
import type { PaymentTestDatabase, PaymentTestScope } from './database-fixture.ts';

/**
 * #1147 native evidence for A1 `configure-payment-method-enablement` and R1
 * `payment-method-applicability`: owner persistence on the worktree PostgreSQL as the shared runtime
 * role under forced RLS, the enablement row lock under real concurrency, and both entrypoints run
 * through their registered descriptors and the Core Action/Read runtimes.
 */

type PaymentTestTransaction = Parameters<Parameters<PaymentTestDatabase['transaction']>[0]>[0];

const withApplicability = <Value, Failure>(
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
  operation: (persistence: PaymentApplicabilityPersistence) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction: PaymentTestTransaction) =>
    Effect.gen(function* scopedApplicabilityPersistence() {
      const scoped = yield* installOperationalScope(transaction, operationalScopeOf(scope));
      return yield* operation(paymentApplicabilityPersistenceForTransaction(scoped));
    }),
  );

const nativeDatabase = Effect.gen(function* nativeDatabase() {
  const { admin, runtime: runtimeClient } = yield* testDatabaseClients;
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, paymentTestRelations);
  return { admin, runtime, runtimeClient };
});

const configureInput = Effect.fn('ApplicabilityTest.configureInput')(function* configureInput(
  scope: PaymentTestScope,
  input: Omit<ConfigurePaymentMethodEnablementInput, 'provenance'>,
) {
  return { ...input, provenance: yield* provenanceFor(scope) } satisfies ConfigurePaymentMethodEnablementInput;
});

const revisionHistory = (client: PgClient.PgClient, scope: PaymentTestScope, method: PaymentMethod) =>
  inScope(
    client,
    scope,
    client.unsafe<{ readonly enabled: boolean; readonly revision: number }>(
      `select enabled, revision from payment.method_enablement_revisions
       where method = $1 order by revision`,
      [method],
    ),
  ).pipe(Effect.map((rows) => rows.map(({ enabled, revision }) => ({ enabled, revision }))));

const countRows = (client: PgClient.PgClient, scope: PaymentTestScope, table: string) =>
  inScope(
    client,
    scope,
    client.unsafe<{ readonly count: number }>(`select count(*)::integer as count from ${table}`),
  ).pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const awaitBlockedWaiter = (admin: PgClient.PgClient) => {
  const waitingOnLocks = admin
    .unsafe<{ readonly waiting: number }>(
      `select count(*)::integer as waiting from pg_catalog.pg_stat_activity
       where datname = current_database() and cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
         and wait_event_type = 'Lock' and query ilike '%"method_enablements"%'`,
    )
    .pipe(Effect.map((rows) => rows[0]?.waiting ?? 0));
  const poll = (remaining: number): Effect.Effect<number, Effect.Error<typeof waitingOnLocks>> =>
    waitingOnLocks.pipe(
      Effect.flatMap((waiting) =>
        waiting > 0 || remaining === 0 ? Effect.succeed(waiting) : Effect.suspend(() => poll(remaining - 1)),
      ),
    );
  return poll(5000);
};

const isEnablementFailure = Schema.is(Schema.Union([PaymentMethodEnablementConflict, PaymentUnavailable]));
const isPaymentUnavailable = Schema.is(PaymentUnavailable);

/**
 * The real owner persistence, each call in its own Core-scoped native transaction. Bound into the
 * Core Action harness, whose own invocation bookkeeping is scripted, so the registered handler,
 * payload decoding, access gate and problem mapping run while the owner write is native.
 */
const nativeApplicabilityServices = (
  database: PaymentTestDatabase,
  scope: PaymentTestScope,
): PaymentApplicabilityPersistence => ({
  configureEnablement: (input) =>
    withApplicability(database, scope, (persistence) => persistence.configureEnablement(input)).pipe(
      Effect.mapError((failure) =>
        isEnablementFailure(failure) ? failure : paymentUnavailable('Native transaction failed', failure),
      ),
    ),
  loadCurrentEnablements: (customerConfigurationId) =>
    withApplicability(database, scope, (persistence) =>
      persistence.loadCurrentEnablements(customerConfigurationId),
    ).pipe(
      Effect.mapError((failure) =>
        isPaymentUnavailable(failure) ? failure : paymentUnavailable('Native transaction failed', failure),
      ),
    ),
});

const principalOf = (scope: PaymentTestScope) => ({
  authBindingId: scope.principalId,
  authContextRef: 'better-auth-session:payment-applicability-tests',
  authMethod: 'session' as const,
  legalEntityId: scope.legalEntityId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
});

describe('#1147 A1 method enablement — native persistence', () => {
  it.live('#1147 A1 persists Current enablement with an append-only revision history and truthful provenance', () =>
    Effect.scoped(
      Effect.gen(function* enablementHistory() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const base = { customerConfigurationId: 'cc-history', method: 'BANK_TRANSFER_ADVANCE' as const };

        const firstInput = yield* configureInput(scope, {
          ...base,
          enabled: true,
          expectedRevision: Option.none(),
          reason: 'Launch bank transfer',
        });
        const first = yield* withApplicability(runtime, scope, (p) => p.configureEnablement(firstInput));
        expect(first.changed).toBe(true);
        expect(first.record.revision).toBe(1);
        expect(first.record.provenance).toEqual(firstInput.provenance);

        const disable = yield* configureInput(scope, {
          ...base,
          enabled: false,
          expectedRevision: Option.some(1),
          reason: 'Pause bank transfer',
        });
        const second = yield* withApplicability(runtime, scope, (p) => p.configureEnablement(disable));
        expect([second.changed, second.record.revision, second.record.enabled]).toEqual([true, 2, false]);

        // Re-stating the Current state appends nothing.
        const unchanged = yield* configureInput(scope, {
          ...base,
          enabled: false,
          expectedRevision: Option.some(2),
          reason: 'Still paused',
        });
        const noOp = yield* withApplicability(runtime, scope, (p) => p.configureEnablement(unchanged));
        expect([noOp.changed, noOp.record.revision, noOp.record.reason]).toEqual([false, 2, 'Pause bank transfer']);

        expect(yield* revisionHistory(runtimeClient, scope, 'BANK_TRANSFER_ADVANCE')).toEqual([
          { enabled: true, revision: 1 },
          { enabled: false, revision: 2 },
        ]);
        const current = yield* withApplicability(runtime, scope, (p) => p.loadCurrentEnablements('cc-history'));
        expect(current).toEqual([{ enabled: false, method: 'BANK_TRANSFER_ADVANCE', revision: 2 }]);
      }),
    ),
  );

  it.live('#1147 A1 a stale, invented or missing expected revision is a typed conflict and changes nothing', () =>
    Effect.scoped(
      Effect.gen(function* staleRevisionConflict() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const base = { customerConfigurationId: 'cc-stale', enabled: true, method: 'DEFERRED_INVOICE' as const };

        const invented = yield* configureInput(scope, {
          ...base,
          expectedRevision: Option.some(3),
          reason: 'Invented revision',
        });
        expect(yield* failureCodeOf(withApplicability(runtime, scope, (p) => p.configureEnablement(invented)))).toBe(
          'payment_method_enablement_revision_conflict',
        );
        const created = yield* configureInput(scope, { ...base, expectedRevision: Option.none(), reason: 'Enable' });
        yield* withApplicability(runtime, scope, (p) => p.configureEnablement(created));

        const blind = yield* configureInput(scope, {
          ...base,
          enabled: false,
          expectedRevision: Option.none(),
          reason: 'Blind overwrite',
        });
        const stale = yield* configureInput(scope, {
          ...base,
          enabled: false,
          expectedRevision: Option.some(2),
          reason: 'Stale',
        });
        for (const input of [blind, stale]) {
          expect(yield* failureCodeOf(withApplicability(runtime, scope, (p) => p.configureEnablement(input)))).toBe(
            'payment_method_enablement_revision_conflict',
          );
        }
        expect(yield* revisionHistory(runtimeClient, scope, 'DEFERRED_INVOICE')).toEqual([
          { enabled: true, revision: 1 },
        ]);
      }),
    ),
  );

  it.live(
    '#1147 A1 two concurrent reconfigurations serialize on the enablement row lock; one wins, one conflicts',
    () =>
      Effect.scoped(
        Effect.gen(function* rowLockSerialization() {
          const { admin, runtime, runtimeClient } = yield* nativeDatabase;
          const scope = yield* makeTestScope;
          const base = { customerConfigurationId: 'cc-race', method: 'CASH_ON_DELIVERY' as const };
          const created = yield* configureInput(scope, {
            ...base,
            enabled: true,
            expectedRevision: Option.none(),
            reason: 'Enable COD',
          });
          yield* withApplicability(runtime, scope, (p) => p.configureEnablement(created));
          const [disableA, disableB] = yield* Effect.all(
            [
              configureInput(scope, {
                ...base,
                enabled: false,
                expectedRevision: Option.some(1),
                reason: 'Operator A',
              }),
              configureInput(scope, {
                ...base,
                enabled: false,
                expectedRevision: Option.some(1),
                reason: 'Operator B',
              }),
            ],
            { concurrency: 1 },
          );
          const changed = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();

          // A changes the row and holds its lock (uncommitted) until released.
          const first = yield* withApplicability(runtime, scope, (p) =>
            Effect.gen(function* holdLock() {
              const outcome = yield* p.configureEnablement(disableA);
              yield* Deferred.succeed(changed, true);
              yield* Deferred.await(release);
              return outcome;
            }),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(changed);
          const second = yield* failureCodeOf(
            withApplicability(runtime, scope, (p) => p.configureEnablement(disableB)),
          ).pipe(Effect.forkChild);

          // PostgreSQL proves B waits on A's row lock before A commits.
          expect(yield* awaitBlockedWaiter(admin)).toBeGreaterThan(0);
          yield* Deferred.succeed(release, true);

          const winner = yield* Fiber.join(first);
          expect([winner.changed, winner.record.revision]).toEqual([true, 2]);
          expect(yield* Fiber.join(second)).toBe('payment_method_enablement_revision_conflict');
          expect(yield* revisionHistory(runtimeClient, scope, 'CASH_ON_DELIVERY')).toEqual([
            { enabled: true, revision: 1 },
            { enabled: false, revision: 2 },
          ]);
        }),
      ),
  );

  it.live('#1147 A1 two concurrent first configurations create exactly one revision 1; the other conflicts', () =>
    Effect.scoped(
      Effect.gen(function* firstConfigurationRace() {
        const { admin, runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const base = {
          customerConfigurationId: 'cc-first',
          expectedRevision: Option.none(),
          method: 'ONLINE_GATEWAY' as const,
        };
        const [enableA, enableB] = yield* Effect.all(
          [
            configureInput(scope, { ...base, enabled: true, reason: 'Operator A' }),
            configureInput(scope, { ...base, enabled: false, reason: 'Operator B' }),
          ],
          { concurrency: 1 },
        );
        const inserted = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const first = yield* withApplicability(runtime, scope, (p) =>
          Effect.gen(function* holdInsert() {
            const outcome = yield* p.configureEnablement(enableA);
            yield* Deferred.succeed(inserted, true);
            yield* Deferred.await(release);
            return outcome;
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(inserted);
        const second = yield* failureCodeOf(
          withApplicability(runtime, scope, (p) => p.configureEnablement(enableB)),
        ).pipe(Effect.forkChild);
        expect(yield* awaitBlockedWaiter(admin)).toBeGreaterThan(0);
        yield* Deferred.succeed(release, true);

        expect((yield* Fiber.join(first)).record.revision).toBe(1);
        expect(yield* Fiber.join(second)).toBe('payment_method_enablement_revision_conflict');
        expect(yield* revisionHistory(runtimeClient, scope, 'ONLINE_GATEWAY')).toEqual([
          { enabled: true, revision: 1 },
        ]);
      }),
    ),
  );

  it.live('#1147 A1 enablement is scoped to Tenant, Selling Legal Entity and Customer Configuration under RLS', () =>
    Effect.scoped(
      Effect.gen(function* scopeIsolation() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const otherTenant = yield* makeTestScope;
        const otherLegalEntity = { ...scope, legalEntityId: yield* randomUuid };
        const input = yield* configureInput(scope, {
          customerConfigurationId: 'cc-scoped',
          enabled: true,
          expectedRevision: Option.none(),
          method: 'PAY_ON_PICKUP_OR_ON_SITE',
          reason: 'Enable pickup',
        });
        yield* withApplicability(runtime, scope, (p) => p.configureEnablement(input));

        const load = (selected: PaymentTestScope, customerConfigurationId: string) =>
          withApplicability(runtime, selected, (p) => p.loadCurrentEnablements(customerConfigurationId));
        expect(yield* load(scope, 'cc-scoped')).toHaveLength(1);
        expect(yield* load(scope, 'cc-other')).toEqual([]);
        expect(yield* load(otherTenant, 'cc-scoped')).toEqual([]);
        expect(yield* load(otherLegalEntity, 'cc-scoped')).toEqual([]);
        // Raw SQL under the foreign scope sees nothing either: RLS, not only the owner filter.
        expect(yield* countRows(runtimeClient, otherLegalEntity, 'payment.method_enablements')).toBe(0);
        expect(yield* countRows(runtimeClient, otherTenant, 'payment.method_enablement_revisions')).toBe(0);
        // A foreign scope cannot "reconfigure" it: it would create its own, separate configuration.
        const foreign = yield* configureInput(otherTenant, {
          customerConfigurationId: 'cc-scoped',
          enabled: false,
          expectedRevision: Option.some(1),
          method: 'PAY_ON_PICKUP_OR_ON_SITE',
          reason: 'Foreign attempt',
        });
        expect(
          yield* failureCodeOf(withApplicability(runtime, otherTenant, (p) => p.configureEnablement(foreign))),
        ).toBe('payment_method_enablement_revision_conflict');
        expect((yield* load(scope, 'cc-scoped'))[0]?.enabled).toBe(true);
      }),
    ),
  );
});

describe('#1147 A1 configure-payment-method-enablement through the Core Action runtime', () => {
  it.live('#1147 A1 runs through the registered Action descriptor with native owner persistence', () =>
    Effect.scoped(
      Effect.gen(function* actionThroughCore() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const payload: ConfigurePaymentMethodEnablementPayload = {
          customerConfigurationId: 'cc-action',
          enabled: true,
          method: 'BANK_TRANSFER_ADVANCE',
          reason: 'Launch bank transfer',
        };
        const services = [
          bindActionTestServices(configurePaymentMethodEnablementAction, nativeApplicabilityServices(runtime, scope)),
        ];
        const request = {
          payload,
          principal: principalOf(scope),
          registration: configurePaymentMethodEnablementAction,
          transport: { correlationId: 'payment-applicability-a1', idempotencyKey: 'a1-enable-bank' },
        };

        // Principal Permission is separate from the configuration: a denied principal changes nothing.
        const denied = yield* makeActionTestHarness({
          access: 'denied',
          ownerRegistration: paymentRegistration,
          services,
        });
        const refusal = yield* denied.runtime.runAction(request).pipe(Effect.flip);
        expect(Predicate.isTagged(refusal, 'ActionPermissionDenied')).toBe(true);
        expect(denied.snapshot().stages).not.toContain('handler_executed');

        // An inactive Payment module refuses the write at the Core gate.
        const inactive = yield* makeActionTestHarness({
          access: 'allowed',
          moduleState: 'inactive',
          ownerRegistration: paymentRegistration,
          services,
        });
        const gated = yield* inactive.runtime.runAction(request).pipe(Effect.flip);
        expect(Predicate.isTagged(gated, 'ModuleStateDeniedError')).toBe(true);
        expect(yield* countRows(runtimeClient, scope, 'payment.method_enablements')).toBe(0);

        const allowed = yield* makeActionTestHarness({
          access: 'allowed',
          ownerRegistration: paymentRegistration,
          services,
        });
        const result = yield* allowed.runtime.runAction(request);
        expect(result).toMatchObject({
          changed: true,
          customerConfigurationId: 'cc-action',
          enabled: true,
          method: 'BANK_TRANSFER_ADVANCE',
          revision: 1,
        });
        expect(DateTime.formatIso(result.configuredAt)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
        expect(allowed.snapshot().committed).toHaveLength(1);

        // The stored row carries the Core invocation that wrote it.
        const [invocation] = allowed.snapshot().invocations;
        const [row] = yield* inScope(
          runtimeClient,
          scope,
          runtimeClient.unsafe<{ readonly action_invocation_id: string; readonly actor_principal_id: string }>(
            'select action_invocation_id, actor_principal_id from payment.method_enablements',
          ),
        );
        expect(row?.action_invocation_id).toBe(invocation?.actionInvocationId);
        expect(row?.actor_principal_id).toBe(scope.principalId);

        // A stale reconfiguration maps to the generated 409 problem code through the descriptor's errors.
        const stale = yield* allowed.runtime
          .runAction({
            ...request,
            payload: { ...payload, enabled: false, expectedRevision: 7 },
            transport: { correlationId: 'payment-applicability-a1', idempotencyKey: 'a1-stale' },
          })
          .pipe(Effect.flip);
        expect(Predicate.isTagged(stale, 'PaymentMethodEnablementConflict')).toBe(true);
      }),
    ),
  );
});

const positionalRow = (row: readonly unknown[]) => Object.fromEntries(row.map((value, index) => [index, value]));
/** Fixed trusted operation time for the scripted Core admission SQL; evaluation uses the real clock. */
const readOperationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-09T00:00:00.000Z'));

const readHarness = (client: PgClient.PgClient, scope: PaymentTestScope) =>
  makeReadTestHarness({
    access: 'allowed',
    // Owner SQL runs on native PostgreSQL as the runtime role under the harness's validated scope.
    executeOwnerQuery: (query) =>
      client.withTransaction(
        client
          .unsafe("select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)", [
            query.scope.tenantId,
            query.scope.legalEntityId,
          ])
          .pipe(
            Effect.andThen(client.unsafe(query.sql, [...query.params]).values),
            Effect.map((rows) => rows.map(positionalRow)),
          ),
      ),
    operationTime: readOperationTime,
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: paymentRegistration,
    scope: operationalScopeOf(scope),
  }).pipe(Effect.provide(NodeCrypto.layer));

describe('#1147 R1 payment-method-applicability through the Core Read runtime', () => {
  it.live(
    '#1147 R1 evaluates native Current enablement per branch (COD outage, bank AVAILABLE) and writes nothing',
    () =>
      Effect.scoped(
        Effect.gen(function* readThroughCore() {
          const { runtime, runtimeClient } = yield* nativeDatabase;
          const scope = yield* makeTestScope;
          const termRef = termRefFor(scope.tenantId, yield* randomUuid);
          for (const method of ['BANK_TRANSFER_ADVANCE', 'CASH_ON_DELIVERY', 'ONLINE_GATEWAY'] as const) {
            const input = yield* configureInput(scope, {
              customerConfigurationId: 'cc-read',
              enabled: true,
              expectedRevision: Option.none(),
              method,
              reason: `Enable ${method}`,
            });
            yield* withApplicability(runtime, scope, (p) => p.configureEnablement(input));
          }
          const owners = applicabilityOwnerEvidenceFixture({
            codCapability: () => OWNER_EVIDENCE_UNAVAILABLE,
            enabledGatewayBindings: [GOPAY_PRODUCTION],
            pickupCapability: pickupSupported,
            termUse: () => usableTerm(netDaysSnapshot(termRef, 14), 'entitlement-A'),
          });
          const harness = yield* readHarness(runtimeClient, scope);
          const read = (branches: PaymentMethodApplicabilityRequest['branches']) =>
            harness.runtime
              .runRead({
                input: {
                  amount: { amountMinor: 250_000, currency: 'CZK' },
                  branches,
                  customerConfigurationId: 'cc-read',
                  paymentTermRef: termRef,
                },
                principal: principalOf(scope),
                registration: paymentMethodApplicabilityRead,
                transport: { correlationId: 'payment-applicability-r1' },
              })
              .pipe(Effect.provide(owners.layer));

          const first = yield* read([
            { deliveryOfferRef: 'offer-ppl-parcel', method: 'CASH_ON_DELIVERY' },
            { method: 'BANK_TRANSFER_ADVANCE' },
            { method: 'ONLINE_GATEWAY', selectedBinding: GOPAY_PRODUCTION },
            { method: 'DEFERRED_INVOICE' },
          ]);
          expect(first.branches.map(({ method, outcome }) => `${method}:${outcome}`)).toEqual([
            'CASH_ON_DELIVERY:UNAVAILABLE_TO_VERIFY',
            'BANK_TRANSFER_ADVANCE:AVAILABLE',
            'ONLINE_GATEWAY:AVAILABLE',
            'DEFERRED_INVOICE:NOT_ENABLED',
          ]);
          expect(first.paymentTermRef).toEqual(termRef);
          expect(harness.snapshot().ownerQueries.length).toBeGreaterThan(0);

          // A1 disables bank transfer; the next Current read reflects it, nothing else changes.
          const disable = yield* configureInput(scope, {
            customerConfigurationId: 'cc-read',
            enabled: false,
            expectedRevision: Option.some(1),
            method: 'BANK_TRANSFER_ADVANCE',
            reason: 'Pause bank transfer',
          });
          yield* withApplicability(runtime, scope, (p) => p.configureEnablement(disable));
          const second = yield* read([{ method: 'BANK_TRANSFER_ADVANCE' }]);
          expect(second.branches).toEqual([
            {
              findings: [{ check: 'METHOD_ENABLEMENT', outcome: 'NOT_ENABLED', reason: 'DISABLED' }],
              method: 'BANK_TRANSFER_ADVANCE',
              outcome: 'NOT_ENABLED',
            },
          ]);

          // Pure Current read: no Payment intent, operation or collection is recorded.
          expect(yield* countRows(runtimeClient, scope, 'payment.payments')).toBe(0);
          expect(yield* countRows(runtimeClient, scope, 'payment.payment_operations')).toBe(0);
          expect(yield* countRows(runtimeClient, scope, 'payment.observations')).toBe(0);
          expect(paymentMethodApplicabilityRead.descriptor.entrypoint.access).toBe('read');
        }),
      ),
  );

  it.live('#1147 R1 another Tenant or Legal Entity never sees this enablement', () =>
    Effect.scoped(
      Effect.gen(function* readScopeIsolation() {
        const { runtime, runtimeClient } = yield* nativeDatabase;
        const scope = yield* makeTestScope;
        const foreign = { ...scope, legalEntityId: yield* randomUuid };
        const input = yield* configureInput(scope, {
          customerConfigurationId: 'cc-isolated',
          enabled: true,
          expectedRevision: Option.none(),
          method: 'BANK_TRANSFER_ADVANCE',
          reason: 'Enable',
        });
        yield* withApplicability(runtime, scope, (p) => p.configureEnablement(input));
        const termRef = termRefFor(foreign.tenantId, yield* randomUuid);
        const owners = applicabilityOwnerEvidenceFixture({
          codCapability: codSupported,
          enabledGatewayBindings: [],
          pickupCapability: pickupSupported,
          termUse: () => usableTerm(netDaysSnapshot(termRef, 14), 'entitlement-A'),
        });
        const harness = yield* readHarness(runtimeClient, foreign);
        const result = yield* harness.runtime
          .runRead({
            input: {
              amount: { amountMinor: 250_000, currency: 'CZK' },
              branches: [{ method: 'BANK_TRANSFER_ADVANCE' }],
              customerConfigurationId: 'cc-isolated',
              paymentTermRef: termRef,
            },
            principal: principalOf(foreign),
            registration: paymentMethodApplicabilityRead,
            transport: { correlationId: 'payment-applicability-r1-foreign' },
          })
          .pipe(Effect.provide(owners.layer));
        expect(result.branches.map(({ outcome }) => outcome)).toEqual(['NOT_ENABLED']);
        expect(owners.calls.termMethods).toEqual([]);
      }),
    ),
  );
});
