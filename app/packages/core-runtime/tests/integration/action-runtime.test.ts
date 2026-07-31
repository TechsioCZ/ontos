/* eslint-disable max-classes-per-file, no-await-in-loop, no-throw-literal, node/callback-return, promise/prefer-await-to-callbacks -- Test-local typed errors, ordered rollback scenarios, simulated driver failures, and Drizzle callback seams are deliberate. */
import assert from 'node:assert/strict';
// @effect-diagnostics asyncFunction:off globalDateInEffect:off
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import { eq } from 'drizzle-orm';
import { Cause, Deferred, Effect, Exit, Schema } from 'effect';
import { makeActionRepository } from '../../src/actions/repository.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionInvocationPersistenceError } from '../../src/actions/errors.ts';
import type { DomainEventReference } from '../../src/actions/events.ts';
import { makeActionRuntime } from '../../src/actions/runtime.ts';
import { loadDatabaseConfig } from '../../src/db/config.ts';
import { makeCoreDatabase } from '../../src/db/client.ts';
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

class TestPersistenceError extends Schema.TaggedErrorClass<TestPersistenceError>()(
  'TestPersistenceError',
  {
    reason: Schema.String,
  },
) {}

class TestDomainRejected extends Schema.TaggedErrorClass<TestDomainRejected>()(
  'TestDomainRejected',
  {
    reason: Schema.String,
  },
) {}

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const principalId = randomUUID();

const principal = {
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId,
} as const;

const transport = (idempotencyKey: string, targetResourceId = 'primary') => ({
  correlationId: `integration-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'shell.core',
  targetResourceId,
  targetResourceType: 'test-state',
});

const unconfiguredPermission = {
  checkActionPermission: () => Effect.succeed('unconfigured' as const),
};

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

type ContextServiceShape = Parameters<typeof makeActionRuntime>[0];

type EvidencePersistenceStage =
  | 'audit'
  | 'data-access'
  | 'domain-event'
  | 'invocation-success'
  | 'outbox';

const withEvidencePersistenceFailure = (
  database: ContextServiceShape,
  stage: EvidencePersistenceStage,
): ContextServiceShape => {
  const shouldFail = (operation: PropertyKey, table: unknown): boolean =>
    (operation === 'insert' && stage === 'audit' && table === auditEvents) ||
    (operation === 'insert' && stage === 'data-access' && table === dataAccessEvents) ||
    (operation === 'insert' && stage === 'domain-event' && table === domainEvents) ||
    (operation === 'insert' && stage === 'outbox' && table === outboxMessages) ||
    (operation === 'update' && stage === 'invocation-success' && table === actionInvocations);

  const executor = new Proxy(database.executor, {
    get(target, property) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }

      const transactionMethod = target.transaction as unknown as (
        callback: (transaction: object) => PromiseLike<unknown>,
      ) => Promise<unknown>;
      return (callback: (transaction: object) => PromiseLike<unknown>) =>
        transactionMethod.call(target, (transaction) => {
          const faultingTransaction = new Proxy(transaction, {
            get(transactionTarget, operation) {
              const value = Reflect.get(transactionTarget, operation, transactionTarget) as unknown;
              if (
                (operation === 'insert' || operation === 'update') &&
                typeof value === 'function'
              ) {
                return (table: unknown) => {
                  if (shouldFail(operation, table)) {
                    throw new Error(`Injected ${stage} persistence failure`);
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
          return callback(faultingTransaction);
        });
    },
  });

  return { executor } as ContextServiceShape;
};

const databasePromise = <Value>(
  operation: (database: ContextServiceShape) => PromiseLike<Value>,
): Promise<Value> =>
  Effect.runPromise(withDatabase((database) => Effect.promise(() => operation(database))));

before(async () => {
  await databasePromise(async (database) => {
    await database.executor.insert(tenants).values({
      defaultLocale: 'en',
      name: 'Action Runtime Integration',
      slug: `action-runtime-${tenantId}`,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(legalEntities).values({
      legalEntityId,
      legalName: 'Action Runtime Integration',
      registrationCountry: 'CZ',
      registrationNumber: tenantId,
      status: 'active',
      tenantId,
    });
    await database.executor.insert(principals).values({
      displayName: 'Action Runtime Integration',
      kind: 'human',
      principalId,
      status: 'active',
      tenantId,
    });
  });
});

after(async () => {
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
});

interface RegistrationOptions {
  readonly actionKey: string;
  readonly auditProfile?: 'invalid' | 'standard';
  readonly moduleStateKey: string;
  readonly mode?: 'orphan-outbox' | 'reject' | 'success';
  readonly onExecute?: () => void;
  readonly pause?: boolean;
}

const makeRegistration = ({
  actionKey,
  auditProfile = 'standard',
  moduleStateKey,
  mode = 'success',
  onExecute,
  pause = false,
}: RegistrationOptions) =>
  defineAction(
    {
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: 'action-runtime.integration.v1',
      },
      actionKey,
      auditProfile: auditProfile as 'standard',
      domainErrorSchema: Schema.Union([TestDomainRejected, TestPersistenceError]),
      domainEvents: {
        'test-state.changed': Schema.Struct({ value: Schema.String }),
      },
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ value: Schema.String }),
      resultSchema: Schema.Struct({ stateId: Schema.String, value: Schema.String }),
      schemaVersion: '1',
    },
    (payload, context) =>
      Effect.gen(function* integrationHandler() {
        onExecute?.();
        const inserted = yield* Effect.tryPromise({
          catch: () => new TestPersistenceError({ reason: 'test business write failed' }),
          try: () =>
            context.transaction
              .insert(tenantModuleStates)
              .values({
                moduleKey: moduleStateKey,
                state: 'active',
                tenantId: context.principal.tenantId,
              })
              .returning({
                tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
              }),
        });

        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: `lookup-${moduleStateKey}`,
          resultCount: 0,
          servingModuleKey: 'shell.core',
          targetModuleKey: 'shell.core',
          targetResourceId: moduleStateKey,
          targetResourceType: 'test-state',
        });

        if (mode === 'orphan-outbox') {
          yield* context.addOutboxMessage({} as DomainEventReference, {
            payloadJson: { value: payload.value },
            producerModuleKey: 'shell.core',
            topic: 'test-state.project',
          });
        }

        const domainEvent = yield* context.addDomainEvent({
          eventType: 'test-state.changed',
          payloadJson: { value: payload.value },
          producerModuleKey: 'shell.core',
          subjectModuleKey: 'shell.core',
          subjectResourceId: moduleStateKey,
          subjectResourceType: 'test-state',
        });
        yield* context.addOutboxMessage(domainEvent, {
          payloadJson: { value: payload.value },
          producerModuleKey: 'shell.core',
          topic: 'test-state.project',
        });

        if (pause) {
          yield* Effect.sleep('100 millis');
        }
        if (mode === 'reject') {
          return yield* new TestDomainRejected({ reason: 'test domain rejection' });
        }

        const [row] = inserted;
        if (row === undefined) {
          return yield* new TestPersistenceError({ reason: 'test write returned no row' });
        }
        return {
          stateId: row.tenantModuleStateId,
          value: payload.value,
        };
      }),
  );

const failureTag = <Error>(exit: Exit.Exit<unknown, Error>): string | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  const failure = Cause.findErrorOption(exit.cause);
  return failure._tag === 'Some' &&
    typeof failure.value === 'object' &&
    failure.value !== null &&
    '_tag' in failure.value
    ? String(failure.value._tag)
    : undefined;
};

test('atomically commits business state, all success evidence, and the succeeded marker', async () => {
  const key = 'atomic-success';
  const moduleStateKey = `test.${key}.${tenantId}`;

  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
    const result = await Effect.runPromise(
      runtime.runAction({
        payload: { value: 'committed' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.atomic-success',
          moduleStateKey,
        }),
        transport: transport(key, moduleStateKey),
      }),
    );

    const [states, invocations, audits, accesses, events, messages] = await Promise.all([
      database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey)),
      database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key)),
      database.executor.select().from(auditEvents).where(eq(auditEvents.tenantId, tenantId)),
      database.executor
        .select()
        .from(dataAccessEvents)
        .where(eq(dataAccessEvents.tenantId, tenantId)),
      database.executor
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.subjectResourceId, moduleStateKey)),
      database.executor.select().from(outboxMessages).where(eq(outboxMessages.tenantId, tenantId)),
    ]);

    assert.equal(result.value, 'committed');
    assert.equal(states.length, 1);
    assert.equal(invocations[0]?.status, 'succeeded');
    assert.ok(invocations[0]?.completedAt);
    assert.equal(
      audits.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId).length,
      1,
    );
    assert.equal(
      accesses.filter((row) => row.actionInvocationId === invocations[0]?.actionInvocationId)
        .length,
      1,
    );
    assert.equal(events.length, 1);
    assert.equal(
      messages.filter((row) => row.domainEventId === events[0]?.domainEventId).length,
      1,
    );
    assert.ok(events[0]?.tenantSequenceNo);
  });
});

test('rolls back domain rejection, evidence persistence failure, and orphan outbox attempts', async () => {
  const scenarios = [
    {
      actionKey: 'shell.test.domain-rejection',
      auditProfile: 'standard',
      expectedTag: 'TestDomainRejected',
      key: 'domain-rejection',
      mode: 'reject',
    },
    {
      actionKey: 'shell.test.evidence-failure',
      auditProfile: 'invalid',
      expectedTag: 'ActionTransactionError',
      key: 'evidence-failure',
      mode: 'success',
    },
    {
      actionKey: 'shell.test.orphan-outbox',
      auditProfile: 'standard',
      expectedTag: 'ActionCollectorError',
      key: 'orphan-outbox',
      mode: 'orphan-outbox',
    },
  ] as const;

  await databasePromise(async (database) => {
    const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
    for (const scenario of scenarios) {
      const moduleStateKey = `test.${scenario.key}.${tenantId}`;
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: { value: scenario.key },
            principal,
            registration: makeRegistration({
              actionKey: scenario.actionKey,
              auditProfile: scenario.auditProfile,
              mode: scenario.mode,
              moduleStateKey,
            }),
            transport: transport(scenario.key, moduleStateKey),
          }),
        ),
      );

      const states = await database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
      const invocations = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, scenario.key));
      const invocationId = invocations[0]?.actionInvocationId;
      const committedEvidence =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(auditEvents)
              .where(eq(auditEvents.actionInvocationId, invocationId));
      const committedAccesses =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(dataAccessEvents)
              .where(eq(dataAccessEvents.actionInvocationId, invocationId));
      const committedEvents =
        invocationId === undefined
          ? []
          : await database.executor
              .select()
              .from(domainEvents)
              .where(eq(domainEvents.actionInvocationId, invocationId));

      assert.equal(failureTag(exit), scenario.expectedTag);
      assert.equal(states.length, 0);
      assert.equal(invocations[0]?.status, 'running');
      assert.equal(invocations[0]?.completedAt, null);
      assert.equal(committedEvidence.length, 0);
      assert.equal(committedAccesses.length, 0);
      assert.equal(committedEvents.length, 0);
    }
  });
});

test('rolls back every individual success-evidence persistence failure', async () => {
  const stages: readonly EvidencePersistenceStage[] = [
    'audit',
    'data-access',
    'domain-event',
    'outbox',
    'invocation-success',
  ];

  await databasePromise(async (database) => {
    for (const stage of stages) {
      const key = `evidence-${stage}`;
      const moduleStateKey = `test.${key}.${tenantId}`;
      const beforeOutbox = await database.executor
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.tenantId, tenantId));
      const runtime = makeActionRuntime(
        withEvidencePersistenceFailure(database, stage),
        makeActionRepository(),
        unconfiguredPermission,
      );
      const exit = await Effect.runPromise(
        Effect.exit(
          runtime.runAction({
            payload: { value: stage },
            principal,
            registration: makeRegistration({
              actionKey: `shell.test.${key}`,
              moduleStateKey,
            }),
            transport: transport(key, moduleStateKey),
          }),
        ),
      );

      const states = await database.executor
        .select()
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.moduleKey, moduleStateKey));
      const [invocation] = await database.executor
        .select()
        .from(actionInvocations)
        .where(eq(actionInvocations.idempotencyKey, key));
      assert.notEqual(invocation, undefined);
      const invocationId = invocation?.actionInvocationId ?? '';
      const [audits, accesses, events, afterOutbox] = await Promise.all([
        database.executor
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(dataAccessEvents)
          .where(eq(dataAccessEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(domainEvents)
          .where(eq(domainEvents.actionInvocationId, invocationId)),
        database.executor
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.tenantId, tenantId)),
      ]);

      assert.equal(failureTag(exit), 'ActionTransactionError', stage);
      assert.equal(states.length, 0, stage);
      assert.equal(invocation?.status, 'running', stage);
      assert.equal(invocation?.completedAt, null, stage);
      assert.equal(audits.length, 0, stage);
      assert.equal(accesses.length, 0, stage);
      assert.equal(events.length, 0, stage);
      assert.equal(afterOutbox.length, beforeOutbox.length, stage);
    }
  });
});

test('serializes concurrent requests and enforces committed, open-retry, and hash-conflict behavior', async () => {
  await Effect.runPromise(
    withDatabase((database) => {
      const runtime = makeActionRuntime(database, makeActionRepository(), unconfiguredPermission);
      let executions = 0;
      const concurrentKey = 'concurrent-once';
      const concurrentModule = `test.concurrent.${tenantId}`;
      const concurrentInput = {
        payload: { value: 'same' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.concurrent',
          moduleStateKey: concurrentModule,
          onExecute: () => {
            executions += 1;
          },
          pause: true,
        }),
        transport: transport(concurrentKey, concurrentModule),
      };

      return Effect.gen(function* concurrencyProof() {
        const concurrentResults = yield* Effect.all(
          [
            Effect.exit(runtime.runAction(concurrentInput)),
            Effect.exit(runtime.runAction(concurrentInput)),
          ],
          { concurrency: 'unbounded' },
        );

        assert.equal(executions, 1);
        assert.equal(concurrentResults.filter(Exit.isSuccess).length, 1);
        assert.deepEqual(concurrentResults.filter(Exit.isFailure).map(failureTag), [
          'ActionAlreadyCommitted',
        ]);

        const committedRetry = yield* Effect.exit(
          runtime.runAction({
            ...concurrentInput,
            transport: {
              ...concurrentInput.transport,
              correlationId: 'integration-concurrent-retry',
              traceId: 'retry-trace',
            },
          }),
        );
        assert.equal(failureTag(committedRetry), 'ActionAlreadyCommitted');
        assert.equal(executions, 1);

        const conflict = yield* Effect.exit(
          runtime.runAction({
            ...concurrentInput,
            payload: { value: 'different' },
          }),
        );
        assert.equal(failureTag(conflict), 'ActionRequestHashConflict');

        const openKey = 'open-retry';
        const openModule = `test.open-retry.${tenantId}`;
        const rejected = yield* Effect.exit(
          runtime.runAction({
            payload: { value: 'retryable' },
            principal,
            registration: makeRegistration({
              actionKey: 'shell.test.open-retry',
              mode: 'reject',
              moduleStateKey: openModule,
            }),
            transport: transport(openKey, openModule),
          }),
        );
        assert.equal(failureTag(rejected), 'TestDomainRejected');

        const retried = yield* runtime.runAction({
          payload: { value: 'retryable' },
          principal,
          registration: makeRegistration({
            actionKey: 'shell.test.open-retry',
            moduleStateKey: openModule,
          }),
          transport: transport(openKey, openModule),
        });
        assert.equal(retried.value, 'retryable');
      });
    }),
  );
});

test('serializes Domain Event allocation by tenant commit order', async () => {
  await databasePromise(async (database) => {
    const firstCommitRelease = await Effect.runPromise(Deferred.make<null>());
    const firstFlushed = await Effect.runPromise(Deferred.make<null>());
    const delayedExecutor = new Proxy(database.executor, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (callback: (transaction: unknown) => Promise<unknown>) =>
            target.transaction(async (transaction) => {
              const result = await callback(transaction);
              Effect.runSync(Deferred.succeed(firstFlushed, null));
              await Effect.runPromise(Deferred.await(firstCommitRelease));
              return result;
            });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = makeActionRepository();
    const firstRuntime = makeActionRuntime(
      { executor: delayedExecutor } as ContextServiceShape,
      repository,
      unconfiguredPermission,
    );
    const secondRuntime = makeActionRuntime(database, repository, unconfiguredPermission);
    const firstModule = `test.sequence.first.${tenantId}`;
    const secondModule = `test.sequence.second.${tenantId}`;

    const first = Effect.runPromise(
      firstRuntime.runAction({
        payload: { value: 'first' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.sequence-first',
          moduleStateKey: firstModule,
        }),
        transport: transport('sequence-first', firstModule),
      }),
    );
    await Effect.runPromise(Deferred.await(firstFlushed));

    let secondCompleted = false;
    const second = Effect.runPromise(
      secondRuntime.runAction({
        payload: { value: 'second' },
        principal,
        registration: makeRegistration({
          actionKey: 'shell.test.sequence-second',
          moduleStateKey: secondModule,
        }),
        transport: transport('sequence-second', secondModule),
      }),
    ).finally(() => {
      secondCompleted = true;
    });

    await Effect.runPromise(Effect.sleep('50 millis'));
    assert.equal(secondCompleted, false);

    Effect.runSync(Deferred.succeed(firstCommitRelease, null));
    await Promise.all([first, second]);

    const events = await database.executor
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.tenantId, tenantId));
    const firstEvent = events.find((event) => event.subjectResourceId === firstModule);
    const secondEvent = events.find((event) => event.subjectResourceId === secondModule);

    assert.ok(firstEvent);
    assert.ok(secondEvent);
    assert.ok(firstEvent.tenantSequenceNo < secondEvent.tenantSequenceNo);
  });
});

test('resolves a lost commit acknowledgement from the durable succeeded marker', async () => {
  await databasePromise(async (database) => {
    const repository = makeActionRepository();
    const key = 'lost-acknowledgement';
    const moduleStateKey = `test.lost-ack.${tenantId}`;
    const actionRegistration = makeRegistration({
      actionKey: 'shell.test.lost-ack',
      moduleStateKey,
    });

    const uncertainExecutor = new Proxy(database.executor, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (callback: (transaction: unknown) => Promise<unknown>) => {
            await target.transaction(callback as never);
            throw { commitIndeterminate: true };
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const uncertainRuntime = makeActionRuntime(
      { executor: uncertainExecutor } as ContextServiceShape,
      repository,
      unconfiguredPermission,
    );
    const first = await Effect.runPromise(
      Effect.exit(
        uncertainRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      ),
    );
    assert.equal(failureTag(first), 'ActionCommitIndeterminate');

    const resolvingRuntime = makeActionRuntime(database, repository, unconfiguredPermission);
    const invocations = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, key));
    const invocationId = invocations[0]?.actionInvocationId;
    assert.ok(invocationId);
    const unauthorizedResolution = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal: {
            ...principal,
            principalId: randomUUID(),
          },
        }),
      ),
    );
    const unavailableRuntime = makeActionRuntime(
      database,
      {
        ...repository,
        resolveInvocation: () =>
          Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'test database unavailable',
            }),
          ),
      },
      unconfiguredPermission,
    );
    const unavailableResolution = await Effect.runPromise(
      Effect.exit(
        unavailableRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      ),
    );
    const committedResolution = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.resolveActionCommit({
          invocationId,
          principal,
        }),
      ),
    );
    const resolved = await Effect.runPromise(
      Effect.exit(
        resolvingRuntime.runAction({
          payload: { value: 'committed-with-lost-ack' },
          principal,
          registration: actionRegistration,
          transport: transport(key, moduleStateKey),
        }),
      ),
    );
    const states = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, moduleStateKey));

    assert.equal(failureTag(committedResolution), 'ActionAlreadyCommitted');
    assert.equal(failureTag(unauthorizedResolution), 'ActionInvocationNotFound');
    assert.equal(failureTag(unavailableResolution), 'ActionCommitIndeterminate');
    assert.equal(failureTag(resolved), 'ActionAlreadyCommitted');
    assert.equal(invocations[0]?.status, 'succeeded');
    assert.equal(states.length, 1);

    const openKey = 'lost-acknowledgement-open';
    const openModuleStateKey = `test.lost-ack-open.${tenantId}`;
    const openRegistration = makeRegistration({
      actionKey: 'shell.test.lost-ack-open',
      moduleStateKey: openModuleStateKey,
    });
    const uncertainRollbackExecutor = new Proxy(database.executor, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async (callback: (transaction: unknown) => Promise<unknown>) => {
            try {
              await target.transaction(async (transaction) => {
                await callback(transaction);
                throw new Error('force rollback after the transaction body');
              });
            } catch {
              throw Object.assign(new Error('commit acknowledgement lost'), {
                commitIndeterminate: true,
              });
            }
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const uncertainOpenRuntime = makeActionRuntime(
      { executor: uncertainRollbackExecutor } as ContextServiceShape,
      repository,
      unconfiguredPermission,
    );
    const openFirst = await Effect.runPromise(
      Effect.exit(
        uncertainOpenRuntime.runAction({
          payload: { value: 'rolled-back-with-lost-ack' },
          principal,
          registration: openRegistration,
          transport: transport(openKey, openModuleStateKey),
        }),
      ),
    );
    assert.equal(failureTag(openFirst), 'ActionCommitIndeterminate');

    const openInvocations = await database.executor
      .select()
      .from(actionInvocations)
      .where(eq(actionInvocations.idempotencyKey, openKey));
    const openInvocationId = openInvocations[0]?.actionInvocationId;
    assert.ok(openInvocationId);
    const openResolution = await Effect.runPromise(
      resolvingRuntime.resolveActionCommit({
        invocationId: openInvocationId,
        principal,
      }),
    );
    const openResolved = await Effect.runPromise(
      resolvingRuntime.runAction({
        payload: { value: 'rolled-back-with-lost-ack' },
        principal,
        registration: openRegistration,
        transport: transport(openKey, openModuleStateKey),
      }),
    );
    const openStates = await database.executor
      .select()
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.moduleKey, openModuleStateKey));

    assert.equal(openResolution._tag, 'ActionCommitOpen');
    assert.equal(openResolved.value, 'rolled-back-with-lost-ack');
    assert.equal(openStates.length, 1);
  });
});
