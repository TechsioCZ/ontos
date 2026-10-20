import { v1 } from '@authzed/authzed-node';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { Context, Crypto, Deferred, Effect, Fiber, Function, Layer, Exit, Option, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionPermissionDenied } from '../../src/actions/errors.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { SHARED_RUNTIME_IDENTITY } from '../../src/db/database-identities.ts';
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
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../src/db/schema.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
import type { OperationalScopeResolverService } from '../../src/operations/context.ts';
import { OperationAuthenticationRequired, OperationContextUnavailable } from '../../src/operations/errors.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import { newSpiceDbGrpcClient } from '../../src/permissions/spicedb-grpc-rpc.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createPermissionCheckClient,
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';
import { testOperationalScopeResolver as baseTestOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { injectStatementFaults } from '../support/database-faults.ts';
import { TestWriteError } from '../support/permission-write-error.ts';
import {
  makePermissionSuite,
  PermissionSuite,
  staffAuthenticationNamespaceId,
} from '../support/action-permission-suite.ts';
import type { PermissionSuiteFixture } from '../support/action-permission-suite.ts';

class PermissionAdmin extends Context.Service<PermissionAdmin, ReturnType<typeof v1.NewClient>>()(
  '@app/core-runtime/tests/integration/action-permission.test/PermissionAdmin',
) {}

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

const withDatabase = <Value, Error, Requirements>(
  operation: (
    database: ContextServiceContract,
    suite: PermissionSuiteFixture,
  ) => Effect.Effect<Value, Error, Requirements>,
) =>
  Effect.scoped(
    Effect.gen(function* databaseScope() {
      const suite = yield* PermissionSuite;
      const configuration = yield* loadDatabaseConfig({ identity: SHARED_RUNTIME_IDENTITY });
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database, suite);
    }),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const relationshipActionKeys = new Set<string>();

type ExecutorSubject =
  | { readonly objectId: string; readonly objectType: 'principal' }
  | {
      readonly objectId: string;
      readonly objectType: 'tenant';
      readonly optionalRelation: 'member';
    };

const relationship = (actionKey: string, relation: 'executor' | 'restriction', executorSubject: ExecutorSubject) => {
  relationshipActionKeys.add(actionKey);
  return v1.Relationship.create({
    relation,
    resource: v1.ObjectReference.create({
      objectId: toSpiceDbActionObjectId(actionKey),
      objectType: 'action',
    }),
    subject: v1.SubjectReference.create({
      object:
        relation === 'restriction'
          ? v1.ObjectReference.create({
              objectId: toSpiceDbActionObjectId(actionKey),
              objectType: 'action',
            })
          : v1.ObjectReference.create({
              objectId: executorSubject.objectId,
              objectType: executorSubject.objectType,
            }),
      optionalRelation:
        relation === 'executor' && executorSubject.objectType === 'tenant' ? executorSubject.optionalRelation : '',
    }),
  });
};

const tenantMembership = (membershipTenantId: string, membershipPrincipalId: string) =>
  v1.Relationship.create({
    relation: 'member',
    resource: v1.ObjectReference.create({
      objectId: membershipTenantId,
      objectType: 'tenant',
    }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({
        objectId: membershipPrincipalId,
        objectType: 'principal',
      }),
    }),
  });

const NoDomainEvents = {};
interface PermissionActionServices {
  readonly transaction: ScopedTransactionExecutor;
}
type PermissionActionContext = ActionHandlerContext<typeof NoDomainEvents, PermissionActionServices>;

const registration = (actionKey: string, moduleStateKey: string, onExecute: () => void) =>
  defineAction(
    {
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
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
        entrypointKey: actionKey,
        moduleKey: 'core.shell',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
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

const PermissionFixture = Layer.effect(
  PermissionAdmin,
  Effect.gen(function* integrationProgram1() {
    const {
      actionKeys,
      legalEntityId,
      nonMemberAuthBindingId,
      nonMemberPrincipalId,
      otherTenantAuthBindingId,
      otherTenantId,
      otherTenantPrincipalId,
      principalAuthBindingId,
      principalId,
      tenantId,
    } = yield* PermissionSuite;
    const principalExecutor: ExecutorSubject = { objectId: principalId, objectType: 'principal' };
    const spiceDbConfig = yield* loadSpiceDbConfig();
    const adminClient = newSpiceDbGrpcClient(spiceDbConfig);

    const prepare = Effect.gen(function* preparePermissionFixture() {
      yield* Effect.promise(() =>
        adminClient.promises.writeSchema(v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA })),
      );
      yield* withDatabase(
        Effect.fn(function* seedPermissionFixture(database) {
          yield* database.executor.insert(tenants).values({
            defaultLocale: 'en',
            name: 'Action Permission Integration',
            slug: `action-permission-${tenantId}`,
            status: 'active',
            tenantId,
          });
          yield* database.executor.insert(tenants).values({
            defaultLocale: 'en',
            name: 'Other Action Permission Tenant',
            slug: `action-permission-other-${otherTenantId}`,
            status: 'active',
            tenantId: otherTenantId,
          });
          yield* database.executor.insert(legalEntities).values({
            legalEntityId,
            legalName: 'Action Permission Integration',
            registrationCountry: 'CZ',
            registrationNumber: tenantId,
            status: 'active',
            tenantId,
          });
          yield* database.executor.insert(principals).values({
            displayName: 'Action Permission Integration',
            kind: 'human',
            principalId,
            status: 'active',
            tenantId,
          });
          yield* database.executor.insert(principals).values([
            {
              displayName: 'Action Permission Non-member',
              kind: 'human',
              principalId: nonMemberPrincipalId,
              status: 'active',
              tenantId,
            },
            {
              displayName: 'Other Tenant Action Permission Member',
              kind: 'human',
              principalId: otherTenantPrincipalId,
              status: 'active',
              tenantId: otherTenantId,
            },
          ]);
          yield* database.executor.insert(principalAuthBindings).values([
            {
              authenticationNamespaceId: staffAuthenticationNamespaceId,
              principalAuthBindingId,
              principalId,
              provider: 'better_auth',
              providerSubjectId: `action-permission-${principalId}`,
              status: 'active',
              subjectType: 'user',
              tenantId,
            },
            {
              authenticationNamespaceId: staffAuthenticationNamespaceId,
              principalAuthBindingId: nonMemberAuthBindingId,
              principalId: nonMemberPrincipalId,
              provider: 'better_auth',
              providerSubjectId: `action-permission-${nonMemberPrincipalId}`,
              status: 'active',
              subjectType: 'user',
              tenantId,
            },
            {
              authenticationNamespaceId: staffAuthenticationNamespaceId,
              principalAuthBindingId: otherTenantAuthBindingId,
              principalId: otherTenantPrincipalId,
              provider: 'better_auth',
              providerSubjectId: `action-permission-${otherTenantPrincipalId}`,
              status: 'active',
              subjectType: 'user',
              tenantId: otherTenantId,
            },
          ]);
        }),
      );

      yield* Effect.promise(() =>
        adminClient.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: [
              relationship(actionKeys.allowed, 'restriction', principalExecutor),
              relationship(actionKeys.allowed, 'executor', principalExecutor),
              relationship(actionKeys.membershipAllowed, 'executor', {
                objectId: tenantId,
                objectType: 'tenant',
                optionalRelation: 'member',
              }),
              relationship(actionKeys.crossTenantDenied, 'executor', {
                objectId: tenantId,
                objectType: 'tenant',
                optionalRelation: 'member',
              }),
              relationship(actionKeys.nonMemberDenied, 'executor', {
                objectId: tenantId,
                objectType: 'tenant',
                optionalRelation: 'member',
              }),
              relationship(actionKeys.denied, 'restriction', principalExecutor),
              relationship(actionKeys.concurrentDenied, 'restriction', principalExecutor),
              tenantMembership(tenantId, principalId),
              tenantMembership(otherTenantId, otherTenantPrincipalId),
            ].map((item) =>
              v1.RelationshipUpdate.create({
                operation: v1.RelationshipUpdate_Operation.TOUCH,
                relationship: item,
              }),
            ),
          }),
        ),
      );
    });

    const cleanup = Effect.gen(function* cleanPermissionFixture() {
      const relationshipCleanupExit = yield* Effect.exit(
        Effect.forEach(
          [...relationshipActionKeys],
          (actionKey) =>
            Effect.promise(() =>
              adminClient.promises.deleteRelationships(
                v1.DeleteRelationshipsRequest.create({
                  relationshipFilter: v1.RelationshipFilter.create({
                    optionalResourceId: toSpiceDbActionObjectId(actionKey),
                    resourceType: 'action',
                  }),
                }),
              ),
            ),
          { discard: true },
        ).pipe(
          Effect.andThen(
            Effect.forEach(
              [tenantId, otherTenantId],
              (membershipTenantId) =>
                Effect.promise(() =>
                  adminClient.promises.deleteRelationships(
                    v1.DeleteRelationshipsRequest.create({
                      relationshipFilter: v1.RelationshipFilter.create({
                        optionalResourceId: membershipTenantId,
                        resourceType: 'tenant',
                      }),
                    }),
                  ),
                ),
              { discard: true },
            ),
          ),
          Effect.ensuring(Effect.sync(() => adminClient.close())),
        ),
      );

      yield* withDatabase((database) =>
        Effect.forEach(
          [
            () => database.executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, otherTenantId)),
            () => database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, otherTenantId)),
            () => database.executor.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, otherTenantId)),
            () => database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, otherTenantId)),
            () => database.executor.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, otherTenantId)),
            () => database.executor.delete(actionInvocations).where(eq(actionInvocations.tenantId, otherTenantId)),
            () => database.executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
            () => database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
            () => database.executor.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
            () => database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
            () => database.executor.delete(tenantModuleStates).where(eq(tenantModuleStates.tenantId, tenantId)),
            () => database.executor.delete(actionInvocations).where(eq(actionInvocations.tenantId, tenantId)),
            () =>
              database.executor.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, otherTenantId)),
            () => database.executor.delete(principalAuthBindings).where(eq(principalAuthBindings.tenantId, tenantId)),
            () => database.executor.delete(principals).where(eq(principals.tenantId, otherTenantId)),
            () => database.executor.delete(principals).where(eq(principals.tenantId, tenantId)),
            () => database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId)),
            () => database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId)),
            () => database.executor.delete(tenants).where(eq(tenants.tenantId, otherTenantId)),
          ],
          (query) => query(),
          { concurrency: 1, discard: true },
        ),
      );

      if (Exit.isFailure(relationshipCleanupExit)) {
        return yield* Effect.failCause(relationshipCleanupExit.cause);
      }
      return null;
    });

    yield* Effect.acquireRelease(prepare, () => cleanup.pipe(Effect.orDie));
    return adminClient;
  }),
);

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
  Effect.gen(function* runWithLivePermissionProgram() {
    const crypto = yield* Crypto.Crypto;
    const config = yield* configuration === undefined ? loadSpiceDbConfig() : Effect.succeed(configuration);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => createPermissionCheckClient(config, SPICEDB_CHECK_TIMEOUT_MS)),
      (client) =>
        operation(
          makeActionRuntime(
            database,
            makeActionRepository(crypto),
            makeActionPermissionService(client),
            testOperationalScopeResolver,
            { ...openActionRuntimeOptions, onStage },
          ),
        ),
      (client) => Effect.sync(() => client.close()),
    );
  });

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
      expect(encodeJson(audits[0]).includes((yield* loadSpiceDbConfig()).preSharedKey)).toBe(false);
    }),
  );

const testProgram3 = () =>
  withDatabase((database, { actionKeys, actionPrefix, nonMemberPrincipal, otherTenantPrincipal, principal }) =>
    Effect.forEach(
      [
        ['legacy-marker', actionKeys.denied, principal],
        ['other-tenant', actionKeys.crossTenantDenied, otherTenantPrincipal],
        ['non-member', actionKeys.nonMemberDenied, nonMemberPrincipal],
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

        expect(Predicate.isTagged(failure, 'ActionPermissionDenied'), kind).toBe(true);
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
  withDatabase((database, { actionPrefix, principal, principalId }) =>
    Effect.forEach(
      ['audit', 'invocation-update'] as const,
      Effect.fn(function* verifyDenialRollback(stage) {
        const executions: ExecutionCounter = { value: 0 };
        const adminClient = yield* PermissionAdmin;
        const key = `denial-${stage}`;
        const actionKey = `${actionPrefix}.${stage}`;
        const moduleStateKey = `${actionPrefix}.state.${stage}`;
        yield* Effect.promise(() =>
          adminClient.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: [
                v1.RelationshipUpdate.create({
                  operation: v1.RelationshipUpdate_Operation.TOUCH,
                  relationship: relationship(actionKey, 'restriction', {
                    objectId: principalId,
                    objectType: 'principal',
                  }),
                }),
              ],
            }),
          ),
        );
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
          ...(yield* loadSpiceDbConfig()),
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

it.layer(
  Layer.merge(
    PermissionFixture.pipe(
      Layer.provideMerge(Layer.effect(PermissionSuite, makePermissionSuite)),
      Layer.provideMerge(NodeCrypto.layer),
    ),
    Layer.succeed(AuthenticationNamespaceRegistry, authenticationNamespaceRegistry),
  ),
  {
    excludeTestServices: true,
  },
)('Action permissions', (suite) => {
  suite.effect('allows direct Principal and Tenant-membership executor grants', testProgram1);

  suite.effect('persists one normalized terminal denial and no business or collected evidence', testProgram2);

  suite.effect('denies a legacy marker without an executor and membership-set outsiders', testProgram3);

  suite.effect('returns the recorded permission denial to a same-key retry', testProgram4);
  suite.effect('serializes concurrent denials into one Audit Event without executing the handler', testProgram4b);

  suite.effect('rolls back both denial evidence writes when either persistence step fails', testProgram5);

  suite.effect('fails closed for invalid SpiceDB credentials and leaves retryable received evidence', testProgram6);
});
