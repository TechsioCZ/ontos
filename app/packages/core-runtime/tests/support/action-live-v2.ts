import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { and, eq, inArray } from 'drizzle-orm';
import { integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { Context, Crypto, Effect, Function as Fn, Layer, Option, Redacted, Schema } from 'effect';

import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import {
  AccessChangesStoreLive,
  makeAccessChangesDrizzleStore,
} from '../../src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { projectionUnitKeyText, unitOfRelationship } from '../../src/access/compiler/relationship.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { slotTagOf } from '../../src/access/decision/selector.ts';
import { AccessDecisionGate } from '../../src/access/enforcement/contract.ts';
import { AccessPrincipalKindSourceLive } from '../../src/access/enforcement/actor.ts';
import { AccessDecisionLogLive } from '../../src/access/enforcement/decision-log.ts';
import { enginePortOf } from '../../src/access/enforcement/enforcement-live.ts';
import { AccessIntentLive } from '../../src/access/enforcement/intent-reader.ts';
import { LegalEntityCandidatesLive } from '../../src/access/enforcement/legal-entities.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { callerTransactions, requestTransactions } from '../../src/access/intent/persistence.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import {
  TenantIntentLoaderLive,
  makeJoinedTenantIntentLoader,
  makeTenantIntentLoader,
} from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import {
  AccessScopeIdSchema,
  CapabilityKeySchema,
  LegalEntityIdSchema,
  PrincipalIdSchema,
  RecordKeySchema,
  TenantIdSchema,
} from '../../src/access/ids.ts';
import { CellSchema } from '../../src/access/model.ts';
import type { Cell } from '../../src/access/model.ts';
import {
  ActionApprovalLifecycleV2Ports,
  makeActionApprovalLifecycleV2,
} from '../../src/access/approvals/action-lifecycle-v2.ts';
import {
  MandateDispatchPorts,
  makeDrizzleActionMandateDispatch,
} from '../../src/access/approvals/action-mandate-dispatch.ts';
import { makeDrizzleApprovalStore, makeJoinedDrizzleApprovalStore } from '../../src/access/approvals/drizzle-store.ts';
import { makeDrizzleFrozenCommandStore } from '../../src/access/approvals/frozen-command-drizzle-store.ts';
import type { LiveApprovalServices } from '../../src/access/approvals/live-composition.ts';
import { liveApprovalsService } from '../../src/access/approvals/service.ts';
import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { defineAction, defineActionAccessTargets } from '../../src/actions/definition.ts';
import { defineActionGoverningRead } from '../../src/actions/governing-read.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { CoreDatabase, makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConnectionPair, loadDatabaseIdentityConnections } from '../../src/db/config.ts';
import type { DatabaseIdentityConnections } from '../../src/db/config.ts';
import type { DatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import type {
  ActiveApplicationCompositionServiceContract,
  ActiveApplicationCompositionSnapshot,
} from '../../src/modules/active-application-composition.ts';
import type { OntosDeploymentIdentitySchema } from '../../src/modules/manifest.ts';
import type { VerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { OperationalScopeResolver } from '../../src/operations/context.ts';
import type { OperationalScopeResolverLive } from '../../src/operations/context.ts';
import { OwnerActionApprovalApi } from '../../src/access/approvals/owner-api.ts';
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '../../src/auth/staff-authentication-namespace.ts';
import { makeContextAccessLive } from '../../src/permissions/context-access.ts';
import { NativeHumanSessionsFactory, NativeHumanSessionFixtureError } from './native-human-sessions.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import type { CoreTransaction } from '../../src/db/types.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { makeModuleEntrypointGateway } from '../../src/modules/module-entrypoint-gateway.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeModuleStateGate } from '../../src/modules/module-state-gate.ts';
import { makeTenantModuleStateService } from '../../src/modules/tenant-module-state-service.ts';
import { AccessEnforcementPortsLive, bindLiveActionAccessGate } from '../../src/operations/access-gate.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { newSpiceDbGrpcClient, openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { publishTestApplicationCompositionAuthority } from '../../src/testing/owner-evidence.ts';
import { readFor } from './action-command-v2.ts';
import { makeTestOperationOwner } from './action-runtime-options.ts';
import { createTemplateDatabase, dropDatabase, replacedDatabase } from './access-scenarios/database.ts';
import {
  insertAssignment,
  insertMembership,
  legalEntityScopeIdOf,
  tenantScopeIdOf,
} from './access-scenarios/scenario.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT as enrollment } from './database-identities.ts';
import { makeTestPgClient } from './database.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';

const moduleKey = 'demo.native-full-command';
export const nativeV2Keys = {
  action: `${moduleKey}.record.change`,
  read: `${moduleKey}.record.read`,
  readField: `${moduleKey}.record.read-salary`,
  writeField: `${moduleKey}.record.write-salary`,
};
const records = pgTable('native_action_v2_records', {
  companyId: uuid('company_id').notNull(),
  recordKey: text('record_key').primaryKey(),
  salary: integer('salary').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  version: integer('version').notNull(),
});
const payloadSchema = Schema.Struct({
  ids: Schema.Array(RecordKeySchema),
  salary: Schema.Number,
  version: Schema.Int,
});
class OwnerWriteError extends Schema.TaggedError<OwnerWriteError>()('NativeV2OwnerWriteError', {
  reason: Schema.String,
}) {}
interface OwnerServices {
  readonly transaction: ScopedTransactionExecutor;
}
const noDomainEvents = {};
type OwnerContext = ActionHandlerContext<typeof noDomainEvents, OwnerServices>;
const encodeCells = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellSchema)));
const encodeCell = Schema.encodeSync(Schema.fromJsonString(CellSchema));

/** The ORIGINAL owner definitions. Calling this factory allocates no database, identity, role or grant. */
export const makeNativeActionV2Owner = (executions: { value: number }) => {
  const read = readFor(moduleKey);
  const action = defineAction(
    {
      accessDeclaration: {
        key: nativeV2Keys.action,
        kind: 'action',
        modes: ['run', 'propose', 'approve'],
        placement: { group: 'records', level: 'basic' },
        risk: 'sensitive',
        selectors: ['all'],
      },
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${moduleKey}.evidence.v1` },
      accessFieldGroups: [
        {
          fieldClass: 'salaries',
          fields: ['salary'],
          key: nativeV2Keys.writeField,
          kind: 'field_write',
          modes: ['run', 'propose', 'approve'],
          placement: { group: 'records', level: 'extended' },
          risk: 'sensitive',
          selectors: [],
        },
      ],
      accessGoverningRead: defineActionGoverningRead(read),
      accessTargets: defineActionAccessTargets<typeof payloadSchema.Type>((payload) =>
        payload.ids.map((recordKey) => ({ moduleKey, recordKey })),
      ),
      actionKey: `${moduleKey}.change`,
      auditProfile: 'standard',
      domainErrorSchema: OwnerWriteError,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: `${moduleKey}.change`,
        moduleKey,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: moduleKey,
      payloadSchema,
      policies: [],
      resultSchema: Schema.Number,
      schemaVersion: '1',
    },
    Effect.fn(function* writeEveryRecord(payload, context: OwnerContext) {
      executions.value += 1;
      const updated = yield* context.services.transaction
        .update(records)
        .set({
          salary: payload.salary,
          version: payload.version + 1,
        })
        .where(
          and(
            eq(records.tenantId, context.scope.tenantId),
            eq(records.companyId, context.scope.legalEntityId ?? ''),
            inArray(records.recordKey, payload.ids),
            eq(records.version, payload.version),
          ),
        )
        .returning({ key: records.recordKey })
        .pipe(Effect.mapError(() => new OwnerWriteError({ reason: 'The native owner write failed' })));
      if (updated.length !== payload.ids.length) {
        return yield* new OwnerWriteError({ reason: 'The exact owner record set is no longer current' });
      }
      return updated.length;
    }),
    (transaction) => Effect.succeed({ transaction }),
  );
  return {
    action,
    owner: makeTestOperationOwner({
      actions: [action],
      api: { 'owner-action-approvals': OwnerActionApprovalApi },
      moduleId: moduleKey,
      reads: [read],
    }),
    read,
  };
};

/** A complete native role, with explicit targets for its Action and actual governing Read. */
const seedRole = Effect.fn('NativeV2.seedRole')(function* seedRole(input: {
  readonly admin: Effect.Success<ReturnType<typeof makeTestPgClient>>;
  readonly catalogSnapshotId: string;
  readonly cells: readonly Cell[];
  readonly ownerId: string;
  readonly principalId: string;
  readonly scopeId: string;
  readonly tenantId: string;
}) {
  const crypto = yield* Crypto.Crypto;
  const roleId = yield* crypto.randomUUIDv4();
  const revisionId = yield* crypto.randomUUIDv4();
  const assignmentId = yield* crypto.randomUUIDv4();
  yield* input.admin.unsafe('insert into core.access_roles (role_id,tenant_id,created_by,name) values ($1,$2,$3,$4)', [
    roleId,
    input.tenantId,
    input.ownerId,
    `Native V2 ${roleId}`,
  ]);
  yield* input.admin.unsafe(
    `insert into core.access_role_revisions
     (role_revision_id,tenant_id,role_id,revision,catalog_snapshot_id,cells_json,created_by,provenance)
     values ($1,$2,$3,1,$4,$5::jsonb,$6,'manual')`,
    [revisionId, input.tenantId, roleId, input.catalogSnapshotId, encodeCells(input.cells), input.ownerId],
  );
  const grants: { capabilityKey: string; grantId: string; mode: string }[] = [];
  for (const cell of input.cells) {
    const grantId = yield* crypto.randomUUIDv4();
    yield* input.admin.unsafe(
      `insert into core.access_grant_incarnations
       (grant_incarnation_id,tenant_id,scope_id,role_id,capability_key,mode,slot,cell_json,status)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'active')`,
      [
        grantId,
        input.tenantId,
        input.scopeId,
        roleId,
        cell.capabilityKey,
        cell.mode,
        slotTagOf(cell.selector),
        encodeCell(cell),
      ],
    );
    grants.push({ capabilityKey: cell.capabilityKey, grantId, mode: cell.mode });
  }
  yield* insertAssignment(input.admin, TenantIdSchema.make(input.tenantId), {
    assignedBy: input.ownerId,
    incarnationId: assignmentId,
    principalId: input.principalId,
    roleId,
    roleRevisionId: revisionId,
    scopeId: input.scopeId,
  });
  return { assignmentId, grants };
});

export interface NativeActionV2OwnerBinding {
  readonly applicationComposition: ActiveApplicationCompositionServiceContract;
  readonly expectedDeployment: typeof OntosDeploymentIdentitySchema.Type;
  readonly ownerRegistration: VerticalRuntimeRegistration;
}
export interface NativeActionV2OwnerRuntimeInput {
  readonly configuration: SpiceDbConfigValue;
  readonly database: (typeof CoreDatabase)['Service'];
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly owner: NativeActionV2OwnerBinding;
  readonly scopeResolverLayer: typeof OperationalScopeResolverLive;
}
export interface NativeActionV2CaseContext {
  readonly companyId: string;
  readonly compositionSnapshot: ActiveApplicationCompositionSnapshot;
  readonly configuration: Redacted.Redacted<SpiceDbConfigValue>;
  /** The runner transports these local credentials privately, never in diagnostic output. */
  readonly connections: Redacted.Redacted<DatabaseIdentityConnections>;
  readonly enrollment: DatabaseIdentityEnrollment;
  readonly expectedDeployment: typeof OntosDeploymentIdentitySchema.Type;
  readonly recordKeys: readonly string[];
  readonly tenantId: string;
}

/**
 * Attach the real lifecycle to a SUPPLIED case database. This never creates/migrates a database,
 * writes a graph schema, publishes composition or provisions identities/memberships/permission cells.
 * The caller owns the supplied database. This Effect's Scope owns only its RPC and local services.
 */
export const makeNativeActionV2OwnerRuntime = Effect.fn('NativeV2.attachOwnerRuntime')(function* attachOwnerRuntime({
  configuration,
  database,
  enrollment: databaseIdentities,
  owner,
  scopeResolverLayer,
}: NativeActionV2OwnerRuntimeInput) {
  const crypto = yield* Crypto.Crypto;
  const base = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(CoreDatabase, database),
    Layer.succeed(DatabaseIdentityEnrollmentContext, databaseIdentities),
  );
  const intentLayer = TenantIntentLoaderLive.pipe(Layer.provide(base));
  const rpc = yield* Effect.acquireRelease(
    Effect.sync(() => openSpiceDbGrpcRpc(configuration, 5000)),
    (client) => Effect.sync(() => client.close()),
  );
  const engine = enginePortOf(rpc);
  const remote = { calls: 0 };
  const gatePorts = Layer.mergeAll(
    AccessIntentLive.pipe(Layer.provide(intentLayer)),
    AccessDecisionLogLive.pipe(Layer.provide(base)),
    AccessPrincipalKindSourceLive.pipe(Layer.provide(base)),
    LegalEntityCandidatesLive.pipe(Layer.provide(base)),
    Layer.succeed(DecisionCheck, {
      checkBulk: (questions) =>
        refuseInsideDatabaseTransaction('spicedb', 'native-v2-check').pipe(
          Effect.andThen(
            Effect.sync(() => {
              remote.calls += 1;
            }),
          ),
          Effect.andThen(engine.checkBulk(questions)),
        ),
    }),
  );
  const gateContext = yield* Layer.build(AccessDecisionLive.pipe(Layer.provideMerge(gatePorts)));
  const resolverContext = yield* Layer.build(scopeResolverLayer).pipe(
    Effect.provideContext(gateContext),
    Effect.provideService(CoreDatabase, database),
    Effect.provideService(DatabaseIdentityEnrollmentContext, databaseIdentities),
  );
  const scopeResolver = Context.get(resolverContext, OperationalScopeResolver);
  const accessDecision = yield* bindLiveActionAccessGate.pipe(
    Effect.provideContext(gateContext),
    Effect.provideService(CoreDatabase, database),
    Effect.provideService(DatabaseIdentityEnrollmentContext, databaseIdentities),
  );
  const enforcement = yield* AccessEnforcementPortsLive.pipe(Effect.provideContext(gateContext));
  const frozenCommands = makeDrizzleFrozenCommandStore({ enrollment: databaseIdentities, executor: database.executor });
  const changes = makeAccessChangesDrizzleStore({ enrollment: databaseIdentities, executor: database.executor });
  const joined = (transaction: CoreTransaction): LiveApprovalServices => ({
    crypto,
    intent: makeJoinedTenantIntentLoader(transaction, databaseIdentities),
    join: joined,
    loadRelease: () => changes.loadPublishedCatalog(transaction),
    records: makeJoinedDrizzleApprovalStore({ enrollment: databaseIdentities, frozenCommands, transaction }, crypto),
    transactions: callerTransactions(transaction, databaseIdentities),
  });
  const baseServices: LiveApprovalServices = {
    crypto,
    intent: makeTenantIntentLoader({ enrollment: databaseIdentities, executor: database.executor }),
    join: joined,
    loadRelease: () => changes.loadPublishedCatalog(),
    records: makeDrizzleApprovalStore(
      { enrollment: databaseIdentities, executor: database.executor, frozenCommands },
      crypto,
    ),
    transactions: requestTransactions({ enrollment: databaseIdentities, executor: database.executor }),
  };
  const lifecycle = yield* makeActionApprovalLifecycleV2().pipe(
    Effect.provideService(ActionApprovalLifecycleV2Ports, {
      database: { enrollment: databaseIdentities, executor: database.executor },
      enforcement,
      frozenCommands,
      live: baseServices,
      owners: [owner],
    }),
    Effect.provideService(AccessDecisionGate, Context.get(gateContext, AccessDecisionGate)),
  );
  const services = { ...baseServices, actionCommands: lifecycle };
  const approvalsFor = (scope: Effect.Success<ReturnType<typeof scopeResolver.resolve>>) =>
    liveApprovalsService(services, scope);
  const dispatch = yield* makeDrizzleActionMandateDispatch().pipe(
    Effect.provideService(MandateDispatchPorts, {
      actionCommands: lifecycle,
      approvalsFor,
      database,
      enrollment: databaseIdentities,
      frozenCommands,
      principalKinds: enforcement.principalKinds,
    }),
  );
  const moduleStateGate = makeModuleStateGate(makeTenantModuleStateService(database));
  const runtime = makeActionRuntime(
    database,
    makeActionRepository(crypto),
    { checkActionPermission: () => Effect.die('The retired gate cannot authorize native V2 execution') },
    scopeResolver,
    {
      accessDecision,
      applicationComposition: owner.applicationComposition,
      databaseIdentities,
      expectedDeployment: owner.expectedDeployment,
      mandateDispatch: dispatch,
      moduleEntrypointGateway: makeModuleEntrypointGateway(moduleStateGate),
      moduleStateGate,
      ownerAuthorizationOverlay: {
        authorize: (transaction, input) =>
          transaction
            .select({ key: records.recordKey })
            .from(records)
            .where(
              and(
                eq(records.tenantId, input.scope.tenantId),
                eq(records.companyId, input.scope.legalEntityId ?? ''),
                eq(records.recordKey, input.target?.recordKey ?? ''),
              ),
            )
            .pipe(
              Effect.map((found) => (found.length === 1 ? ('allowed' as const) : ('denied' as const))),
              Effect.orElseSucceed(() => 'unavailable' as const),
            ),
      },
      ownerRegistration: owner.ownerRegistration,
    },
  );
  return {
    accessDecisionGate: Context.get(gateContext, AccessDecisionGate),
    approvalsFor,
    dispatch,
    enforcement,
    frozenCommands,
    gateContext,
    lifecycle,
    remote,
    runtime,
    scopeResolver,
  };
});

/** Only explicit process runner configuration is read. This fixture never loads a workspace .env. */
export const makeNativeActionV2Fixture = Effect.gen(function* makeNativeActionV2Fixture() {
  const crypto = yield* Crypto.Crypto;
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const control = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  const name = `action_live_v2_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  yield* control.unsafe(`create database "${name}"`);
  yield* Effect.addFinalizer(() => dropDatabase(control, name));
  const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, name));
  yield* createTemplateDatabase(admin);
  yield* admin.unsafe(`create table public.native_action_v2_records
    (tenant_id uuid not null, company_id uuid not null, record_key text primary key,
     salary integer not null, version integer not null)`);
  yield* admin.unsafe('grant select, update on public.native_action_v2_records to ontos_runtime');
  const database = yield* makeCoreDatabase({
    connectionString: replacedDatabase(connections.runtime.connectionString, name),
    expectedRole: connections.runtime.expectedRole,
    maxConnections: 4,
  });
  const administrative = yield* makeCoreDatabase({
    connectionString: replacedDatabase(connections.admin.connectionString, name),
    expectedRole: connections.admin.expectedRole,
  });
  const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  yield* Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.suspend(() =>
        Effect.tryPromise(
          Fn.constant(client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }))),
        ),
      ),
    (client) => Effect.sync(() => client.close()),
  );
  const transport = makeAccessProjectionTransport(configuration);
  yield* Effect.addFinalizer(() => Effect.sync(() => transport.close()));
  const compiler = makeAccessProjectionCompiler(transport);
  const tenantId = TenantIdSchema.make(yield* crypto.randomUUIDv4());
  const companyId = LegalEntityIdSchema.make(yield* crypto.randomUUIDv4());
  const ownerId = PrincipalIdSchema.make(yield* crypto.randomUUIDv4());
  const requesterId = PrincipalIdSchema.make(yield* crypto.randomUUIDv4());
  const approverId = PrincipalIdSchema.make(yield* crypto.randomUUIDv4());
  yield* Effect.addFinalizer(() =>
    compiler.readProjection([tenantId]).pipe(
      Effect.flatMap((relationships) =>
        compiler.reconcile(
          { tenants: [] },
          {
            fence: () => Effect.void,
            removedUnits: [
              ...new Map(
                relationships
                  .map(unitOfRelationship)
                  .flatMap(Option.toArray)
                  .map((unit) => [projectionUnitKeyText(unit), unit] as const),
              ).values(),
            ],
          },
        ),
      ),
      Effect.orDie,
    ),
  );
  const executions = { value: 0 };
  const { action, owner, read } = makeNativeActionV2Owner(executions);
  yield* publishTestApplicationCompositionAuthority(administrative.executor, yield* owner.snapshot);
  yield* admin.unsafe(
    `insert into core.tenants (tenant_id,slug,name,status,default_locale) values ($1,$2,'Native V2','active','en')`,
    [tenantId, `native-v2-${tenantId}`],
  );
  yield* admin.unsafe(
    `insert into core.legal_entities (tenant_id,legal_entity_id,legal_name,registration_country,registration_number,status)
     values ($1,$2,'Native V2','CZ',$3,'active')`,
    [tenantId, companyId, companyId],
  );
  for (const principalId of [ownerId, requesterId, approverId]) {
    yield* admin.unsafe(
      `insert into core.principals (tenant_id,principal_id,kind,display_name,status)
      values ($1,$2,'human','Native V2','active')`,
      [tenantId, principalId],
    );
  }
  yield* admin.unsafe(`insert into core.tenant_module_states (tenant_id,module_key,state) values ($1,$2,'active')`, [
    tenantId,
    moduleKey,
  ]);
  const base = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(CoreDatabase, database),
    Layer.succeed(DatabaseIdentityEnrollmentContext, enrollment),
  );
  const intentLayer = TenantIntentLoaderLive.pipe(Layer.provide(base));
  const stores = Layer.mergeAll(
    base,
    intentLayer,
    AccessChangesStoreLive.pipe(Layer.provide(base)),
    AccessMembershipStoreLive.pipe(Layer.provide(base)),
    AccessWriteJournalStoreLive.pipe(Layer.provide(base)),
  );
  const platforms = Layer.mergeAll(stores, Layer.succeed(AccessProjectionCompiler, compiler));
  const writerLayer = AccessProjectionWriterLive.pipe(Layer.provide(platforms));
  const bootstrapLayer = TenantAccessBootstrapLive.pipe(
    Layer.provide(
      Layer.mergeAll(platforms, writerLayer, AccessCatalogSnapshotWriterLive.pipe(Layer.provide(platforms))),
    ),
  );
  const boot = yield* Layer.build(Layer.mergeAll(writerLayer, bootstrapLayer));
  const writer = Context.get(boot, AccessProjectionWriter);
  const ownerScope = yield* testOperationalScopeResolver.resolve({
    correlationId: 'native-v2-bootstrap',
    legalEntityScope: 'forbidden',
    principal: yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authContextRef: `job:native-v2:run:${ownerId}`,
      authMethod: 'system',
      principalId: ownerId,
      tenantId,
    }),
  });
  const adopted = yield* Context.get(boot, TenantAccessBootstrap).bootstrapTenantAccess({
    legalEntityIds: [companyId],
    modules: [{ descriptors: [action.descriptor, read.descriptor], moduleId: moduleKey }],
    scope: ownerScope,
  });
  const tenantScope = yield* tenantScopeIdOf(admin, tenantId);
  const companyScope = AccessScopeIdSchema.make(yield* legalEntityScopeIdOf(admin, tenantId, companyId));
  for (const principalId of [requesterId, approverId]) {
    for (const scopeId of [tenantScope, companyScope]) {
      yield* insertMembership(admin, tenantId, { kind: 'member', principalId, recordedBy: ownerId, scopeId });
    }
  }
  const ids = [RecordKeySchema.make('native-first'), RecordKeySchema.make('native-second')] as const;
  for (const id of ids) {
    yield* admin.unsafe('insert into public.native_action_v2_records values ($1,$2,$3,0,1)', [tenantId, companyId, id]);
  }
  const cell = (key: string, mode: Cell['mode'], recordScoped: boolean): Cell => ({
    capabilityKey: CapabilityKeySchema.make(key),
    mode,
    selector: recordScoped ? { _tag: 'targets', recordKeys: ids } : { _tag: 'all' },
  });
  const roleInput = { admin, catalogSnapshotId: adopted.catalogSnapshotId, ownerId, scopeId: companyScope, tenantId };
  const requesterRole = yield* seedRole({
    ...roleInput,
    cells: [cell(nativeV2Keys.action, 'propose', true), cell(nativeV2Keys.writeField, 'propose', false)],
    principalId: requesterId,
  });
  const approverRole = yield* seedRole({
    ...roleInput,
    cells: [
      cell(nativeV2Keys.action, 'approve', true),
      cell(nativeV2Keys.writeField, 'approve', false),
      cell(nativeV2Keys.read, 'run', true),
      cell(nativeV2Keys.readField, 'run', false),
    ],
    principalId: approverId,
  });
  yield* writer.reconcileTenant({ scope: ownerScope });
  const authority = yield* makeNativeActionV2OwnerRuntime({
    configuration,
    database,
    enrollment,
    owner,
    scopeResolverLayer: Layer.succeed(OperationalScopeResolver, testOperationalScopeResolver),
  });
  const { accessDecisionGate, approvalsFor, dispatch, frozenCommands, lifecycle, remote, runtime } = authority;
  const sourceConnections = yield* loadDatabaseIdentityConnections({ enrollment, envPath: '/dev/null' });
  const sessionConnections = yield* loadDatabaseIdentityConnections({
    enrollment,
    environment: {
      DATABASE_ADMIN_URL: replacedDatabase(sourceConnections.admin.connectionString, name),
      ...Object.fromEntries(
        enrollment.identities.map((identity) => {
          const connection = sourceConnections.runtime[identity.id];
          if (connection === undefined) {
            return [identity.urlKey, undefined];
          }
          return [identity.urlKey, replacedDatabase(connection.connectionString, name)];
        }),
      ),
    },
    envPath: '/dev/null',
  });
  const sessionFactory = yield* NativeHumanSessionsFactory;
  const sessionProvider = yield* sessionFactory.make({
    accessDecision: accessDecisionGate,
    bindHumanProviderSubject: Effect.fn('NativeV2.bindActualFrameworkSubject')(
      function* bindSubject(input) {
        if (
          input.tenantId !== tenantId ||
          ![requesterId, approverId].some((id) => id === input.principalId) ||
          input.authenticationNamespaceId !== STAFF_AUTHENTICATION_NAMESPACE_ID ||
          input.providerSubjectId.length === 0 ||
          input.providerSubjectId === input.principalId
        ) {
          return yield* new NativeHumanSessionFixtureError({
            reason: 'The framework subject does not match the fixture human',
          });
        }
        yield* input.verifyProviderSubject;
        const authBindingId = yield* crypto.randomUUIDv4();
        const [binding] = yield* admin.unsafe<{ readonly principal_auth_binding_id: string }>(
          `insert into core.principal_auth_bindings
          (tenant_id,principal_auth_binding_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status)
         select p.tenant_id,$2,p.principal_id,$4,'better_auth','user',$5,'active' from core.principals p
         join core.tenants t using (tenant_id)
         where p.tenant_id=$1 and p.principal_id=$3 and p.kind='human' and p.status='active' and t.status='active'
         returning principal_auth_binding_id`,
          [tenantId, authBindingId, input.principalId, STAFF_AUTHENTICATION_NAMESPACE_ID, input.providerSubjectId],
        );
        if (binding?.principal_auth_binding_id !== authBindingId) {
          return yield* new NativeHumanSessionFixtureError({ reason: 'The active fixture human is unavailable' });
        }
        return { authBindingId };
      },
      Effect.mapError(
        (cause) =>
          new NativeHumanSessionFixtureError({
            cause: Redacted.make(cause),
            reason: 'The native binding could not be persisted',
          }),
      ),
    ),
    connections: sessionConnections,
    contextAccess: yield* makeContextAccessLive(undefined, () => Effect.succeed(configuration)),
    coreDatabase: database,
    enrollment,
    revokeBinding: (authBindingId) =>
      admin
        .unsafe(
          "update core.principal_auth_bindings set status='revoked',revoked_at=now() where tenant_id=$1 and principal_auth_binding_id=$2",
          [tenantId, authBindingId],
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new NativeHumanSessionFixtureError({
                cause: Redacted.make(cause),
                reason: 'The fixture binding could not be revoked',
              }),
          ),
        ),
  });
  const requesterSession = yield* sessionProvider.create({
    displayName: 'Native requester',
    legalEntityId: companyId,
    principalId: requesterId,
    tenantId,
  });
  const approverSession = yield* sessionProvider.create({
    displayName: 'Native approver',
    legalEntityId: companyId,
    principalId: approverId,
    tenantId,
  });
  const principalFor = Effect.fn('NativeV2.currentHumanPrincipal')(function* humanPrincipal(principalId: string) {
    const sessions = new Map([
      [requesterId, requesterSession],
      [approverId, approverSession],
    ]);
    const session = sessions.get(PrincipalIdSchema.make(principalId));
    if (session === undefined) {
      return yield* new NativeHumanSessionFixtureError({ reason: 'The human session is not bound to this fixture' });
    }
    return (yield* session.authenticate()).principal;
  });
  const scopeFor = Effect.fn('NativeV2.currentHumanScope')(function* humanScope(principalId: string) {
    return yield* testOperationalScopeResolver.resolve({
      correlationId: 'native-v2',
      legalEntityScope: 'required',
      principal: yield* principalFor(principalId),
    });
  });
  const requesterScope = yield* scopeFor(requesterId);
  const approverScope = yield* scopeFor(approverId);
  const payload = { ids, salary: 50, version: 1 };
  const caseContext: NativeActionV2CaseContext = Object.freeze({
    companyId,
    compositionSnapshot: yield* owner.snapshot,
    configuration: Redacted.make(configuration),
    connections: Redacted.make(sessionConnections),
    enrollment,
    expectedDeployment: owner.expectedDeployment,
    recordKeys: ids,
    tenantId,
  });
  return {
    action,
    admin,
    approvalsFor,
    approverId,
    approverRole,
    approverScope,
    approverSession,
    authority,
    caseContext,
    companyId,
    companyScope,
    database,
    dispatch,
    executions,
    frozenCommands,
    ids,
    lifecycle,
    owner,
    payload,
    principalFor,
    reconcile: () => writer.reconcileTenant({ scope: ownerScope }),
    remote,
    requesterId,
    requesterRole,
    requesterScope,
    requesterSession,
    runtime,
    tenantId,
  };
});

/** Public TEST-only session adapter seam; no Shell implementation or ambient provider is imported. */
export {
  NativeHumanSessionsFactory,
  NativeHumanSessionsFactoryLive,
  NativeHumanSessionFixtureError,
} from './native-human-sessions.ts';
export type {
  NativeHumanSessionExpectation,
  NativeHumanSessionHandle,
  NativeHumanSessionIdentity,
  NativeHumanSessionProvider,
  NativeHumanSessionProviderOptions,
} from './native-human-sessions.ts';
export type NativeActionV2Fixture = Effect.Success<typeof makeNativeActionV2Fixture>;
export type NativeActionV2Owner = ReturnType<typeof makeNativeActionV2Owner>;
export type NativeActionV2OwnerRuntime = Effect.Success<ReturnType<typeof makeNativeActionV2OwnerRuntime>>;

/** Original production constructors, exposed here only for explicitly composed native TEST processes. */
export { OperationalScopeResolverLive } from '../../src/operations/context.ts';
export { makeGatewayScopeGrantRegistrar } from '../../src/auth/gateway-scope-grant.ts';
export type { GatewayScopeGrantRegistrarService } from '../../src/auth/gateway-scope-grant.ts';
export { FIXTURE_DATABASE_IDENTITY_ENROLLMENT as nativeActionV2DatabaseIdentityEnrollment } from './database-identities.ts';
