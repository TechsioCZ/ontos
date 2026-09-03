/* eslint-disable max-classes-per-file, no-await-in-loop, node/no-process-env, promise/prefer-await-to-callbacks -- The integration test owns explicit local dependency configuration, sequential isolated scenarios, and controlled Drizzle transaction faults. */
// @effect-diagnostics asyncFunction:off globalDateInEffect:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
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

const spiceDbConfig = await Effect.runPromise(loadSpiceDbConfig());

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

const databasePromise = <Value>(
  operation: (database: ContextServiceContract) => PromiseLike<Value>,
): Promise<Value> =>
  Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

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

before(async () => {
  await adminClient.promises.writeSchema(
    v1.WriteSchemaRequest.create({ schema: ONTOS_SPICEDB_SCHEMA }),
  );
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Action Permission Integration',
      slug: `action-permission-${tenantId}`,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Other Action Permission Tenant',
      slug: `action-permission-other-${otherTenantId}`,
      status: 'active',
      tenantId: otherTenantId,
    });
    await database.executor.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Action Permission Integration',
      registrationCountry: 'CZ',
      registrationNumber: tenantId,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(principals).values({
      displayName: 'Action Permission Integration',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(principals).values([
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
    await database.executor.insert(principalAuthBindings).values([
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
    ]);
  });

  await adminClient.promises.writeRelationships(
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
  );
});

after(async () => {
  let relationshipCleanupError: unknown;
  try {
    for (const actionKey of relationshipActionKeys) {
      await adminClient.promises.deleteRelationships(
        v1.DeleteRelationshipsRequest.create({
          relationshipFilter: v1.RelationshipFilter.create({
            optionalResourceId: toSpiceDbActionObjectId(actionKey),
            resourceType: 'action',
          }),
        }),
      );
    }
    for (const membershipTenantId of [tenantId, otherTenantId]) {
      await adminClient.promises.deleteRelationships(
        v1.DeleteRelationshipsRequest.create({
          relationshipFilter: v1.RelationshipFilter.create({
            optionalResourceId: membershipTenantId,
            resourceType: 'tenant',
          }),
        }),
      );
    }
  } catch (error) {
    relationshipCleanupError = error;
  } finally {
    adminClient.close();
  }

  await databasePromise(async (database) => {
    await database.executor
      .delete(outboxMessages)
      .where(eq(outboxMessages.tenantId, otherTenantId));
    await database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, otherTenantId));
    await database.executor
      .delete(dataAccessEvents)
      .where(eq(dataAccessEvents.tenantId, otherTenantId));
    await database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, otherTenantId));
    await database.executor
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, otherTenantId));
    await database.executor
      .delete(actionInvocations)
      .where(eq(actionInvocations.tenantId, otherTenantId));
    await database.executor.delete(outboxMessages).where(eq(outboxMessages.tenantId, tenantId));
    await database.executor.delete(domainEvents).where(eq(domainEvents.tenantId, tenantId));
    await database.executor.delete(dataAccessEvents).where(eq(dataAccessEvents.tenantId, tenantId));
    await database.executor.delete(auditEvents).where(eq(auditEvents.tenantId, tenantId));
    await database.executor
      .delete(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, tenantId));
    await database.executor
      .delete(actionInvocations)
      .where(eq(actionInvocations.tenantId, tenantId));
    await database.executor
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, otherTenantId));
    await database.executor
      .delete(principalAuthBindings)
      .where(eq(principalAuthBindings.tenantId, tenantId));
    await database.executor.delete(principals).where(eq(principals.tenantId, otherTenantId));
    await database.executor.delete(principals).where(eq(principals.tenantId, tenantId));
    await database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
    await database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId));
    await database.executor.delete(tenants).where(eq(tenants.tenantId, otherTenantId));
  });

  if (relationshipCleanupError !== undefined) {
    throw relationshipCleanupError instanceof Error
      ? relationshipCleanupError
      : new Error('SpiceDB fixture cleanup failed');
  }
});

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

const runWithLivePermission = async <Value>(
  database: ContextServiceContract,
  operation: (runtime: ReturnType<typeof makeActionRuntime>) => Promise<Value>,
  configuration: SpiceDbConfigValue = spiceDbConfig,
): Promise<Value> => {
  const client = createPermissionCheckClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
  try {
    return await operation(
      makeActionRuntime(
        database,
        makeActionRepository(),
        makeActionPermissionService(client),
        testOperationalScopeResolver,
        openActionRuntimeOptions,
      ),
    );
  } finally {
    client.close();
  }
};

test('allows direct Principal and Tenant-membership executor grants', async () => {
  await databasePromise(async (database) => {
    for (const [kind, actionKey] of [
      ['direct', actionKeys.allowed],
      ['membership', actionKeys.membershipAllowed],
    ] as const) {
      let executions = 0;
      const moduleStateKey = `${actionPrefix}.state.${kind}`;
      await runWithLivePermission(database, (runtime) =>
        Effect.runPromise(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: registration(actionKey, moduleStateKey, () => {
              executions += 1;
            }),
            transport: transport(kind, moduleStateKey),
          }),
        ),
      );
      const rows = await database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));

      assert.equal(executions, 1, kind);
      assert.equal(rows.length, 1, kind);
    }
  });
});

test('persists one normalized terminal denial and no business or collected evidence', async () => {
  await databasePromise(async (database) => {
    let executions = 0;
    const key = 'missing';
    const moduleStateKey = `${actionPrefix}.state.missing`;
    const failure = await runWithLivePermission(database, (runtime) =>
      Effect.runPromise(
        Effect.flip(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: registration(actionKeys.missing, moduleStateKey, () => {
              executions += 1;
            }),
            transport: transport(key, moduleStateKey),
          }),
        ),
      ),
    );
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const [audits, businessRows, accesses, events, messages] = await Promise.all([
      database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId)),
      database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
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

    assert.equal(failure._tag, 'ActionPermissionDenied');
    assert.equal(failure.reason, 'The principal is not permitted to execute this Action');
    assert.equal(executions, 0);
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
    assert.equal(JSON.stringify(audits[0]).includes(spiceDbConfig.preSharedKey), false);
  });
});

test('denies a legacy marker without an executor and membership-set outsiders', async () => {
  await databasePromise(async (database) => {
    for (const [kind, actionKey, deniedPrincipal] of [
      ['legacy-marker', actionKeys.denied, principal],
      ['other-tenant', actionKeys.crossTenantDenied, otherTenantPrincipal],
      ['non-member', actionKeys.nonMemberDenied, nonMemberPrincipal],
    ] as const) {
      let executions = 0;
      const moduleStateKey = `${actionPrefix}.state.${kind}`;
      const failure = await runWithLivePermission(database, (runtime) =>
        Effect.runPromise(
          Effect.flip(
            runtime.runAction({
              payload: undefined,
              principal: deniedPrincipal,
              registration: registration(actionKey, moduleStateKey, () => {
                executions += 1;
              }),
              transport: transport(kind, moduleStateKey),
            }),
          ),
        ),
      );

      assert.equal(failure._tag, 'ActionPermissionDenied', kind);
      assert.equal(executions, 0, kind);
    }
  });
});

test('serializes concurrent denials into one Audit Event without executing the handler', async () => {
  await databasePromise(async (database) => {
    let executions = 0;
    const key = 'concurrent-denied';
    const moduleStateKey = `${actionPrefix}.state.concurrent-denied`;
    const input = {
      payload: undefined,
      principal,
      registration: registration(actionKeys.concurrentDenied, moduleStateKey, () => {
        executions += 1;
      }),
      transport: transport(key, moduleStateKey),
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        runWithLivePermission(database, (runtime) =>
          Effect.runPromise(Effect.flip(runtime.runAction(input))),
        ),
      ),
    );
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

    assert.deepEqual(
      results.map((result) => result._tag),
      ['ActionPermissionDenied', 'ActionPermissionDenied'],
    );
    assert.equal(executions, 0);
    assert.equal(invocation.status, 'rejected');
    assert.equal(audits.length, 1);
  });
});

type DenialFailureStage = 'audit' | 'invocation-update';

const withDenialPersistenceFailure = (
  database: ContextServiceContract,
  stage: DenialFailureStage,
): ContextServiceContract => {
  const transactionOverride = {
    transaction: (callback, configuration) =>
      database.executor.transaction((transaction) => {
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
        const faultingTransaction: typeof transaction = Object.assign(Object.create(transaction), {
          insert,
          update,
        });
        return callback(faultingTransaction);
      }, configuration),
  } satisfies Pick<ContextServiceContract['executor'], 'transaction'>;
  const executor: ContextServiceContract['executor'] = Object.assign(
    Object.create(database.executor),
    transactionOverride,
  );
  return { executor };
};

test('rolls back both denial evidence writes when either persistence step fails', async () => {
  await databasePromise(async (database) => {
    for (const stage of ['audit', 'invocation-update'] as const) {
      let executions = 0;
      const key = `denial-${stage}`;
      const actionKey = `${actionPrefix}.${stage}`;
      const moduleStateKey = `${actionPrefix}.state.${stage}`;
      await adminClient.promises.writeRelationships(
        v1.WriteRelationshipsRequest.create({
          updates: [
            v1.RelationshipUpdate.create({
              operation: v1.RelationshipUpdate_Operation.TOUCH,
              relationship: relationship(actionKey, 'restriction'),
            }),
          ],
        }),
      );
      const failure = await runWithLivePermission(
        withDenialPersistenceFailure(database, stage),
        (runtime) =>
          Effect.runPromise(
            Effect.flip(
              runtime.runAction({
                payload: undefined,
                principal,
                registration: registration(actionKey, moduleStateKey, () => {
                  executions += 1;
                }),
                transport: transport(key, moduleStateKey),
              }),
            ),
          ),
      );
      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      assert.ok(invocation);
      const audits = await database.executor
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.actionInvocationId, invocation.actionInvocationId));

      assert.equal(failure._tag, 'ActionTransactionError', stage);
      assert.equal(executions, 0, stage);
      assert.equal(invocation.status, 'received', stage);
      assert.equal(invocation.completedAt, null, stage);
      assert.equal(audits.length, 0, stage);
    }
  });
});

test('fails closed for invalid SpiceDB credentials and leaves retryable received evidence', async () => {
  await databasePromise(async (database) => {
    let executions = 0;
    const key = 'invalid-credentials';
    const moduleStateKey = `${actionPrefix}.state.invalid-credentials`;
    const failure = await runWithLivePermission(
      database,
      (runtime) =>
        Effect.runPromise(
          Effect.flip(
            runtime.runAction({
              payload: undefined,
              principal,
              registration: registration(actionKeys.unavailable, moduleStateKey, () => {
                executions += 1;
              }),
              transport: transport(key, moduleStateKey),
            }),
          ),
        ),
      { ...spiceDbConfig, preSharedKey: 'invalid-integration-key' },
    );
    const [invocation] = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    assert.ok(invocation);
    const audits = await database.executor
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actionInvocationId, invocation.actionInvocationId),
          eq(auditEvents.outcomeStage, 'authz'),
        ),
      );

    assert.equal(failure._tag, 'ActionPermissionCheckError');
    assert.equal(failure.reason.includes('invalid-integration-key'), false);
    assert.equal(executions, 0);
    assert.equal(invocation.status, 'received');
    assert.equal(invocation.completedAt, null);
    assert.equal(audits.length, 0);
  });
});
