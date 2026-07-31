/* eslint-disable max-classes-per-file, no-await-in-loop, node/no-process-env, promise/prefer-await-to-callbacks -- The integration test owns explicit local dependency configuration, sequential isolated scenarios, and controlled Drizzle transaction faults. */
// @effect-diagnostics asyncFunction:off globalDateInEffect:off processEnv:off
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { v1 } from '@authzed/authzed-node';
import { and, eq } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { defineAction } from '../../src/actions/definition.ts';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import {
  actionInvocations,
  auditEvents,
  dataAccessEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
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
import type { SpiceDbConfigValue } from '../../src/permissions/config.ts';

class TestWriteError extends Schema.TaggedErrorClass<TestWriteError>()('TestWriteError', {
  reason: Schema.String,
}) {}

const suiteId = randomUUID();
const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();
const actionPrefix = `test.permission.${suiteId}`;
const actionKeys = {
  allowed: `${actionPrefix}.allowed`,
  concurrentDenied: `${actionPrefix}.concurrent-denied`,
  denied: `${actionPrefix}.denied`,
  unavailable: `${actionPrefix}.unavailable`,
  unconfigured: `${actionPrefix}.unconfigured`,
} as const;

const principal = {
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
} as const;

const spiceDbConfig: SpiceDbConfigValue = {
  endpoint: process.env['SPICEDB_ENDPOINT'] ?? 'localhost:50051',
  insecureLocal: (process.env['SPICEDB_INSECURE'] ?? 'true') === 'true',
  preSharedKey: process.env['SPICEDB_PRESHARED_KEY'] ?? 'ontos-local-development-key',
};

const transport = (idempotencyKey: string, targetResourceId: string) => ({
  correlationId: `permission-integration-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'shell.core',
  targetResourceId,
  targetResourceType: 'permission-test-state',
});

type ContextServiceShape = Parameters<typeof makeActionRuntime>[0];

const withDatabase = <Value, Error>(
  operation: (database: ContextServiceShape) => Effect.Effect<Value, Error>,
) =>
  Effect.scoped(
    Effect.gen(function* databaseScope() {
      const configuration = yield* loadDatabaseConfig();
      const database = yield* makeCoreDatabase(configuration);
      return yield* operation(database);
    }),
  );

const databasePromise = <Value>(
  operation: (database: ContextServiceShape) => PromiseLike<Value>,
): Promise<Value> =>
  Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

const relationshipActionKeys = new Set<string>();

const relationship = (actionKey: string, relation: 'executor' | 'restriction') => {
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
          : v1.ObjectReference.create({ objectId: principalId, objectType: 'principal' }),
    }),
  });
};

const adminClient = v1.NewClient(
  spiceDbConfig.preSharedKey,
  spiceDbConfig.endpoint,
  spiceDbConfig.insecureLocal
    ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
    : v1.ClientSecurity.SECURE,
);

before(async () => {
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Action Permission Integration',
      slug: `action-permission-${tenantId}`,
      status: 'active',
      tenantId,
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
  });

  await adminClient.promises.writeRelationships(
    v1.WriteRelationshipsRequest.create({
      updates: [
        relationship(actionKeys.allowed, 'restriction'),
        relationship(actionKeys.allowed, 'executor'),
        relationship(actionKeys.denied, 'restriction'),
        relationship(actionKeys.concurrentDenied, 'restriction'),
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
  } catch (error) {
    relationshipCleanupError = error;
  } finally {
    adminClient.close();
  }

  await databasePromise(async (database) => {
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
    await database.executor.delete(principals).where(eq(principals.tenantId, tenantId));
    await database.executor.delete(legalEntities).where(eq(legalEntities.tenantId, tenantId));
    await database.executor.delete(tenants).where(eq(tenants.tenantId, tenantId));
  });

  if (relationshipCleanupError !== undefined) {
    throw relationshipCleanupError instanceof Error
      ? relationshipCleanupError
      : new Error('SpiceDB fixture cleanup failed');
  }
});

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
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    (_payload, context) =>
      Effect.gen(function* permissionIntegrationHandler() {
        onExecute();
        yield* Effect.tryPromise({
          catch: () => new TestWriteError({ reason: 'test business write failed' }),
          try: () =>
            context.transaction.insert(tenantModuleStates).values({
              moduleKey: moduleStateKey,
              state: 'active',
              tenantId: context.principal.tenantId,
            }),
        });
      }),
  );

const runWithLivePermission = async <Value>(
  database: ContextServiceShape,
  operation: (runtime: ReturnType<typeof makeActionRuntime>) => Promise<Value>,
  configuration: SpiceDbConfigValue = spiceDbConfig,
): Promise<Value> => {
  const client = createPermissionCheckClient(configuration, SPICEDB_CHECK_TIMEOUT_MS);
  try {
    return await operation(
      makeActionRuntime(database, makeActionRepository(), makeActionPermissionService(client)),
    );
  } finally {
    client.close();
  }
};

test('allows unconfigured and explicitly granted Actions through the live permission gate', async () => {
  await databasePromise(async (database) => {
    for (const [kind, actionKey] of [
      ['unconfigured', actionKeys.unconfigured],
      ['allowed', actionKeys.allowed],
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
    const key = 'denied';
    const moduleStateKey = `${actionPrefix}.state.denied`;
    const failure = await runWithLivePermission(database, (runtime) =>
      Effect.runPromise(
        Effect.flip(
          runtime.runAction({
            payload: undefined,
            principal,
            registration: registration(actionKeys.denied, moduleStateKey, () => {
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
        evidenceJson: { actionKey: actionKeys.denied },
        outcome: 'denied',
        outcomeCode: 'spicedb_permission_denied',
        outcomeStage: 'authz',
      },
    );
    assert.equal(JSON.stringify(audits[0]).includes(spiceDbConfig.preSharedKey), false);
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
  database: ContextServiceShape,
  stage: DenialFailureStage,
): ContextServiceShape => {
  const executor = new Proxy(database.executor, {
    get(target, property) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (callback: (transaction: object) => PromiseLike<unknown>) =>
        target.transaction(async (transaction) => {
          const faultingTransaction = new Proxy(transaction, {
            get(transactionTarget, operation) {
              const value = Reflect.get(transactionTarget, operation, transactionTarget) as unknown;
              if (
                ((stage === 'audit' && operation === 'insert') ||
                  (stage === 'invocation-update' && operation === 'update')) &&
                typeof value === 'function'
              ) {
                return (table: unknown) => {
                  if (
                    (stage === 'audit' && table === auditEvents) ||
                    (stage === 'invocation-update' && table === actionInvocations)
                  ) {
                    throw new Error(`Injected denial ${stage} failure`);
                  }
                  return (value as (targetTable: unknown) => unknown).call(
                    transactionTarget,
                    table,
                  );
                };
              }
              return typeof value === 'function' ? value.bind(transactionTarget) : value;
            },
          });
          return await callback(faultingTransaction);
        });
    },
  });
  return { executor } as ContextServiceShape;
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
