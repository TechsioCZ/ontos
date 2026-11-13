import { randomUUID } from 'node:crypto';

import {
  ActionAuthorizationPreflightDatabaseLive,
  ActiveApplicationCompositionService,
  CorePersistenceLive,
  DatabaseConfigLive,
  OntosModuleDeploymentContractSchema,
} from '@app/core-runtime';
import type { ActionRuntimeService, ActiveApplicationCompositionSnapshot, ReadRuntimeService } from '@app/core-runtime';
import {
  compositionFixtureContentDigest,
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
  sealApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Context, Crypto, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import type { Scope } from 'effect';
import { expect, it } from 'effect-rstest';

import { allowOwnerAuthorizationOverlay } from '../../../../packages/core-runtime/src/access/enforcement/owner-overlay.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import { coreRelations, tenantModuleStates } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import type { TenantModuleState } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { makeReadRuntime } from '../../../../packages/core-runtime/src/reads/runtime.ts';
import { makeScriptedBoundAccessGate } from '../../../../packages/core-runtime/src/testing/access-gate.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PaymentGatewayAccountBinding } from '../../shared/domain/payment-execution-binding.ts';
import type { PaymentGatewayProviderFamilySchema } from '../../shared/domain/payment-vocabulary.ts';
import { GatewayProviderAccountBindingIdSchema } from '../../shared/domain/psp-configuration.ts';
import { PaymentReconciliationApiKeySchema } from '../../shared/payment-gateway-relay.ts';
import { requestPaymentOperationRecoveryAction } from '../../src/actions/request-payment-operation-recovery.action.ts';
import { gatewayReconciliationDebtRead } from '../../src/api/gateway-reconciliation-debt.read.ts';
import {
  GATEWAY_RECONCILIATION_REQUESTED,
  GATEWAY_RECONCILIATION_UNAVAILABLE,
  GatewayReconciliationInvoker,
  gatewayReconciliationIdempotencyKey,
  gatewayReconciliationPayload,
  gatewayReconciliationSkipped,
} from '../../src/integrations/psp/gateway-reconciliation-invoker.ts';
import type { GatewayReconciliationOutcome } from '../../src/integrations/psp/gateway-reconciliation-invoker.ts';
import { ReconciliationCredentials } from '../../src/integrations/psp/reconciliation-credentials.ts';
import {
  GatewayReconciliationDueSource,
  GatewayReconciliationDueSourceLive,
} from '../../src/persistence/gateway-reconciliation-due.ts';
import type { GatewayReconciliationDueRow } from '../../src/persistence/gateway-reconciliation-due.ts';
import { pspPrepareDispatch, pspRecordDispatchOutcome } from '../../src/persistence/psp-worker-routines.ts';
import { makeGatewayReconciliationSweep } from '../../src/workers/gateway-reconciliation-driver.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { installPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { inScope, makeTestScope, operationalScopeOf } from './database-fixture.ts';
import type { PaymentTestScope } from './database-fixture.ts';
import {
  COMPOSITION_R1,
  evidenceAllowedPermission,
  evidenceContextAccess,
  evidenceScenarioOf,
  principalOf,
  RECOVERY_REQUESTED,
  seedCoreScope,
} from './evidence-native-support.ts';
import type { EvidenceNativeDatabase } from './evidence-native-support.ts';

/**
 * #1158 / #1153 reconciliation driver (phase 2 D-P5) on native PostgreSQL. Boundary: the production driver tick,
 * the production cross-Tenant listing and payer contact purge on the runtime role (no operational scope), and an
 * invoker that runs the REAL A10 `request-payment-operation-recovery` Action through the real Core Action runtime,
 * Payment persistence, RLS and Core's Tenant Module State gate.
 *
 * Not this boundary: the Shell `paymentReconciliation` relay and its route-scoped integration principal. Shell's
 * issuer and gateway verifier are not reachable in-process from Payment's suites, so A10 is invoked as one
 * principal per Tenant (the seeded scope principal with Core's test operational scope resolver), and A10 refusals
 * are mapped to the driver's outcomes the way the relay maps their HTTP problems. Keys are obviously fake.
 */

type Family = typeof PaymentGatewayProviderFamilySchema.Type;
const DEPLOYMENT = { appId: 'payment', buildMarker: 'payment-driver-native-build' } as const;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
const MERCHANT_IDENTITIES = {
  COMGATE: '{"_tag":"COMGATE","merchantId":"123456"}',
  GOPAY: '{"_tag":"GOPAY","goid":"8123456789"}',
  STRIPE: '{"_tag":"STRIPE","accountId":"acct_1TestAccount"}',
} as const satisfies Record<Family, string>;

const native = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeCrypto.layer));

const nativeDatabase = Effect.gen(function* driverNativeDatabase() {
  const { admin, runtime } = yield* testDatabaseClients;
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, coreRelations);
  const database = yield* makeTestDatabaseFromClient(runtime, coreRelations);
  return { admin, native: { coreAdmin, database, runtimeClient: runtime } satisfies EvidenceNativeDatabase };
});

/** Real Core runtimes whose Module State gate reads the Tenant's `core.tenant_module_states` row. */
const makeRuntimes = Effect.fn('DriverNative.runtimes')(function* makeRuntimes(database: EvidenceNativeDatabase) {
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
      ownerAuthorizationOverlay: allowOwnerAuthorizationOverlay,
      ownerRegistration: paymentRegistration,
      resolveCompositionRevision: () => Effect.succeed(COMPOSITION_R1),
    },
  );
  const reads: ReadRuntimeService = makeReadRuntime(
    { executor: database.database },
    gateway,
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
type Runtimes = Effect.Success<ReturnType<typeof makeRuntimes>>;

/** An approved composition whose `payment.core` module is this test's compiled artifact. */
const approvedSnapshot = Effect.gen(function* approvedSnapshot() {
  const fixture = yield* makeApplicationCompositionSnapshotFixture(['payment'], DEPLOYMENT.buildMarker);
  const contract = yield* Schema.decodeEffect(OntosModuleDeploymentContractSchema)(
    makeModuleContractFixture({ appId: 'payment', buildMarker: DEPLOYMENT.buildMarker, moduleId: 'payment.core' }),
  );
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const sha256 = compositionFixtureContentDigest(contractDocument);
  const composition = sealApplicationCompositionFixture({
    ...fixture.composition,
    modules: fixture.composition.modules.map((module) => ({
      ...module,
      contract: { ...module.contract, sha256 },
      contractDocument,
      moduleId: 'payment.core',
      publicContract: { ...module.publicContract, id: 'payment.core', sha256 },
    })),
  });
  return { ...fixture, composition } satisfies ActiveApplicationCompositionSnapshot;
}).pipe(Effect.orDie);

interface Debt {
  readonly family: Family;
  readonly operationId: string;
  readonly paymentId: string;
  readonly scope: PaymentTestScope;
}

/** One Tenant with its Selling Legal Entity, Core identity rows and Payment Module State. */
const tenantIn = Effect.fn('DriverNative.tenant')(function* tenantIn(
  database: EvidenceNativeDatabase,
  prefix: string,
  state: TenantModuleState,
) {
  const base = yield* makeTestScope;
  const scope: PaymentTestScope = { ...base, tenantId: `${prefix}${base.tenantId.slice(8)}` };
  yield* seedCoreScope(database, scope);
  yield* database.coreAdmin
    .insert(tenantModuleStates)
    .values({ moduleKey: 'payment.core', state, tenantId: scope.tenantId });
  return scope;
});

/** One CURRENT binding with its credential and route, as the configuration Action writes them. */
const gatewayBinding = Effect.fn('DriverNative.binding')(function* gatewayBinding(
  database: EvidenceNativeDatabase,
  scope: PaymentTestScope,
  family: Family,
) {
  const { runtimeClient } = database;
  const [refSeed, routeSeed] = [randomUUID(), randomUUID()];
  const bindingId = yield* Schema.decodeEffect(GatewayProviderAccountBindingIdSchema)(randomUUID());
  const accountRef = `pab_${refSeed.replaceAll('-', '')}`;
  const routeKey = `${routeSeed.replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`.slice(0, 43);
  yield* inScope(
    runtimeClient,
    scope,
    Effect.all(
      [
        runtimeClient.unsafe(
          `insert into payment.psp_provider_account_bindings (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, configured_at, current_credential_revision,
             environment, merchant_identity, notification_url, provider_account_ref, provider_family, reason, revision, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'SANDBOX', $6::jsonb,
             'https://hooks.example.test/psp', $7, $8, 'Configure the sandbox gateway account', 1, 'CURRENT')`,
          [
            scope.tenantId,
            scope.legalEntityId,
            scope.principalId,
            COMPOSITION_R1,
            bindingId,
            MERCHANT_IDENTITIES[family],
            accountRef,
            family,
          ],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_credential_revisions (tenant_id, legal_entity_id, action_invocation_id,
             actor_principal_id, composition_revision, binding_id, recorded_at, revision, secret_ref, status)
           values ($1, $2, gen_random_uuid(), $3, $4, $5, now(), 1, 'sandbox-credential-1', 'ACTIVE')`,
          [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_R1, bindingId],
        ),
        runtimeClient.unsafe(
          `insert into payment.psp_binding_routes (tenant_id, legal_entity_id, binding_id, route_key, provider_family, environment)
           values ($1, $2, $3, $4, $5, 'SANDBOX')`,
          [scope.tenantId, scope.legalEntityId, bindingId, routeKey, family],
        ),
      ],
      { concurrency: 1 },
    ),
  );
  const binding: PaymentGatewayAccountBinding = {
    _tag: 'GATEWAY_ACCOUNT',
    environment: 'SANDBOX',
    providerAccountRef: accountRef,
    providerFamily: family,
  };
  return { binding, bindingId, family };
});
type GatewayBinding = Effect.Success<ReturnType<typeof gatewayBinding>>;

/** One CURRENT routed binding per provider family of the scope (a Legal Entity has one per family). */
const bindingsOf = (database: EvidenceNativeDatabase, scope: PaymentTestScope, families: readonly Family[]) =>
  Effect.forEach([...new Set(families)], (family) => gatewayBinding(database, scope, family), { concurrency: 1 }).pipe(
    Effect.map((bindings) => new Map(bindings.map((binding) => [binding.family, binding]))),
  );

/** A gateway COLLECT through `gateway` whose dispatch outcome is unknown, as A4 and the executor write them. */
const unknownCollect = Effect.fn('DriverNative.unknownCollect')(function* unknownCollect(
  database: EvidenceNativeDatabase,
  runtimes: Runtimes,
  scope: PaymentTestScope,
  gateway: GatewayBinding | undefined,
) {
  if (gateway === undefined) {
    return yield* Effect.die('The test binding of this family was not created');
  }
  const { binding, bindingId, family } = gateway;
  const deliveryId = randomUUID();
  const evidence = evidenceScenarioOf({ native: database, r1: runtimes, r2: runtimes, scope });
  const payment = yield* evidence.createPayment(100_000, binding);
  const collect = yield* evidence.startOperation({
    amountMinor: 100_000,
    binding,
    operationKey: 'collect-driver',
    paymentId: payment.paymentId,
  });
  const origin = {
    compositionRevision: COMPOSITION_R1,
    deliveryId,
    originActionInvocationId: collect.provenance.actionInvocationId,
    workerKey: 'payment.core.execute-gateway-operation',
  };
  yield* database.database.transaction((transaction) =>
    installOperationalScope(transaction, operationalScopeOf(scope)).pipe(
      Effect.flatMap((invoker) =>
        pspPrepareDispatch(invoker, {
          bindingId,
          credentialRevision: 1,
          endpointRef: `${family.toLowerCase()}:request`,
          idempotencyKeyHash: Option.none(),
          materialHash: collect.materialHash,
          operationId: collect.operationId,
          origin,
          providerPaymentRef: Option.none(),
          refundBaseline: Option.none(),
          refundDispatchCount: Option.none(),
          replayRequest: Option.none(),
          requestHash: 'a'.repeat(64),
          returnToken: Option.none(),
        }).pipe(
          Effect.andThen(
            pspRecordDispatchOutcome(invoker, {
              customerRedirectUrl: Option.none(),
              deliveryId,
              operationId: collect.operationId,
              providerPaymentRef: Option.none(),
              providerRefundRef: Option.none(),
              to: 'OUTCOME_UNKNOWN',
            }),
          ),
        ),
      ),
    ),
  );
  return { family, operationId: collect.operationId, paymentId: payment.paymentId, scope } satisfies Debt;
});

/**
 * The real listing on the runtime role, started right before this test's Tenants and cut at the first row of
 * another Tenant, so concurrent suites' debt on the shared database never takes this test's budget.
 */
const ownedDueSource = Effect.fn('DriverNative.dueSource')(function* ownedDueSource(prefix: string) {
  const context = yield* Layer.build(
    GatewayReconciliationDueSourceLive.pipe(
      Layer.provide(ActionAuthorizationPreflightDatabaseLive),
      Layer.provide(CorePersistenceLive),
      Layer.provide(DatabaseConfigLive),
    ),
  );
  const live = Context.get(context, GatewayReconciliationDueSource);
  const start = Option.some({
    legalEntityId: ZERO_UUID,
    operationId: ZERO_UUID,
    tenantId: `${prefix}-0000-0000-0000-000000000000`,
  });
  return GatewayReconciliationDueSource.of({
    listDue: (input) =>
      live
        .listDue({ ...input, after: Option.isNone(input.after) ? start : input.after })
        .pipe(Effect.map((rows) => rows.filter((row) => row.tenantId.startsWith(prefix)))),
    purgeExpiredPayerContacts: live.purgeExpiredPayerContacts,
  });
});

interface A10Refusal {
  readonly _tag: string;
  readonly code?: unknown;
}

/** An A10 refusal as the Shell relay reports it to the driver (409 code, 403, or 503 for everything else). */
const outcomeOfRefusal = (error: A10Refusal): GatewayReconciliationOutcome =>
  Match.value(error).pipe(
    Match.when({ _tag: 'ModuleStateDeniedError' }, () => gatewayReconciliationSkipped('module_state')),
    Match.when({ _tag: 'ActionRequestHashConflict' }, () => gatewayReconciliationSkipped('hash_conflict')),
    Match.when({ _tag: 'ActionAlreadyCommitted' }, () => gatewayReconciliationSkipped('hash_conflict')),
    Match.when({ code: 'payment_recovery_operation_already_resolved' }, () =>
      gatewayReconciliationSkipped('already_resolved'),
    ),
    Match.when({ code: 'payment_held_for_reconciliation' }, () => gatewayReconciliationSkipped('held')),
    Match.orElse(() => GATEWAY_RECONCILIATION_UNAVAILABLE),
  );

const outcomeOfRecovery = (effect: Effect.Effect<unknown, A10Refusal>) =>
  effect.pipe(Effect.match({ onFailure: outcomeOfRefusal, onSuccess: () => GATEWAY_RECONCILIATION_REQUESTED }));

interface DriverSetup {
  readonly failFamily?: Family;
}

/** The production driver tick over the native listing and an in-process A10 invoker. */
const makeDriver = Effect.fn('DriverNative.driver')(function* makeDriver(
  runtimes: Runtimes,
  scopes: readonly PaymentTestScope[],
  prefix: string,
  setup: DriverSetup = {},
) {
  const principals = new Map(scopes.map((scope) => [scope.tenantId, scope]));
  const dueSource = yield* ownedDueSource(prefix);
  const fakeKey = Redacted.make(Schema.decodeUnknownSync(PaymentReconciliationApiKeySchema)('fake-native-driver-key'));
  const layer = Layer.mergeAll(
    Layer.succeed(ActiveApplicationCompositionService, { load: approvedSnapshot }),
    Layer.succeed(GatewayReconciliationDueSource, dueSource),
    Layer.succeed(
      ReconciliationCredentials,
      ReconciliationCredentials.of({
        load: Effect.succeed({
          forTenant: (tenantId: string) =>
            Effect.succeed(principals.has(tenantId) ? Option.some(fakeKey) : Option.none()),
        }),
      }),
    ),
    Layer.succeed(
      GatewayReconciliationInvoker,
      GatewayReconciliationInvoker.of({
        request: (row: GatewayReconciliationDueRow) => {
          const scope = principals.get(row.tenantId);
          if (scope === undefined || row.providerFamily === setup.failFamily) {
            return Effect.succeed(GATEWAY_RECONCILIATION_UNAVAILABLE);
          }
          return outcomeOfRecovery(
            runtimes.actions.runAction({
              payload: gatewayReconciliationPayload(row),
              principal: principalOf({ ...scope, legalEntityId: row.legalEntityId }),
              registration: requestPaymentOperationRecoveryAction,
              transport: {
                correlationId: 'payment-reconciliation-driver-native',
                idempotencyKey: gatewayReconciliationIdempotencyKey(row),
              },
            }),
          );
        },
      }),
    ),
  );
  return yield* makeGatewayReconciliationSweep(DEPLOYMENT).pipe(Effect.provide(layer));
});

const recoveryCount = (admin: PgClient.PgClient, operationId: string) =>
  admin
    .unsafe<{ count: number }>(
      'select count(*)::integer as count from payment.recovery_requests where operation_id = $1',
      [operationId],
    )
    .pipe(Effect.map(([row]) => row?.count ?? -1));

const recoveryMessages = (admin: PgClient.PgClient, operationId: string) =>
  admin
    .unsafe<{ count: number }>(
      `select count(*)::integer as count from core.outbox_messages
       where producer_module_key = 'payment.core' and topic = $1 and payload_json->>'operationId' = $2`,
      [RECOVERY_REQUESTED, operationId],
    )
    .pipe(Effect.map(([row]) => row?.count ?? -1));

/** The public debt Read of the scope, as a person sees it. */
const debtOperations = (runtimes: Runtimes, scope: PaymentTestScope) =>
  runtimes.reads
    .runRead({
      input: { limit: 200 },
      principal: principalOf(scope),
      registration: gatewayReconciliationDebtRead,
      transport: { correlationId: 'payment-reconciliation-driver-debt' },
    })
    .pipe(Effect.map((page) => page.rows.map((row) => row.operationId)));

const prefixOf = () => randomUUID().slice(0, 8);

it.live('#1158 two concurrent driver ticks over the same debt create exactly one recovery and one Outbox message', () =>
  native(
    Effect.gen(function* concurrentDrivers() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const { admin, native: database } = yield* nativeDatabase;
      const runtimes = yield* makeRuntimes(database);
      const prefix = prefixOf();
      const scope = yield* tenantIn(database, prefix, 'active');
      const families = ['STRIPE', 'STRIPE', 'GOPAY'] as const;
      const bindings = yield* bindingsOf(database, scope, families);
      const debts = yield* Effect.forEach(
        families,
        (family) => unknownCollect(database, runtimes, scope, bindings.get(family)),
        { concurrency: 1 },
      );
      const first = yield* makeDriver(runtimes, [scope], prefix);
      const second = yield* makeDriver(runtimes, [scope], prefix);

      const [one, two] = yield* Effect.all([first.sweep, second.sweep], { concurrency: 2 });
      expect(one.listed + two.listed).toBe(6);
      for (const debt of debts) {
        expect(yield* recoveryCount(admin, debt.operationId)).toBe(1);
        expect(yield* recoveryMessages(admin, debt.operationId)).toBe(1);
      }
      // The committed round now waits for its backoff: a third tick lists nothing and requests nothing.
      const third = yield* first.sweep;
      expect([third.listed, third.requested]).toEqual([0, 0]);
      for (const debt of debts) {
        expect(yield* recoveryCount(admin, debt.operationId)).toBe(1);
      }
    }),
  ),
);

it.live('#1153 a read-only Payment module gets no recovery, and its debt Read still lists the operation', () =>
  native(
    Effect.gen(function* readOnlyModule() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const { admin, native: database } = yield* nativeDatabase;
      const runtimes = yield* makeRuntimes(database);
      const prefix = prefixOf();
      const scope = yield* tenantIn(database, prefix, 'active');
      const bindings = yield* bindingsOf(database, scope, ['STRIPE']);
      const debt = yield* unknownCollect(database, runtimes, scope, bindings.get('STRIPE'));
      yield* admin.unsafe(
        "update core.tenant_module_states set state = 'read_only' where tenant_id = $1 and module_key = 'payment.core'",
        [scope.tenantId],
      );
      const { sweep } = yield* makeDriver(runtimes, [scope], prefix);
      const result = yield* sweep;
      expect(result).toMatchObject({ listed: 1, requested: 0, skipped: 1 });
      expect(yield* recoveryCount(admin, debt.operationId)).toBe(0);
      expect(yield* debtOperations(runtimes, scope)).toContain(debt.operationId);
      // The refused Tenant is cooled down: the next tick sends nothing for it.
      const next = yield* sweep;
      expect([next.requested, next.skipped, next.deferred]).toEqual([0, 0, 1]);
    }),
  ),
);

it.live('#1158 an operation out of rounds is no longer listed, and its debt Read still lists it', () =>
  native(
    Effect.gen(function* roundsExhausted() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const { admin, native: database } = yield* nativeDatabase;
      const runtimes = yield* makeRuntimes(database);
      const prefix = prefixOf();
      const scope = yield* tenantIn(database, prefix, 'active');
      const bindings = yield* bindingsOf(database, scope, ['COMGATE']);
      const debt = yield* unknownCollect(database, runtimes, scope, bindings.get('COMGATE'));
      // 24 recovery requests, the last one two days ago: past every backoff, out of the 24-round budget.
      yield* admin.unsafe(
        `insert into payment.recovery_requests (tenant_id, legal_entity_id, action_invocation_id, actor_principal_id,
           composition_revision, binding_snapshot, mode, operation_id, payment_id, reason, requested_at)
         select $1, $2, gen_random_uuid(), $3, $4, '{}'::jsonb, 'AUTHORITATIVE_LOOKUP', $5, $6,
           'Gateway reconciliation test round', now() - interval '2 days' - make_interval(hours => round)
         from generate_series(1, 24) as round`,
        [scope.tenantId, scope.legalEntityId, scope.principalId, COMPOSITION_R1, debt.operationId, debt.paymentId],
      );
      const { sweep } = yield* makeDriver(runtimes, [scope], prefix);
      const result = yield* sweep;
      expect([result.listed, result.requested]).toEqual([0, 0]);
      expect(yield* recoveryCount(admin, debt.operationId)).toBe(24);
      expect(yield* debtOperations(runtimes, scope)).toContain(debt.operationId);
    }),
  ),
);

it.live('#1158 H1094-01=A an unavailable GoPay path does not stop Stripe rows of the same Tenant', () =>
  native(
    Effect.gen(function* providerIsolation() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const { admin, native: database } = yield* nativeDatabase;
      const runtimes = yield* makeRuntimes(database);
      const prefix = prefixOf();
      const scope = yield* tenantIn(database, prefix, 'active');
      const families = ['GOPAY', 'STRIPE', 'GOPAY', 'STRIPE'] as const;
      const bindings = yield* bindingsOf(database, scope, families);
      const debts = yield* Effect.forEach(
        families,
        (family) => unknownCollect(database, runtimes, scope, bindings.get(family)),
        { concurrency: 1 },
      );
      const { sweep } = yield* makeDriver(runtimes, [scope], prefix, { failFamily: 'GOPAY' });
      const result = yield* sweep;
      expect(result.requested).toBe(2);
      expect(result.unavailable).toBeGreaterThanOrEqual(1);
      const listed = yield* debtOperations(runtimes, scope);
      for (const debt of debts) {
        expect(yield* recoveryCount(admin, debt.operationId)).toBe(debt.family === 'STRIPE' ? 1 : 0);
        // Unresolved debt stays visible whatever the driver did (#1153); nothing is forced DONE.
        expect(listed).toContain(debt.operationId);
      }
    }),
  ),
);

it.live('#1157 the tick purges payer contacts older than 48 hours and keeps younger ones', () =>
  native(
    Effect.gen(function* payerContactPurge() {
      yield* installPaymentTestCompositionAuthority(COMPOSITION_R1);
      const { admin, native: database } = yield* nativeDatabase;
      const runtimes = yield* makeRuntimes(database);
      const prefix = prefixOf();
      const scope = yield* tenantIn(database, prefix, 'active');
      const bindings = yield* bindingsOf(database, scope, ['COMGATE']);
      const [expired, recent] = yield* Effect.forEach(
        [1, 2],
        () => unknownCollect(database, runtimes, scope, bindings.get('COMGATE')),
        { concurrency: 1 },
      );
      for (const debt of [expired, recent]) {
        yield* inScope(
          database.runtimeClient,
          scope,
          database.runtimeClient.unsafe(
            `insert into payment.psp_operation_payer_contacts (tenant_id, legal_entity_id, operation_id, full_name, email)
             values ($1, $2, $3, 'Test Payer', 'payer@example.test') on conflict do nothing`,
            [scope.tenantId, scope.legalEntityId, debt?.operationId ?? ZERO_UUID],
          ),
        );
      }
      yield* admin.unsafe(
        `update payment.psp_operation_payer_contacts
         set created_at = case when operation_id = $1 then now() - interval '49 hours' else now() - interval '47 hours' end
         where operation_id in ($1, $2)`,
        [expired?.operationId ?? ZERO_UUID, recent?.operationId ?? ZERO_UUID],
      );
      const { sweep } = yield* makeDriver(runtimes, [scope], prefix);
      const result = yield* sweep;
      expect(result.purged).toBeGreaterThanOrEqual(1);
      const remaining = yield* admin.unsafe<{ operation_id: string }>(
        'select operation_id::text from payment.psp_operation_payer_contacts where operation_id in ($1, $2)',
        [expired?.operationId ?? ZERO_UUID, recent?.operationId ?? ZERO_UUID],
      );
      expect(remaining.map((row) => row.operation_id)).toEqual([recent?.operationId]);
    }),
  ),
);
