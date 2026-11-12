import { v1 } from '@authzed/authzed-node';
import { NodeServices } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Context, Crypto, Deferred, Effect, Fiber, Function, Layer, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { ActionPermissionDenied } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { loadDatabaseConnectionPair } from '../../src/db/config.ts';
import { DatabaseIdentityEnrollmentContext } from '../../src/db/database-identities.ts';
import {
  AuthenticationNamespaceIdSchema,
  AuthenticationNamespaceRegistrationSchema,
} from '../../src/auth/external-identity-contracts.ts';
import {
  AuthenticationNamespaceRegistry,
  makeAuthenticationNamespaceRegistry,
} from '../../src/auth/external-identity/verifier.ts';
import {
  actionInvocations,
  auditEvents,
  coreRelations,
  dataAccessEvents,
  domainEvents,
  outboxMessages,
  tenantModuleStates,
} from '../../src/db/schema.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import type { OperationalScopeResolverService } from '../../src/operations/context.ts';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '../../src/operations/errors.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient, openSpiceDbGrpcRpc } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import { testOperationalScopeResolver as baseTestOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions, makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { injectStatementFaults } from '../support/database-faults.ts';
import { TestWriteError } from '../support/permission-write-error.ts';
import {
  makePermissionSuite,
  PermissionSuite,
  staffAuthenticationNamespaceId,
} from '../support/action-permission-suite.ts';
import type { PermissionSuiteFixture } from '../support/action-permission-suite.ts';
import { TenantAccessBootstrap, TenantAccessBootstrapLive } from '../../src/access/bootstrap/index.ts';
import { AccessChangesStoreLive } from '../../src/access/changes/persistence/drizzle-store.ts';
import { AccessCatalogSnapshotWriterLive } from '../../src/access/intent/catalog-snapshot-writer.ts';
import { AccessMembershipStoreLive } from '../../src/access/intent/memberships.ts';
import { TenantIntentLoaderLive } from '../../src/access/intent/tenant-intent-loader.ts';
import { AccessProjectionWriter, AccessProjectionWriterLive } from '../../src/access/intent/projection-writer.ts';
import { AccessProjectionCompiler } from '../../src/access/intent/projection-compiler.ts';
import { AccessWriteJournalStoreLive } from '../../src/access/lifecycle/persistence/journal-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../src/access/compiler/spice-db-compiler.ts';
import { projectionUnitKeyText, unitOfRelationship } from '../../src/access/compiler/relationship.ts';
import { AccessIntentLive } from '../../src/access/enforcement/intent-reader.ts';
import { AccessDecisionLive } from '../../src/access/enforcement/service.ts';
import { AccessDecisionLogLive } from '../../src/access/enforcement/decision-log.ts';
import { AccessPrincipalKindSourceLive } from '../../src/access/enforcement/actor.ts';
import { LegalEntityCandidatesLive } from '../../src/access/enforcement/legal-entities.ts';
import { DecisionCheck } from '../../src/access/decision/engine.ts';
import { enginePortOf } from '../../src/access/enforcement/enforcement-live.ts';
import { LegalEntityIdSchema, TenantIdSchema } from '../../src/access/ids.ts';
import { bindLiveActionAccessGate } from '../../src/operations/access-gate.ts';
import { FIXTURE_DATABASE_IDENTITY_ENROLLMENT } from '../support/database-identities.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../support/database.ts';
import { createTemplateDatabase, dropDatabase, replacedDatabase } from '../support/access-scenarios/database.ts';
import {
  insertAssignment,
  insertMembership,
  insertRoleWithCells,
  legalEntityScopeIdOf,
  tenantScopeIdOf,
} from '../support/access-scenarios/scenario.ts';

/** Bind the exact late-created TEST definition; original controlled options and native bindings stay explicit. */
const makeRegisteredTestActionRuntime = (
  ...parameters: Parameters<typeof makeActionRuntime>
): ReturnType<typeof makeActionRuntime> => {
  const [database, repository, permission, scope, options] = parameters;
  const runtime = makeActionRuntime(database, repository, permission, scope, options);
  return {
    ...runtime,
    runAction: (input) => {
      const ownerRegistration =
        options.ownerRegistration ??
        makeTestOperationOwner({
          actions: [input.registration],
          moduleId: input.registration.descriptor.owningModuleKey,
        }).ownerRegistration;
      return makeActionRuntime(database, repository, permission, scope, { ...options, ownerRegistration }).runAction(
        input,
      );
    },
  };
};

const authenticationNamespaceRegistry = makeAuthenticationNamespaceRegistry([
  Schema.decodeSync(AuthenticationNamespaceRegistrationSchema)({
    allowedAudiences: ['core-runtime-test'],
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    provider: 'test-provider',
    requiresOperationAdmission: false,
    reservationPrincipalKind: 'human',
    subjectTypes: ['user'],
    trustedAttesterPrincipalIds: [],
  }),
]);
const testOperationalScopeResolver: OperationalScopeResolverService = {
  resolve: (input) =>
    Effect.gen(function* registeredTestOperationalScope() {
      const namespaceId = input.principal.authenticationNamespaceId;
      if (namespaceId !== undefined) {
        const registration = yield* authenticationNamespaceRegistry
          .lookup(AuthenticationNamespaceIdSchema.make(namespaceId))
          .pipe(
            Effect.mapError(
              () =>
                new OperationContextUnavailable({
                  code: 'operation_context_unavailable',
                  reason: 'The test authentication namespace registry is unavailable',
                }),
            ),
          );
        if (Option.isNone(registration)) {
          return yield* new OperationAuthenticationRequired({
            code: 'operation_authentication_required',
            reason: 'The test authentication namespace is not registered',
          });
        }
      }
      return yield* baseTestOperationalScopeResolver.resolve(input);
    }),
};

const transport = (idempotencyKey: string, targetResourceId: string) => ({
  correlationId: `permission-integration-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.shell',
  targetResourceId,
  targetResourceType: 'permission-test-state',
});

type ContextServiceContract = Parameters<typeof makeActionRuntime>[0];

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const NoDomainEvents = {};
interface PermissionActionServices {
  readonly transaction: ScopedTransactionExecutor;
}
type PermissionActionContext = ActionHandlerContext<typeof NoDomainEvents, PermissionActionServices>;

const registration = (actionKey: string, moduleStateKey: string, onExecute: () => void) =>
  defineAction(
    {
      accessDeclaration: {
        key: actionKey,
        kind: 'action',
        modes: ['run'],
        placement: { group: 'identity', level: 'basic' },
        risk: 'routine',
        selectors: [],
      },
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'action-permission.integration.v1',
      },
      actionKey,
      auditProfile: 'sensitive',
      domainErrorSchema: TestWriteError,
      domainEvents: NoDomainEvents,
      entrypoint: defineSystemModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'protected' },
        entrypointKey: actionKey,
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'required',
      owningModuleKey: 'core.shell',
      payloadSchema: Schema.Void,
      policies: [],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    Effect.fn(function* permissionIntegrationHandler(_payload, context: PermissionActionContext) {
      onExecute();
      yield* context.services.transaction
        .insert(tenantModuleStates)
        .values({
          moduleKey: moduleStateKey,
          state: 'active',
          tenantId: context.scope.tenantId,
        })
        .pipe(Effect.mapError(() => new TestWriteError({ reason: 'test business write failed' })));
    }),
    (transaction) => Effect.succeed({ transaction }),
  );

/** The canonical runtime ports, over this suite's disposable PostgreSQL database. */
const canonicalPorts = (database: ContextServiceContract) => {
  const base = Layer.mergeAll(
    Layer.succeed(CoreDatabase, database),
    Layer.succeed(DatabaseIdentityEnrollmentContext, FIXTURE_DATABASE_IDENTITY_ENROLLMENT),
    NodeServices.layer,
  );
  const intent = TenantIntentLoaderLive.pipe(Layer.provide(base));
  const stores = Layer.mergeAll(
    base,
    intent,
    AccessWriteJournalStoreLive.pipe(Layer.provide(base)),
    AccessChangesStoreLive.pipe(Layer.provide(base)),
    AccessMembershipStoreLive.pipe(Layer.provide(base)),
  );
  return Layer.mergeAll(
    stores,
    AccessIntentLive.pipe(Layer.provide(intent)),
    AccessDecisionLogLive.pipe(Layer.provide(base)),
    AccessPrincipalKindSourceLive.pipe(Layer.provide(base)),
    LegalEntityCandidatesLive.pipe(Layer.provide(base)),
  );
};

const makeCanonicalPermissionFixture = Effect.gen(function* makeCanonicalPermissionFixture() {
  const suite = yield* PermissionSuite;
  const crypto = yield* Crypto.Crypto;
  // Do not read .env or mutate a shared database/schema. All SQL rows belong to this new database.
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const name = `action_permission_v2_${(yield* crypto.randomUUIDv4()).replaceAll('-', '')}`;
  const control = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
  yield* control.unsafe(`create database "${name}"`);
  yield* Effect.addFinalizer(() => dropDatabase(control, name));
  const admin = yield* makeTestPgClient(replacedDatabase(connections.admin.connectionString, name));
  yield* createTemplateDatabase(admin);
  const runtimeClient = yield* makeTestPgClient(replacedDatabase(connections.runtime.connectionString, name), {
    maxConnections: 4,
  });
  const database = { executor: yield* makeTestDatabaseFromClient(runtimeClient, coreRelations) };
  const ports = canonicalPorts(database);
  const configuration = yield* loadSpiceDbConfig({ envPath: '/dev/null' });
  yield* Effect.acquireUseRelease(
    Effect.sync(() => newSpiceDbGrpcClient(configuration)),
    (client) =>
      Effect.tryPromise(() =>
        client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      ),
    (client) => Effect.sync(() => client.close()),
  );
  const projectionTransport = makeAccessProjectionTransport(configuration);
  yield* Effect.addFinalizer(() => Effect.sync(() => projectionTransport.close()));
  const compiler = makeAccessProjectionCompiler(projectionTransport);
  const tenantId = TenantIdSchema.make(suite.tenantId);
  const otherTenantId = TenantIdSchema.make(suite.otherTenantId);
  // These random tenants have no other writer. Clean every projected unit even after partial bootstrap,
  // before closing the transport or dropping the suite's database.
  yield* Effect.addFinalizer(() =>
    compiler.readProjection([tenantId, otherTenantId]).pipe(
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
  const platforms = Layer.mergeAll(ports, Layer.succeed(AccessProjectionCompiler, compiler));
  const catalog = AccessCatalogSnapshotWriterLive.pipe(Layer.provide(platforms));
  const writerLayer = AccessProjectionWriterLive.pipe(Layer.provide(platforms));
  const bootstrapLayer = TenantAccessBootstrapLive.pipe(Layer.provide(Layer.mergeAll(platforms, catalog, writerLayer)));
  const context = yield* Layer.build(Layer.mergeAll(writerLayer, bootstrapLayer));
  const bootstrap = Context.get(context, TenantAccessBootstrap);
  const writer = Context.get(context, AccessProjectionWriter);
  const ownerId = suite.bootstrapOwnerPrincipalId;
  const ownerScope = yield* testOperationalScopeResolver.resolve({
    correlationId: 'permission-v2-bootstrap',
    legalEntityScope: 'forbidden',
    principal: yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(suite.bootstrapOwnerPrincipal),
  });
  const otherTenantOwnerScope = yield* testOperationalScopeResolver.resolve({
    correlationId: 'permission-v2-other-tenant-bootstrap',
    legalEntityScope: 'forbidden',
    principal: yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
      suite.otherTenantBootstrapOwnerPrincipal,
    ),
  });
  const registrations = Object.values(suite.actionKeys).map((key) =>
    registration(key, `${key}.state`, Function.constVoid),
  );
  const modules = [{ descriptors: registrations.map((action) => action.descriptor), moduleId: 'core.shell' }];
  const seed = [
    [suite.tenantId, suite.principalId, suite.principalAuthBindingId],
    [suite.tenantId, suite.nonMemberPrincipalId, suite.nonMemberAuthBindingId],
    [suite.tenantId, ownerId, suite.bootstrapOwnerAuthBindingId],
    [suite.otherTenantId, suite.otherTenantPrincipalId, suite.otherTenantAuthBindingId],
    [suite.otherTenantId, suite.otherTenantBootstrapOwnerPrincipalId, suite.otherTenantBootstrapOwnerAuthBindingId],
  ] as const;
  for (const seededTenantId of [suite.tenantId, suite.otherTenantId]) {
    yield* admin.unsafe(
      `insert into core.tenants (tenant_id, slug, name, status, default_locale)
       values ($1, $2, 'Canonical Action permission integration', 'active', 'en')`,
      [seededTenantId, `permission-${seededTenantId}`],
    );
    yield* admin.unsafe(
      `insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, 'core.shell', 'active')`,
      [seededTenantId],
    );
  }
  for (const [companyTenantId, companyId] of [
    [suite.tenantId, suite.legalEntityId],
    [suite.otherTenantId, suite.otherTenantLegalEntityId],
  ] as const) {
    yield* admin.unsafe(
      `insert into core.legal_entities (tenant_id, legal_entity_id, legal_name, registration_country, registration_number, status)
       values ($1, $2, 'Permission company', 'CZ', $3, 'active')`,
      [companyTenantId, companyId, companyId],
    );
  }
  for (const [seededTenantId, principalId, bindingId] of seed) {
    yield* admin.unsafe(
      `insert into core.principals (tenant_id, principal_id, kind, display_name, status) values ($1, $2, 'human', 'Permission fixture', 'active')`,
      [seededTenantId, principalId],
    );
    yield* admin.unsafe(
      `insert into core.principal_auth_bindings (tenant_id, principal_auth_binding_id, principal_id, authentication_namespace_id, provider, subject_type, provider_subject_id, status)
       values ($1, $2, $3, $4, 'better_auth', 'user', $5, 'active')`,
      [seededTenantId, bindingId, principalId, staffAuthenticationNamespaceId, principalId],
    );
  }
  // The bootstrap owner is not the actor under test. The actor receives only the adopted role below.
  const bootstrapped = yield* bootstrap.bootstrapTenantAccess({
    legalEntityIds: [LegalEntityIdSchema.make(suite.legalEntityId)],
    modules,
    scope: ownerScope,
  });
  yield* bootstrap.bootstrapTenantAccess({
    legalEntityIds: [LegalEntityIdSchema.make(suite.otherTenantLegalEntityId)],
    modules,
    scope: otherTenantOwnerScope,
  });
  const otherTenantScopeId = yield* tenantScopeIdOf(admin, otherTenantId);
  const otherTenantCompanyScopeId = yield* legalEntityScopeIdOf(admin, otherTenantId, suite.otherTenantLegalEntityId);
  // This human has valid operational membership but no role, including the other tenant's owner role.
  for (const scopeId of [otherTenantScopeId, otherTenantCompanyScopeId]) {
    yield* insertMembership(admin, otherTenantId, {
      kind: 'member',
      principalId: suite.otherTenantPrincipalId,
      recordedBy: suite.otherTenantBootstrapOwnerPrincipalId,
      scopeId,
    });
  }
  const tenantScopeId = yield* tenantScopeIdOf(admin, tenantId);
  const companyScopeId = yield* legalEntityScopeIdOf(admin, tenantId, suite.legalEntityId);
  for (const principalId of [suite.principalId, suite.nonMemberPrincipalId]) {
    yield* insertMembership(admin, tenantId, {
      kind: 'member',
      principalId,
      recordedBy: ownerId,
      scopeId: tenantScopeId,
    });
  }
  yield* insertMembership(admin, tenantId, {
    kind: 'member',
    principalId: suite.principalId,
    recordedBy: ownerId,
    scopeId: companyScopeId,
  });
  const roleId = yield* crypto.randomUUIDv4();
  const roleRevisionId = yield* crypto.randomUUIDv4();
  yield* insertRoleWithCells(admin, tenantId, {
    capabilityKeys: [
      suite.actionKeys.allowed,
      suite.actionKeys.membershipAllowed,
      suite.actionKeys.crossTenantDenied,
      suite.actionKeys.nonMemberDenied,
      suite.actionKeys.unavailable,
    ],
    catalogSnapshotId: bootstrapped.catalogSnapshotId,
    createdBy: ownerId,
    roleId,
    roleRevisionId,
    scopeId: companyScopeId,
  });
  for (const principalId of [suite.principalId, suite.nonMemberPrincipalId]) {
    yield* insertAssignment(admin, tenantId, {
      assignedBy: ownerId,
      incarnationId: yield* crypto.randomUUIDv4(),
      principalId,
      roleId,
      roleRevisionId,
      scopeId: companyScopeId,
    });
  }
  yield* writer.reconcileTenant({ scope: ownerScope });
  yield* writer.reconcileTenant({ scope: otherTenantOwnerScope });
  const otherTenantMemberships = yield* admin.unsafe<{ readonly scope_id: string }>(
    `select scope_id from core.access_memberships
     where tenant_id = $1 and principal_id = $2 and kind = 'member' and status = 'active'`,
    [suite.otherTenantId, suite.otherTenantPrincipalId],
  );
  expect(otherTenantMemberships.map((membership) => membership.scope_id).toSorted()).toEqual(
    [otherTenantScopeId, otherTenantCompanyScopeId].toSorted(),
  );
  const otherTenantAssignments = yield* admin.unsafe(
    `select incarnation_id from core.access_assignments where principal_id = $1`,
    [suite.otherTenantPrincipalId],
  );
  expect(otherTenantAssignments.length).toBe(0);
  return { database, ports };
});

class CanonicalPermissionFixture extends Context.Service<
  CanonicalPermissionFixture,
  Effect.Success<typeof makeCanonicalPermissionFixture>
>()('@app/core-runtime/tests/integration/action-permission.test/CanonicalPermissionFixture') {}

const PermissionFixture = Layer.effect(CanonicalPermissionFixture, makeCanonicalPermissionFixture);

const withDatabase = <Value, Error, Requirements>(
  operation: (
    database: ContextServiceContract,
    suite: PermissionSuiteFixture,
  ) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.gen(function* permissionDatabaseScope() {
    const fixture = yield* CanonicalPermissionFixture;
    return yield* operation(fixture.database, yield* PermissionSuite);
  });

interface ExecutionCounter {
  value: number;
}

const incrementExecution = (counter: ExecutionCounter): void => {
  counter.value += 1;
};

const runWithLivePermission = <Value, Error>(
  database: ContextServiceContract,
  operation: (runtime: ReturnType<typeof makeActionRuntime>) => Effect.Effect<Value, Error>,
  configuration?: SpiceDbConfigValue,
  onStage: NonNullable<ActionRuntimeOptions['onStage']> = Function.constVoid,
) =>
  Effect.scoped(
    Effect.gen(function* runWithLivePermissionProgram() {
      const crypto = yield* Crypto.Crypto;
      const fixture = yield* CanonicalPermissionFixture;
      const config = yield* configuration === undefined
        ? loadSpiceDbConfig({ envPath: '/dev/null' })
        : Effect.succeed(configuration);
      const rpc = yield* Effect.acquireRelease(
        Effect.sync(() => openSpiceDbGrpcRpc(config, 5000)),
        (client) => Effect.sync(() => client.close()),
      );
      const engine = Layer.succeed(DecisionCheck, enginePortOf(rpc));
      const gateLayer = AccessDecisionLive.pipe(Layer.provideMerge(Layer.mergeAll(fixture.ports, engine)));
      const context = yield* Layer.build(gateLayer);
      const accessDecision = yield* bindLiveActionAccessGate.pipe(Effect.provideContext(context));
      return yield* operation(
        makeRegisteredTestActionRuntime(
          database,
          makeActionRepository(crypto),
          { checkActionPermission: () => Effect.die('Legacy Action permission checks must not run') },
          testOperationalScopeResolver,
          { ...openActionRuntimeOptions, accessDecision, onStage },
        ),
      );
    }),
  );

type DenialFailureStage = typeof DenialFailureStageSchema.Type;
const withDenialPersistenceFailure = (
  database: ContextServiceContract,
  stage: DenialFailureStage,
): ContextServiceContract => {
  const transaction: ContextServiceContract['executor']['transaction'] = (operation) =>
    database.executor.transaction((current) => {
      const prefix = stage === 'audit' ? 'insert into "core"."audit_events"' : 'update "core"."action_invocations"';
      return operation(current).pipe(
        injectStatementFaults((statement) =>
          statement.startsWith(prefix)
            ? Effect.fail(
                new SqlError({
                  reason: new UnknownError({
                    cause: new Error('Injected SQL failure'),
                    message: `Injected denial ${stage} failure`,
                  }),
                }),
              )
            : Effect.void,
        ),
      );
    });
  const executor: ContextServiceContract['executor'] = Object.assign(Object.create(database.executor), { transaction });
  return { executor };
};

const DenialFailureStageSchema = Schema.Literals(['audit', 'invocation-update']);

const runFailedAction = (
  runtime: ReturnType<typeof makeActionRuntime>,
  principal: PermissionSuiteFixture['principal'],
  actionKey: string,
  key: string,
  moduleStateKey: string,
  executions: ExecutionCounter,
) =>
  Effect.flip(
    runtime.runAction({
      payload: undefined,
      principal,
      registration: registration(actionKey, moduleStateKey, incrementExecution.bind(undefined, executions)),
      transport: transport(key, moduleStateKey),
    }),
  );

const testProgram1 = () =>
  withDatabase((database, { actionKeys, actionPrefix, principal }) =>
    Effect.forEach(
      [
        ['direct', actionKeys.allowed],
        ['membership', actionKeys.membershipAllowed],
      ] as const,
      Effect.fn(function* verifyAllowedAction([kind, actionKey]) {
        const executions: ExecutionCounter = { value: 0 };
        const moduleStateKey = `${actionPrefix}.state.${kind}`;
        yield* runWithLivePermission(database, (runtime) =>
          runtime.runAction({
            payload: undefined,
            principal,
            registration: registration(actionKey, moduleStateKey, incrementExecution.bind(undefined, executions)),
            transport: transport(kind, moduleStateKey),
          }),
        );
        const rows = yield* database.executor
          .select()
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.moduleKey, moduleStateKey));

        expect(executions.value, kind).toBe(1);
        expect(rows.length, kind).toBe(1);
      }),
      { concurrency: 1, discard: true },
    ),
  );

const testProgram2 = () =>
  withDatabase(
    Effect.fn(function* verifyTerminalDenial(database, { actionKeys, actionPrefix, principal, tenantId }) {
      const executions: ExecutionCounter = { value: 0 };
      const key = 'missing';
      const moduleStateKey = `${actionPrefix}.state.missing`;
      const failure = yield* runWithLivePermission(database, (runtime) =>
        runFailedAction(runtime, principal, actionKeys.missing, key, moduleStateKey, executions),
      );
      const [invocation] = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      expect(invocation).toBeDefined();
      if (invocation === undefined) {
        throw new Error('Expected invocation');
      }
      const [audits, businessRows, accesses, events, messages] = yield* Effect.all([
        database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor.select().from(tenantModuleStates).where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
        database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.actionInvocationId, invocation.actionInvocationId)),
        database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
      ]);

      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      expect(failure.reason).toBe('The principal is not permitted to execute this Action');
      expect(executions.value).toBe(0);
      expect(invocation.status).toBe('rejected');
      expect(invocation.completedAt).toBeTruthy();
      expect(businessRows.length).toBe(0);
      expect(accesses.length).toBe(0);
      expect(events.length).toBe(0);
      expect(messages.length).toBe(0);
      expect(audits.length).toBe(1);
      expect({
        eventType: audits[0]?.eventType,
        evidenceJson: audits[0]?.evidenceJson,
        outcome: audits[0]?.outcome,
        outcomeCode: audits[0]?.outcomeCode,
        outcomeStage: audits[0]?.outcomeStage,
      }).toEqual({
        eventType: 'action.rejected',
        evidenceJson: { actionKey: actionKeys.missing },
        outcome: 'denied',
        outcomeCode: 'spicedb_permission_denied',
        outcomeStage: 'authz',
      });
      expect(encodeJson(audits[0]).includes((yield* loadSpiceDbConfig({ envPath: '/dev/null' })).preSharedKey)).toBe(
        false,
      );
    }),
  );

const testProgram3 = () =>
  withDatabase(
    (database, { actionKeys, actionPrefix, legalEntityId, nonMemberPrincipal, otherTenantPrincipal, principal }) =>
      Effect.forEach(
        [
          ['unassigned-capability', actionKeys.denied, principal],
          ['other-tenant', actionKeys.crossTenantDenied, otherTenantPrincipal],
          ['non-member', actionKeys.nonMemberDenied, { ...nonMemberPrincipal, legalEntityId }],
        ] as const,
        Effect.fn(function* verifyDeniedAction([kind, actionKey, deniedPrincipal]) {
          const executions: ExecutionCounter = { value: 0 };
          const moduleStateKey = `${actionPrefix}.state.${kind}`;
          const failure = yield* runWithLivePermission(database, (runtime) =>
            Effect.flip(
              runtime.runAction({
                payload: undefined,
                principal: deniedPrincipal,
                registration: registration(actionKey, moduleStateKey, incrementExecution.bind(undefined, executions)),
                transport: transport(kind, moduleStateKey),
              }),
            ),
          );

          expect(Schema.is(ActionPermissionDenied)(failure), kind).toBe(true);
          expect(executions.value, kind).toBe(0);
        }),
        { concurrency: 1, discard: true },
      ),
  );

const loadDenialEvidence = Effect.fn('loadDenialEvidence')(function* loadDenialEvidence(
  database: ContextServiceContract,
  key: string,
) {
  const [invocation] = yield* database.executor
    .select()
    .from(actionInvocations)
    .where(eq(actionInvocations.idempotencyKey, key));
  if (invocation === undefined) {
    return yield* Effect.die(new Error(`Expected an invocation for ${key}`));
  }
  const audits = yield* database.executor
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));
  return { audits, invocation };
});

const deniedInput = (
  { actionKeys, actionPrefix, principal }: PermissionSuiteFixture,
  key: string,
  executions: ExecutionCounter,
) => {
  const moduleStateKey = `${actionPrefix}.state.${key}`;
  return {
    payload: undefined,
    principal,
    registration: registration(
      actionKeys.concurrentDenied,
      moduleStateKey,
      incrementExecution.bind(undefined, executions),
    ),
    transport: transport(key, moduleStateKey),
  };
};

const testProgram4 = () =>
  withDatabase(
    Effect.fn(function* verifyRetryAfterRecordedDenial(database, suite) {
      const executions: ExecutionCounter = { value: 0 };
      const input = deniedInput(suite, 'retry-after-denial', executions);
      const first = yield* runWithLivePermission(database, (runtime) => Effect.flip(runtime.runAction(input)));
      const retry = yield* runWithLivePermission(database, (runtime) => Effect.flip(runtime.runAction(input)));
      const { audits, invocation } = yield* loadDenialEvidence(database, 'retry-after-denial');

      expect(Schema.is(ActionPermissionDenied)(first)).toBe(true);
      expect(Schema.is(ActionPermissionDenied)(retry)).toBe(true);
      expect(executions.value).toBe(0);
      expect(invocation.status).toBe('rejected');
      expect(audits.length).toBe(1);
    }),
  );

// The first request holds its denial transaction open until the second request has prepared the
// same invocation, so the second request always observes the in-flight denial, never a race.
const withHeldDenialAudit = (database: ContextServiceContract, release: Deferred.Deferred<null>) => {
  const transaction: ContextServiceContract['executor']['transaction'] = (operation) =>
    database.executor.transaction((current) =>
      operation(current).pipe(
        injectStatementFaults((statement) =>
          statement.startsWith('insert into "core"."audit_events"') ? Deferred.await(release) : Effect.void,
        ),
      ),
    );
  const executor: ContextServiceContract['executor'] = Object.assign(Object.create(database.executor), { transaction });
  return { executor };
};

const testProgram4b = () =>
  withDatabase(
    Effect.fn(function* verifyConcurrentDenials(database, suite) {
      const executions: ExecutionCounter = { value: 0 };
      const input = deniedInput(suite, 'concurrent-denied', executions);
      const secondPrepared = yield* Deferred.make<null>();
      const first = yield* Effect.forkChild(
        runWithLivePermission(withHeldDenialAudit(database, secondPrepared), (runtime) =>
          Effect.flip(runtime.runAction(input)),
        ),
      );
      const second = yield* runWithLivePermission(
        database,
        (runtime) => Effect.flip(runtime.runAction(input)),
        undefined,
        (stage) => {
          if (stage === 'invocation_prepared') {
            Deferred.doneUnsafe(secondPrepared, Effect.succeed(null));
          }
        },
      );
      const firstResult = yield* Fiber.join(first);
      const { audits, invocation } = yield* loadDenialEvidence(database, 'concurrent-denied');

      expect(Schema.is(ActionPermissionDenied)(firstResult)).toBe(true);
      expect(Schema.is(ActionPermissionDenied)(second)).toBe(true);
      expect(executions.value).toBe(0);
      expect(invocation.status).toBe('rejected');
      expect(audits.length).toBe(1);
    }),
  );

const testProgram5 = () =>
  withDatabase((database, { actionPrefix, principal }) =>
    Effect.forEach(
      ['audit', 'invocation-update'] as const,
      Effect.fn(function* verifyDenialRollback(stage) {
        const executions: ExecutionCounter = { value: 0 };
        const key = `denial-${stage}`;
        const actionKey = `${actionPrefix}.${stage}`;
        const moduleStateKey = `${actionPrefix}.state.${stage}`;
        const failure = yield* runWithLivePermission(withDenialPersistenceFailure(database, stage), (runtime) =>
          Effect.flip(
            runtime.runAction({
              payload: undefined,
              principal,
              registration: registration(actionKey, moduleStateKey, incrementExecution.bind(undefined, executions)),
              transport: transport(key, moduleStateKey),
            }),
          ),
        );
        const [invocation] = yield* database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, key));
        expect(invocation).toBeDefined();
        if (invocation === undefined) {
          throw new Error('Expected invocation');
        }
        const audits = yield* database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

        expect(Predicate.isTagged(failure, 'ActionTransactionError'), stage).toBe(true);
        expect(executions.value, stage).toBe(0);
        expect(invocation.status, stage).toBe('received');
        expect(invocation.completedAt, stage).toBe(null);
        expect(audits.length, stage).toBe(0);
      }),
      { concurrency: 1, discard: true },
    ),
  );

const testProgram6 = () =>
  withDatabase(
    Effect.fn(function* verifyUnavailablePermissionService(database, { actionKeys, actionPrefix, principal }) {
      const executions: ExecutionCounter = { value: 0 };
      const key = 'invalid-credentials';
      const moduleStateKey = `${actionPrefix}.state.invalid-credentials`;
      const failure = yield* runWithLivePermission(
        database,
        (runtime) => runFailedAction(runtime, principal, actionKeys.unavailable, key, moduleStateKey, executions),
        {
          ...(yield* loadSpiceDbConfig({ envPath: '/dev/null' })),
          preSharedKey: 'invalid-integration-key',
        },
      );
      const [invocation] = yield* database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      expect(invocation).toBeDefined();
      if (invocation === undefined) {
        throw new Error('Expected invocation');
      }
      const audits = yield* database.executor
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.actionInvocationId, invocation.actionInvocationId), eq(auditEvents.outcomeStage, 'authz')),
        );

      expect(Predicate.isTagged(failure, 'ActionPermissionCheckError')).toBe(true);
      expect(failure.reason.includes('invalid-integration-key')).toBe(false);
      expect(executions.value).toBe(0);
      expect(invocation.status).toBe('received');
      expect(invocation.completedAt).toBe(null);
      expect(audits.length).toBe(0);
    }),
  );

it.layer(NodeServices.layer)('Permission suite fixture', (suite) => {
  suite.effect('constructs isolated permission suite identities without borrowing bootstrap credentials', () =>
    Effect.gen(function* verifyPermissionSuiteIdentities() {
      const fixture = yield* makePermissionSuite;
      const identities = [
        fixture.principal,
        fixture.nonMemberPrincipal,
        fixture.bootstrapOwnerPrincipal,
        fixture.otherTenantPrincipal,
        fixture.otherTenantBootstrapOwnerPrincipal,
      ];
      for (const identity of identities) {
        expect(Schema.is(TrustedPrincipalContextSchema)(identity)).toBe(true);
      }
      expect(new Set(identities.map((identity) => identity.principalId)).size).toBe(identities.length);
      expect(new Set(identities.map((identity) => identity.authBindingId)).size).toBe(identities.length);
      expect(new Set(identities.map((identity) => identity.authContextRef)).size).toBe(identities.length);
      expect(fixture.otherTenantId).not.toBe(fixture.tenantId);
      expect(fixture.otherTenantLegalEntityId).not.toBe(fixture.legalEntityId);
      expect(fixture.bootstrapOwnerPrincipal.tenantId).toBe(fixture.tenantId);
      expect(fixture.otherTenantBootstrapOwnerPrincipal.tenantId).toBe(fixture.otherTenantId);
      expect(fixture.otherTenantPrincipal.tenantId).toBe(fixture.otherTenantId);
      expect(fixture.otherTenantPrincipal.legalEntityId).toBe(fixture.otherTenantLegalEntityId);
    }),
  );
});

it.layer(
  Layer.merge(
    PermissionFixture.pipe(
      Layer.provideMerge(Layer.effect(PermissionSuite, makePermissionSuite)),
      Layer.provideMerge(NodeServices.layer),
    ),
    Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
  ),
  {
    excludeTestServices: true,
  },
)('Action permissions', (suite) => {
  suite.effect('allows adopted canonical role cells in the exact company', testProgram1);

  suite.effect('persists one normalized terminal denial and no business or collected evidence', testProgram2);

  suite.effect('denies missing role cells, cross-tenant actors and holders without company membership', testProgram3);

  suite.effect('returns the recorded permission denial to a same-key retry', testProgram4);
  suite.effect('serializes concurrent denials into one Audit Event without executing the handler', testProgram4b);

  suite.effect('rolls back both denial evidence writes when either persistence step fails', testProgram5);

  suite.effect('fails closed for invalid SpiceDB credentials and leaves retryable received evidence', testProgram6);
});
