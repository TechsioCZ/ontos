import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit, Schema, flow } from 'effect';
import type { ActionHandlerContext } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { testOperationalScopeResolver } from '../fixtures/operational-scope.ts';
import { openActionRuntimeOptions } from '../support/action-runtime-options.ts';
import { defineSystemModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import type { ScopedTransactionExecutor } from '../../src/db/scoped-transaction.ts';
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
import {
  SPICEDB_CHECK_TIMEOUT_MS,
  createPermissionCheckClient,
  makeActionPermissionService,
  toSpiceDbActionObjectId,
} from '../../src/permissions/service.ts';
import { loadSpiceDbConfig } from '../../src/permissions/config.ts';
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

class TestWriteError extends Schema.TaggedError<TestWriteError>()('TestWriteError', {
  reason: Schema.String,
}) {}

const suiteId = randomUUID();
const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const principalAuthBindingId = randomUUID();
const nonMemberPrincipalId = randomUUID();
const nonMemberAuthBindingId = randomUUID();
const otherTenantId = randomUUID();
const otherTenantPrincipalId = randomUUID();
const otherTenantAuthBindingId = randomUUID();
const actionPrefix = `test.permission.${suiteId}`;
const actionKeys = {
  allowed: `${actionPrefix}.allowed`,
  concurrentDenied: `${actionPrefix}.concurrent-denied`,
  crossTenantDenied: `${actionPrefix}.cross-tenant-denied`,
  denied: `${actionPrefix}.denied`,
  membershipAllowed: `${actionPrefix}.membership-allowed`,
  missing: `${actionPrefix}.missing`,
  nonMemberDenied: `${actionPrefix}.non-member-denied`,
  unavailable: `${actionPrefix}.unavailable`,
} as const;

const principal = {
  authBindingId: principalAuthBindingId,
  authContextRef: `better-auth-session:${suiteId}:principal`,
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
} as const;

const nonMemberPrincipal = {
  authBindingId: nonMemberAuthBindingId,
  authContextRef: `better-auth-session:${suiteId}:non-member`,
  authMethod: 'session',
  principalId: nonMemberPrincipalId,
  tenantId,
} as const;

const otherTenantPrincipal = {
  authBindingId: otherTenantAuthBindingId,
  authContextRef: `better-auth-session:${suiteId}:other-tenant`,
  authMethod: 'session',
  principalId: otherTenantPrincipalId,
  tenantId: otherTenantId,
} as const;

const spiceDbConfig = await runEffectTestPromise(loadSpiceDbConfig());

const transport = (idempotencyKey: string, targetResourceId: string) => ({
  correlationId: `permission-integration-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'core.shell',
  targetResourceId,
  targetResourceType: 'permission-test-state',
});

type ContextServiceContract = Parameters<typeof makeActionRuntime>[0];

const withDatabase = <Value, Error>(
  operation: (database: ContextServiceContract) => Effect.Effect<Value, Error>,
) =>
  Effect.scoped(
    Effect.gen(function* databaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database);
    }),
  );

const effectCallback = <Value, Error>(effect: Effect.Effect<Value, Error>) =>
  flow(() => Effect.asVoid(effect), runEffectTestPromise);

const effectTest = <Value, Error>(name: string, effect: Effect.Effect<Value, Error>): void => {
  test(name, effectCallback(effect));
};

const databaseEffect = <Value>(operation: () => PromiseLike<Value>) =>
  Effect.promise(() => operation());
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const promiseEffect = <Value>(promise: PromiseLike<Value>): Effect.Effect<Value> =>
  Effect.promise(flow(() => promise));

const relationshipActionKeys = new Set<string>();

type ExecutorSubject =
  | { readonly objectId: string; readonly objectType: 'principal' }
  | {
      readonly objectId: string;
      readonly objectType: 'tenant';
      readonly optionalRelation: 'member';
    };

const defaultExecutorSubject: ExecutorSubject = {
  objectId: principalId,
  objectType: 'principal',
};

const relationship = (
  actionKey: string,
  relation: 'executor' | 'restriction',
  executorSubject: ExecutorSubject = defaultExecutorSubject,
) => {
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
        relation === 'executor' && executorSubject.objectType === 'tenant'
          ? executorSubject.optionalRelation
          : '',
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

const adminClient = v1.NewClient(
  spiceDbConfig.preSharedKey,
  spiceDbConfig.endpoint,
  spiceDbConfig.insecureLocal
    ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
    : v1.ClientSecurity.SECURE,
);

Effect.gen(function* preparePermissionFixture() {
  yield* promiseEffect(
    adminClient.promises.writeSchema(
      v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }),
    ),
  );
  yield* withDatabase((database) =>
    Effect.gen(function* seedPermissionFixture() {
      yield* databaseEffect(() =>
        database.executor.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Action Permission Integration',
          slug: `action-permission-${tenantId}`,
          status: 'active',
          tenantId,
        }),
      );
      yield* databaseEffect(() =>
        database.executor.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Other Action Permission Tenant',
          slug: `action-permission-other-${otherTenantId}`,
          status: 'active',
          tenantId: otherTenantId,
        }),
      );
      yield* databaseEffect(() =>
        database.executor.insert(legalEntities).values({
          legalEntityId,
          legalName: 'Action Permission Integration',
          registrationCountry: 'CZ',
          registrationNumber: tenantId,
          status: 'active',
          tenantId,
        }),
      );
      yield* databaseEffect(() =>
        database.executor.insert(principals).values({
          displayName: 'Action Permission Integration',
          kind: 'human',
          principalId,
          status: 'active',
          tenantId,
        }),
      );
      yield* databaseEffect(() =>
        database.executor.insert(principals).values([
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
        ]),
      );
      yield* databaseEffect(() =>
        database.executor.insert(principalAuthBindings).values([
          {
            principalAuthBindingId,
            principalId,
            provider: 'better_auth',
            providerSubjectId: `action-permission-${principalId}`,
            status: 'active',
            subjectType: 'user',
            tenantId,
          },
          {
            principalAuthBindingId: nonMemberAuthBindingId,
            principalId: nonMemberPrincipalId,
            provider: 'better_auth',
            providerSubjectId: `action-permission-${nonMemberPrincipalId}`,
            status: 'active',
            subjectType: 'user',
            tenantId,
          },
          {
            principalAuthBindingId: otherTenantAuthBindingId,
            principalId: otherTenantPrincipalId,
            provider: 'better_auth',
            providerSubjectId: `action-permission-${otherTenantPrincipalId}`,
            status: 'active',
            subjectType: 'user',
            tenantId: otherTenantId,
          },
        ]),
      );
    }),
  );

  yield* promiseEffect(
    adminClient.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: [
          relationship(actionKeys.allowed, 'restriction'),
          relationship(actionKeys.allowed, 'executor'),
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
          relationship(actionKeys.denied, 'restriction'),
          relationship(actionKeys.concurrentDenied, 'restriction'),
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
}).pipe(effectCallback, before);

Effect.gen(function* cleanPermissionFixture() {
  const relationshipCleanupExit = yield* Effect.exit(
    Effect.all(
      [...relationshipActionKeys].map((actionKey) =>
        promiseEffect(
          adminClient.promises.deleteRelationships(
            v1.DeleteRelationshipsRequest.create({
              relationshipFilter: v1.RelationshipFilter.create({
                optionalResourceId: toSpiceDbActionObjectId(actionKey),
                resourceType: 'action',
              }),
            }),
          ),
        ),
      ),
      { discard: true },
    ).pipe(
      Effect.andThen(
        Effect.all(
          [tenantId, otherTenantId].map((membershipTenantId) =>
            promiseEffect(
              adminClient.promises.deleteRelationships(
                v1.DeleteRelationshipsRequest.create({
                  relationshipFilter: v1.RelationshipFilter.create({
                    optionalResourceId: membershipTenantId,
                    resourceType: 'tenant',
                  }),
                }),
              ),
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
        () =>
          database.executor
            .delete(outboxMessages)
            .where(eq(outboxMessages.tenantId, otherTenantId)),
        () =>
          database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, otherTenantId)),
        () =>
          database.executor
            .delete(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, otherTenantId)),
        () => database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, otherTenantId)),
        () =>
          database.executor
            .delete(tenantModuleStates)
            .where(eq(tenantModuleStates.tenantId, otherTenantId)),
        () =>
          database.executor
            .delete(actionInvocations)
            .where(eq(actionInvocations.tenantId, otherTenantId)),
        () => database.executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
        () => database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId)),
        () =>
          database.executor.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId)),
        () => database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
        () =>
          database.executor
            .delete(tenantModuleStates)
            .where(eq(tenantModuleStates.tenantId, tenantId)),
        () =>
          database.executor
            .delete(actionInvocations)
            .where(eq(actionInvocations.tenantId, tenantId)),
        () =>
          database.executor
            .delete(principalAuthBindings)
            .where(eq(principalAuthBindings.tenantId, otherTenantId)),
        () =>
          database.executor
            .delete(principalAuthBindings)
            .where(eq(principalAuthBindings.tenantId, tenantId)),
        () => database.executor.delete(principals).where(eq(principals.tenantId, otherTenantId)),
        () => database.executor.delete(principals).where(eq(principals.tenantId, tenantId)),
        () => database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId)),
        () => database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId)),
        () => database.executor.delete(tenants).where(eq(tenants.tenantId, otherTenantId)),
      ],
      databaseEffect,
      { concurrency: 1, discard: true },
    ),
  );

  if (Exit.isFailure(relationshipCleanupExit)) {
    return yield* Effect.failCause(relationshipCleanupExit.cause);
  }
  return null;
}).pipe(effectCallback, after);

const NoDomainEvents = {};
interface PermissionActionServices {
  readonly transaction: ScopedTransactionExecutor;
}
type PermissionActionContext = ActionHandlerContext<
  typeof NoDomainEvents,
  PermissionActionServices
>;

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
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
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
    (_payload, context: PermissionActionContext) =>
      Effect.gen(function* permissionIntegrationHandler() {
        onExecute();
        yield* Effect.tryPromise({
          catch: () => new TestWriteError({ reason: 'test business write failed' }),
          try: () =>
            context.services.transaction.insert(tenantModuleStates).values({
              moduleKey: moduleStateKey,
              state: 'active',
              tenantId: context.scope.tenantId,
            }),
        });
      }),
    (transaction) => Effect.succeed({ transaction }),
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
  configuration: SpiceDbConfigValue = spiceDbConfig,
): Effect.Effect<Value, Error> =>
  Effect.acquireUseRelease(
    Effect.sync(() => createPermissionCheckClient(configuration, SPICEDB_CHECK_TIMEOUT_MS)),
    (client) =>
      operation(
        makeActionRuntime(
          database,
          makeActionRepository(),
          makeActionPermissionService(client),
          testOperationalScopeResolver,
          openActionRuntimeOptions,
        ),
      ),
    (client) => Effect.sync(() => client.close()),
  );

effectTest(
  'allows direct Principal and Tenant-membership executor grants',
  withDatabase((database) =>
    Effect.forEach(
      [
        ['direct', actionKeys.allowed],
        ['membership', actionKeys.membershipAllowed],
      ] as const,
      ([kind, actionKey]) =>
        Effect.gen(function* verifyAllowedAction() {
          const executions: ExecutionCounter = { value: 0 };
          const moduleStateKey = `${actionPrefix}.state.${kind}`;
          yield* runWithLivePermission(database, (runtime) =>
            runtime.runAction({
              payload: undefined,
              principal,
              registration: registration(
                actionKey,
                moduleStateKey,
                incrementExecution.bind(undefined, executions),
              ),
              transport: transport(kind, moduleStateKey),
            }),
          );
          const rows = yield* databaseEffect(() =>
            database.executor
              .select()
              .from(tenantModuleStates)
              .where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
          );

          assert.equal(executions.value, 1, kind);
          assert.equal(rows.length, 1, kind);
        }),
      { concurrency: 1, discard: true },
    ),
  ),
);

effectTest(
  'persists one normalized terminal denial and no business or collected evidence',
  withDatabase((database) =>
    Effect.gen(function* verifyTerminalDenial() {
      const executions: ExecutionCounter = { value: 0 };
      const key = 'missing';
      const moduleStateKey = `${actionPrefix}.state.missing`;
      const failure = yield* runWithLivePermission(database, (runtime) =>
        Effect.flip(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: registration(
              actionKeys.missing,
              moduleStateKey,
              incrementExecution.bind(undefined, executions),
            ),
            transport: transport(key, moduleStateKey),
          }),
        ),
      );
      const [invocation] = yield* databaseEffect(() =>
        database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, key)),
      );
      assert.ok(invocation);
      const [audits, businessRows, accesses, events, messages] = yield* Effect.all([
        databaseEffect(() =>
          database.executor
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
        ),
        databaseEffect(() =>
          database.executor
            .select()
            .from(tenantModuleStates)
            .where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
        ),
        databaseEffect(() =>
          database.executor
            .select()
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.actionInvocationId, invocation.actionInvocationId)),
        ),
        databaseEffect(() =>
          database.executor
            .select()
            .from(domainEvents)
            .where(eq(domainEvents.actionInvocationId, invocation.actionInvocationId)),
        ),
        databaseEffect(() =>
          database.executor
            .select()
            .from(outboxMessages)
            .where(eq(outboxMessages.tenantId, tenantId)),
        ),
      ]);

      assert.equal(failure._tag, 'ActionPermissionDenied');
      assert.equal(failure.reason, 'The principal is not permitted to execute this Action');
      assert.equal(executions.value, 0);
      assert.equal(invocation.status, 'rejected');
      assert.ok(invocation.completedAt);
      assert.equal(businessRows.length, 0);
      assert.equal(accesses.length, 0);
      assert.equal(events.length, 0);
      assert.equal(messages.length, 0);
      assert.equal(audits.length, 1);
      assert.deepEqual(
        {
          eventType: audits[0]?.eventType,
          evidenceJson: audits[0]?.evidenceJson,
          outcome: audits[0]?.outcome,
          outcomeCode: audits[0]?.outcomeCode,
          outcomeStage: audits[0]?.outcomeStage,
        },
        {
          eventType: 'action.rejected',
          evidenceJson: { actionKey: actionKeys.missing },
          outcome: 'denied',
          outcomeCode: 'spicedb_permission_denied',
          outcomeStage: 'authz',
        },
      );
      assert.equal(encodeJson(audits[0]).includes(spiceDbConfig.preSharedKey), false);
    }),
  ),
);

effectTest(
  'denies a legacy marker without an executor and membership-set outsiders',
  withDatabase((database) =>
    Effect.forEach(
      [
        ['legacy-marker', actionKeys.denied, principal],
        ['other-tenant', actionKeys.crossTenantDenied, otherTenantPrincipal],
        ['non-member', actionKeys.nonMemberDenied, nonMemberPrincipal],
      ] as const,
      ([kind, actionKey, deniedPrincipal]) =>
        Effect.gen(function* verifyDeniedAction() {
          const executions: ExecutionCounter = { value: 0 };
          const moduleStateKey = `${actionPrefix}.state.${kind}`;
          const failure = yield* runWithLivePermission(database, (runtime) =>
            Effect.flip(
              runtime.runAction({
                payload: undefined,
                principal: deniedPrincipal,
                registration: registration(
                  actionKey,
                  moduleStateKey,
                  incrementExecution.bind(undefined, executions),
                ),
                transport: transport(kind, moduleStateKey),
              }),
            ),
          );

          assert.equal(failure._tag, 'ActionPermissionDenied', kind);
          assert.equal(executions.value, 0, kind);
        }),
      { concurrency: 1, discard: true },
    ),
  ),
);

effectTest(
  'serializes concurrent denials into one Audit Event without executing the handler',
  withDatabase((database) =>
    Effect.gen(function* verifyConcurrentDenials() {
      const executions: ExecutionCounter = { value: 0 };
      const key = 'concurrent-denied';
      const moduleStateKey = `${actionPrefix}.state.concurrent-denied`;
      const input = {
        payload: undefined,
        principal,
        registration: registration(
          actionKeys.concurrentDenied,
          moduleStateKey,
          incrementExecution.bind(undefined, executions),
        ),
        transport: transport(key, moduleStateKey),
      };
      const results = yield* Effect.all(
        [1, 2].map(() =>
          runWithLivePermission(database, (runtime) => Effect.flip(runtime.runAction(input))),
        ),
        { concurrency: 'unbounded' },
      );
      const [invocation] = yield* databaseEffect(() =>
        database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, key)),
      );
      assert.ok(invocation);
      const audits = yield* databaseEffect(() =>
        database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
      );

      assert.deepEqual(
        results.map((result) => result._tag),
        ['ActionPermissionDenied', 'ActionPermissionDenied'],
      );
      assert.equal(executions.value, 0);
      assert.equal(invocation.status, 'rejected');
      assert.equal(audits.length, 1);
    }),
  ),
);

const DenialFailureStageSchema = Schema.Literals(['audit', 'invocation-update']);
type DenialFailureStage = typeof DenialFailureStageSchema.Type;

const withDenialPersistenceFailure = (
  database: ContextServiceContract,
  stage: DenialFailureStage,
): ContextServiceContract => {
  const executor: ContextServiceContract['executor'] = Object.create(database.executor);
  Object.defineProperty(executor, 'transaction', {
    configurable: true,
    value: (
      operation: Parameters<ContextServiceContract['executor']['transaction']>[0],
      configuration: Parameters<ContextServiceContract['executor']['transaction']>[1],
    ): object => {
      const transactionWork: { execute: typeof operation } = Object.create(null);
      Object.defineProperty(transactionWork, 'execute', {
        configurable: true,
        value: (transaction: Parameters<typeof operation>[0]): object => {
          const insert: typeof transaction.insert = (table) => {
            if (stage === 'audit' && Object.is(table, auditEvents)) {
              throw new Error(`Injected denial ${stage} failure`);
            }
            return transaction.insert(table);
          };
          const update: typeof transaction.update = (table) => {
            if (stage === 'invocation-update' && Object.is(table, actionInvocations)) {
              throw new Error(`Injected denial ${stage} failure`);
            }
            return transaction.update(table);
          };
          const faultingTransaction: typeof transaction = Object.assign(
            Object.create(transaction),
            { insert, update },
          );
          return operation(faultingTransaction);
        },
      });
      return database.executor.transaction(
        transactionWork.execute.bind(transactionWork),
        configuration,
      );
    },
  });
  return { executor };
};

effectTest(
  'rolls back both denial evidence writes when either persistence step fails',
  withDatabase((database) =>
    Effect.forEach(
      ['audit', 'invocation-update'] as const,
      (stage) =>
        Effect.gen(function* verifyDenialRollback() {
          const executions: ExecutionCounter = { value: 0 };
          const key = `denial-${stage}`;
          const actionKey = `${actionPrefix}.${stage}`;
          const moduleStateKey = `${actionPrefix}.state.${stage}`;
          yield* promiseEffect(
            adminClient.promises.writeRelationships(
              v1.WriteRelationshipsRequest.create({
                updates: [
                  v1.RelationshipUpdate.create({
                    operation: v1.RelationshipUpdate_Operation.TOUCH,
                    relationship: relationship(actionKey, 'restriction'),
                  }),
                ],
              }),
            ),
          );
          const failure = yield* runWithLivePermission(
            withDenialPersistenceFailure(database, stage),
            (runtime) =>
              Effect.flip(
                runtime.runAction({
                  payload: undefined,
                  principal,
                  registration: registration(
                    actionKey,
                    moduleStateKey,
                    incrementExecution.bind(undefined, executions),
                  ),
                  transport: transport(key, moduleStateKey),
                }),
              ),
          );
          const [invocation] = yield* databaseEffect(() =>
            database.executor
              .select()
              .from(actionInvocations)
              .where(eq(actionInvocations.idempotencyKey, key)),
          );
          assert.ok(invocation);
          const audits = yield* databaseEffect(() =>
            database.executor
              .select()
              .from(auditEvents)
              .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
          );

          assert.equal(failure._tag, 'ActionTransactionError', stage);
          assert.equal(executions.value, 0, stage);
          assert.equal(invocation.status, 'received', stage);
          assert.equal(invocation.completedAt, null, stage);
          assert.equal(audits.length, 0, stage);
        }),
      { concurrency: 1, discard: true },
    ),
  ),
);

effectTest(
  'fails closed for invalid SpiceDB credentials and leaves retryable received evidence',
  withDatabase((database) =>
    Effect.gen(function* verifyUnavailablePermissionService() {
      const executions: ExecutionCounter = { value: 0 };
      const key = 'invalid-credentials';
      const moduleStateKey = `${actionPrefix}.state.invalid-credentials`;
      const failure = yield* runWithLivePermission(
        database,
        (runtime) =>
          Effect.flip(
            runtime.runAction({
              payload: undefined,
              principal,
              registration: registration(
                actionKeys.unavailable,
                moduleStateKey,
                incrementExecution.bind(undefined, executions),
              ),
              transport: transport(key, moduleStateKey),
            }),
          ),
        { ...spiceDbConfig, preSharedKey: 'invalid-integration-key' },
      );
      const [invocation] = yield* databaseEffect(() =>
        database.executor
          .select()
          .from(actionInvocations)
          .where(eq(actionInvocations.idempotencyKey, key)),
      );
      assert.ok(invocation);
      const audits = yield* databaseEffect(() =>
        database.executor
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.actionInvocationId, invocation.actionInvocationId),
              eq(auditEvents.outcomeStage, 'authz'),
            ),
          ),
      );

      assert.equal(failure._tag, 'ActionPermissionCheckError');
      assert.equal(failure.reason.includes('invalid-integration-key'), false);
      assert.equal(executions.value, 0);
      assert.equal(invocation.status, 'received');
      assert.equal(invocation.completedAt, null);
      assert.equal(audits.length, 0);
    }),
  ),
);
