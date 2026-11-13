import { fileURLToPath } from 'node:url';

import { DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { NodeChildProcessSpawner, NodeServices } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Context, Crypto, Effect, Layer, Result, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import {
  TenantAccessBootstrap,
  TenantAccessBootstrapLive,
} from '../../../../packages/core-runtime/src/access/bootstrap/index.ts';
import { AccessChangesStoreLive } from '../../../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import {
  LegalEntityIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../../../packages/core-runtime/src/access/ids.ts';
import { AccessCatalogSnapshotWriterLive } from '../../../../packages/core-runtime/src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../../../packages/core-runtime/src/access/intent/memberships.ts';
import { AccessProjectionCompiler } from '../../../../packages/core-runtime/src/access/intent/projection-compiler.ts';
import {
  AccessProjectionWriter,
  AccessProjectionWriterLive,
} from '../../../../packages/core-runtime/src/access/intent/projection-writer.ts';
import { AccessWriteJournalStoreLive } from '../../../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { ActionPermissionDenied } from '../../../../packages/core-runtime/src/actions/errors.ts';
import { makeActionRepository } from '../../../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../../../packages/core-runtime/src/actions/runtime.ts';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  TenantIntentLoaderLive,
} from '../../../../packages/core-runtime/src/actions/runtime-wiring.ts';
import { CoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import { accessDecisionLogs, domainEvents, outboxMessages } from '../../../../packages/core-runtime/src/db/schema.ts';
import { makeModuleEntrypointGateway } from '../../../../packages/core-runtime/src/modules/module-entrypoint-gateway.ts';
import { makeModuleStateGate } from '../../../../packages/core-runtime/src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../../../packages/core-runtime/src/modules/tenant-module-state-service.ts';
import { bindLiveAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../../../packages/core-runtime/src/permissions/schema.ts';
import { newSpiceDbGrpcClient } from '../../../../packages/core-runtime/src/permissions/spicedb-grpc-rpc.ts';
import { testOperationalScopeResolver } from '../../../../packages/core-runtime/tests/fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../../../../packages/core-runtime/tests/support/action-runtime-options.ts';
import {
  createTemplateDatabase,
  dropDatabase,
  replacedDatabase,
} from '../../../../packages/core-runtime/tests/support/access-scenarios/database.ts';
import {
  insertAssignment,
  insertMembership,
  insertRoleWithCells,
  legalEntityScopeIdOf,
  scopeOf,
  seedTenantRows,
  tenantScopeIdOf,
} from '../../../../packages/core-runtime/tests/support/access-scenarios/scenario.ts';
import {
  makeTestDatabaseFromClient,
  makeTestPgClient,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { requestPaymentRefundAction } from '../../src/actions/request-payment-refund.action.ts';
import { CommitmentOutcomePort, unavailableCommitmentOutcome } from '../../src/ports/commitment-outcome-port.ts';
import { paymentRegistration } from '../../vertical.registration.ts';
import { refundItem } from '../support/refund-action-driver.ts';
import { loadPaymentAggregate, seedGatewayRefundRoute, seedPayment } from '../support/refund-native-runtime.ts';
import { refundableItemsPublicContractFixture } from '../support/refund-owner-evidence.fixture.ts';
import { publishPaymentTestCompositionAuthority } from './composition-authority-fixture.ts';
import { makeTestScope, paymentTestRelations, randomUuid, COMPOSITION_REVISION } from './database-fixture.ts';
import type { PaymentTestDatabase } from './database-fixture.ts';

const refundDescriptor = requestPaymentRefundAction.descriptor;
const moduleKey = refundDescriptor.owningModuleKey;
const refundCapability = 'payment.core.refund.request';

/** The catalog is global within a database, so this test publishes only to its disposable database. */
const staffDatabase = Effect.gen(function* staffDatabase() {
  const connections = yield* loadDatabaseConnectionPair();
  const databaseName = `refund_staff_${(yield* randomUuid).replaceAll('-', '')}`;
  const clusterAdmin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* Effect.acquireRelease(clusterAdmin.unsafe(`create database "${databaseName}"`), () =>
    dropDatabase(clusterAdmin, databaseName),
  );
  const adminConnection = replacedDatabase(connections.admin.connectionString, databaseName);
  const runtimeConnection = replacedDatabase(connections.runtime.connectionString, databaseName);
  const admin = yield* makeTestPgClient(adminConnection);
  yield* createTemplateDatabase(admin);
  const migration = yield* ChildProcess.make(
    fileURLToPath(new URL('../../node_modules/.bin/drizzle-kit', import.meta.url)),
    ['migrate', '--config', 'drizzle.config.ts'],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { DATABASE_ADMIN_URL: adminConnection, DATABASE_URL: runtimeConnection },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [migrationExit] = yield* Effect.all(
    [migration.exitCode, Stream.runDrain(migration.stdout), Stream.runDrain(migration.stderr)],
    { concurrency: 3 },
  );
  expect(migrationExit).toBe(0);
  // A gateway REFUND is completion-bound executor work of the admitting revision (#1158).
  yield* publishPaymentTestCompositionAuthority(admin, COMPOSITION_REVISION);
  const coreAdmin = yield* makeTestDatabaseFromClient(admin, paymentTestRelations);
  const runtime = yield* makeTestPgClient(runtimeConnection);
  const database = yield* makeTestDatabaseFromClient(runtime, paymentTestRelations);
  return { admin, coreAdmin, database };
});

/** The production Core access layers, with disposable PostgreSQL and the integration SpiceDB. */
const realStaffAuthorization = Effect.fn('RefundStaffTarget.realAuthorization')(function* realStaffAuthorization(
  database: PaymentTestDatabase,
) {
  const configuration = yield* loadSpiceDbConfig();
  yield* Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.promise(() => client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }))),
    (client) => Effect.sync(() => client.close()),
  );
  const compiler = makeAccessProjectionCompiler(makeAccessProjectionTransport(configuration));
  const platform = Layer.mergeAll(
    Layer.succeed(CoreDatabase, { executor: database }),
    Layer.succeed(AccessProjectionCompiler, compiler),
  );
  const stores = Layer.mergeAll(
    TenantIntentLoaderLive,
    AccessWriteJournalStoreLive,
    AccessChangesStoreLive,
    AccessMembershipStoreLive,
  ).pipe(Layer.provideMerge(platform));
  const writers = Layer.mergeAll(AccessCatalogSnapshotWriterLive, AccessProjectionWriterLive).pipe(
    Layer.provideMerge(stores),
  );
  const services = yield* Layer.build(
    Layer.mergeAll(
      TenantAccessBootstrapLive,
      AccessDecisionLive.pipe(Layer.provideMerge(AccessEnforcementPortsLive)),
    ).pipe(Layer.provideMerge(writers)),
  );
  return {
    accessDecision: yield* bindLiveAccessGate.pipe(Effect.provideContext(services)),
    bootstrap: Context.get(services, TenantAccessBootstrap),
    writer: Context.get(services, AccessProjectionWriter),
  };
});

it.live('#1153 staff REFUND authorizes the exact Payment in a same-entity target set', () =>
  Effect.scoped(
    Effect.gen(function* exactStaffRefund() {
      const { admin, coreAdmin, database } = yield* staffDatabase;
      const { legalEntityId, principalId: ownerId, tenantId: tenant } = yield* makeTestScope;
      const [restrictedId, broadId] = yield* Effect.all([randomUuid, randomUuid], { concurrency: 1 });
      const tenantId = TenantIdSchema.make(tenant);
      yield* seedTenantRows(admin, {
        legalEntityIds: [legalEntityId],
        moduleKeys: [moduleKey],
        principals: [ownerId, restrictedId, broadId].map((principalId) => ({ kind: 'human', principalId })),
        tenantId,
      });
      const owner = yield* scopeOf({ principalId: ownerId, tenantId });
      const { accessDecision, bootstrap, writer } = yield* realStaffAuthorization(database);
      const { catalogSnapshotId } = yield* bootstrap.bootstrapTenantAccess({
        legalEntityIds: [LegalEntityIdSchema.make(legalEntityId)],
        modules: [{ descriptors: [refundDescriptor], moduleId: moduleKey }],
        scope: owner,
      });
      const scopeId = yield* legalEntityScopeIdOf(admin, tenantId, legalEntityId);
      const tenantScopeId = yield* tenantScopeIdOf(admin, tenantId);
      const ownerScope = { legalEntityId, principalId: ownerId, tenantId };
      const paymentA = yield* seedPayment(database, ownerScope, { amountMinor: 100_000, collected: true });
      const paymentB = yield* seedPayment(database, ownerScope, { amountMinor: 100_000, collected: true });
      yield* seedGatewayRefundRoute(database, ownerScope);

      const grant = Effect.fn('RefundStaffTarget.grant')(function* grant(
        principalId: string,
        selector: NonNullable<Parameters<typeof insertRoleWithCells>[2]['selector']>,
      ) {
        const [roleId, roleRevisionId, incarnationId] = yield* Effect.all([randomUuid, randomUuid, randomUuid], {
          concurrency: 1,
        });
        yield* insertMembership(admin, tenantId, {
          kind: 'member',
          principalId,
          recordedBy: ownerId,
          scopeId: tenantScopeId,
        });
        yield* insertMembership(admin, tenantId, { kind: 'member', principalId, recordedBy: ownerId, scopeId });
        yield* insertRoleWithCells(admin, tenantId, {
          capabilityKeys: [refundCapability],
          catalogSnapshotId,
          createdBy: ownerId,
          legalEntityId,
          roleId,
          roleRevisionId,
          scopeId,
          selector,
        });
        yield* insertAssignment(admin, tenantId, {
          assignedBy: ownerId,
          incarnationId,
          principalId,
          roleId,
          roleRevisionId,
          scopeId,
        });
      });
      yield* grant(restrictedId, { _tag: 'targets', recordKeys: [RecordKeySchema.make(paymentA.paymentId)] });
      yield* grant(broadId, { _tag: 'all' });
      yield* writer.reconcileTenant({ scope: owner });

      const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService({ executor: coreAdmin }));
      const actionRuntime = makeActionRuntime(
        { executor: database },
        makeActionRepository(yield* Crypto.Crypto),
        { checkActionPermission: () => Effect.die('Staff REFUND must use the real Core access gate') },
        testOperationalScopeResolver,
        {
          ...openActionRuntimeOptions,
          accessDecision,
          moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
          moduleStateGate,
          ownerRegistration: paymentRegistration,
          resolveCompositionRevision: () => Effect.succeed(COMPOSITION_REVISION),
        },
      );
      const refund = Effect.fn('RefundStaffTarget.request')(function* refund(
        payment: Effect.Success<ReturnType<typeof seedPayment>>,
        principalId: string,
        operationKey: string,
      ) {
        const item = refundItem('one-complete-item', 40_000);
        const principal = yield* scopeOf({ legalEntityId, principalId, tenantId });
        return yield* actionRuntime
          .runAction({
            payload: {
              amount: { amountMinor: item.amountMinor, currency: item.currency },
              basis: { _tag: 'REFUNDABLE_ITEMS', items: [item] },
              operationKey,
              paymentId: payment.paymentId,
              reason: 'Customer returned a complete item',
            },
            principal,
            registration: requestPaymentRefundAction,
            transport: { correlationId: operationKey, idempotencyKey: yield* randomUuid },
          })
          .pipe(
            Effect.provide(
              Layer.merge(
                refundableItemsPublicContractFixture({
                  items: [item],
                  purchaseCorrelationId: payment.purchaseCorrelationId,
                  scope: { legalEntityId, tenantId },
                }),
                Layer.succeed(CommitmentOutcomePort, unavailableCommitmentOutcome),
              ),
            ),
          );
      });

      const denied = yield* Effect.result(refund(paymentB, restrictedId, 'refund-denied-b'));
      expect(Result.isFailure(denied) && Schema.is(ActionPermissionDenied)(denied.failure)).toBe(true);
      expect((yield* loadPaymentAggregate(database, ownerScope, paymentB.paymentId)).operations).toHaveLength(1);
      expect(yield* coreAdmin.select().from(domainEvents).where(eq(domainEvents.tenantId, tenantId))).toHaveLength(0);
      expect(yield* coreAdmin.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId))).toHaveLength(
        0,
      );

      const exact = yield* refund(paymentA, restrictedId, 'refund-exact-a');
      const broad = yield* refund(paymentB, broadId, 'refund-broad-b');
      expect(exact.operation).toMatchObject({ kind: 'REFUND', outcome: 'PENDING' });
      expect(broad.operation).toMatchObject({ kind: 'REFUND', outcome: 'PENDING' });
      const staffDecisions = yield* coreAdmin
        .select({ outcome: accessDecisionLogs.outcome, target: accessDecisionLogs.scopeTarget })
        .from(accessDecisionLogs)
        .where(
          and(
            eq(accessDecisionLogs.tenantId, tenantId),
            eq(accessDecisionLogs.actorPrincipalId, restrictedId),
            eq(accessDecisionLogs.capabilityKey, refundCapability),
          ),
        );
      expect(staffDecisions).toEqual(
        expect.arrayContaining([
          { outcome: 'ALLOWED', target: paymentA.paymentId },
          { outcome: 'DENIED', target: paymentB.paymentId },
        ]),
      );
    }),
  ).pipe(
    Effect.provideService(DatabaseIdentityEnrollmentContext, defineDatabaseIdentityEnrollment([])),
    Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
