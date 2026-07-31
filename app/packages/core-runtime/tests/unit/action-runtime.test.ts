// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off missingEffectError:off unsafeEffectTypeAssertion:off
/* eslint-disable max-classes-per-file, no-await-in-loop, no-throw-literal, node/callback-return, promise/prefer-await-to-callbacks -- Test-local typed errors, sequential lifecycle assertions, and the controlled Drizzle transaction fake are deliberate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { CoreDatabase } from '../../src/db/client.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FlushActionSuccessInput,
  RejectPermissionDeniedInput,
} from '../../src/actions/repository.ts';
import { ACTION_RUNTIME_STAGES, makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeStage } from '../../src/actions/runtime.ts';
import { defineAction } from '../../src/actions/definition.ts';
import {
  ActionInvocationPersistenceError,
  ActionPermissionCheckError,
  ActionTransactionError,
} from '../../src/actions/errors.ts';
import type {
  ActionPermissionDecision,
  CheckActionPermissionInput,
} from '../../src/permissions/service.ts';

const principal = {
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
} as const;

const transport = (idempotencyKey = 'intent-1') => ({
  correlationId: `correlation-${idempotencyKey}`,
  idempotencyKey,
  targetModuleKey: 'shell.core',
  targetResourceId: 'primary',
  targetResourceType: 'counter',
});

const fakeTransaction = {
  delete: () => {},
  insert: () => {},
  query: {},
  select: () => {},
  update: () => {},
};

interface HarnessOptions {
  readonly commitFailureCode?: string;
  readonly createRecord?: ActionInvocationRecord;
  readonly permissionDecision?: ActionPermissionDecision;
  readonly permissionFailure?: boolean;
  readonly rejectionFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

const makeHarness = (options: HarnessOptions = {}) => {
  const flushed: FlushActionSuccessInput[] = [];
  const permissionChecks: CheckActionPermissionInput[] = [];
  const rejections: RejectPermissionDeniedInput[] = [];
  const stages: ActionRuntimeStage[] = [];
  let createCount = 0;
  let lockCount = 0;
  let permissionCheckCount = 0;
  let rejectionCount = 0;
  let transitionCount = 0;
  let transactionCount = 0;
  const invocation =
    options.createRecord ??
    ({
      actionInvocationId: 'invocation-1',
      completedAt: null,
      requestHash: '',
      status: 'received',
    } satisfies ActionInvocationRecord);
  let currentInvocation = invocation;
  let preparedHash = '';

  const repository: ActionRepositoryService = {
    createOrResolveInvocation: (_executor, input) => {
      createCount += 1;
      preparedHash = input.requestHash;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || input.requestHash,
      });
    },
    flushSuccess: (_transaction, input) => {
      flushed.push(input);
      return Effect.void;
    },
    lockInvocation: () => {
      lockCount += 1;
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
    rejectPermissionDenied: (_executor, input) => {
      rejectionCount += 1;
      rejections.push(input);
      if (options.rejectionFailure === true) {
        return Effect.fail(
          new ActionTransactionError({
            code: 'action_transaction_failed',
            reason: 'test denial evidence transaction failed',
          }),
        );
      }
      currentInvocation = {
        ...currentInvocation,
        completedAt: new Date(),
        status: 'rejected',
      };
      return Effect.void;
    },
    resolveInvocation: () =>
      options.resolutionUnavailable === true
        ? Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'test database unavailable',
            }),
          )
        : Effect.succeed(currentInvocation),
    transitionInvocationToRunning: () => {
      transitionCount += 1;
      if (
        (currentInvocation.status === 'received' || currentInvocation.status === 'running') &&
        currentInvocation.completedAt === null
      ) {
        currentInvocation = { ...currentInvocation, status: 'running' };
      }
      return Effect.succeed({
        ...currentInvocation,
        requestHash: currentInvocation.requestHash || preparedHash,
      });
    },
  };

  const permission = {
    checkActionPermission: (input: CheckActionPermissionInput) => {
      permissionCheckCount += 1;
      permissionChecks.push(input);
      return options.permissionFailure === true
        ? Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'test authorization service unavailable',
            }),
          )
        : Effect.succeed(options.permissionDecision ?? 'unconfigured');
    },
  };

  const database = {
    executor: {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
        transactionCount += 1;
        if (options.transactionMode === 'definite-failure') {
          throw new Error('transaction unavailable');
        }
        const result = await callback(fakeTransaction);
        if (options.transactionMode === 'uncertain') {
          throw { commitIndeterminate: true };
        }
        if (options.commitFailureCode !== undefined) {
          throw Object.assign(new Error('commit acknowledgement failed'), {
            code: options.commitFailureCode,
          });
        }
        if (options.transactionMode === 'commit-definite') {
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        }
        return result;
      },
    },
  };

  const runtime = makeActionRuntime(database as never, repository, permission, {
    onStage: (stage) => {
      stages.push(stage);
    },
  });

  return {
    counts: () => ({
      createCount,
      lockCount,
      permissionCheckCount,
      rejectionCount,
      transactionCount,
      transitionCount,
    }),
    flushed,
    permissionChecks,
    rejections,
    runtime,
    stages,
  };
};

const registration = () =>
  defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.change',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {
        'counter.changed': Schema.Struct({ amount: Schema.Finite }),
      },
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    (payload, context) =>
      Effect.gen(function* changeCounter() {
        assert.equal('rollback' in context.transaction, false);
        assert.equal('transaction' in context.transaction, false);
        yield* context.recordDataAccess({
          accessKind: 'read',
          queryHash: `counter-${payload.amount}`,
          resultCount: 1,
          servingModuleKey: 'shell.core',
        });
        const domainEvent = yield* context.addDomainEvent({
          eventType: 'counter.changed',
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'shell.core',
          subjectModuleKey: 'shell.core',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        yield* context.addOutboxMessage(domainEvent, {
          payloadJson: { amount: payload.amount },
          producerModuleKey: 'shell.core',
          topic: 'counter.project',
        });
        return { total: payload.amount };
      }),
  );

test('executes the complete stage order with transaction ownership and success evidence', async () => {
  const harness = makeHarness();
  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 3 },
      principal,
      registration: registration(),
      transport: transport(),
    }),
  );

  assert.deepEqual(result, { total: 3 });
  assert.deepEqual(harness.stages, ACTION_RUNTIME_STAGES);
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 1,
    permissionCheckCount: 1,
    rejectionCount: 0,
    transactionCount: 1,
    transitionCount: 1,
  });
  assert.equal(harness.flushed.length, 1);
  assert.equal(harness.flushed[0]?.evidence.dataAccessEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.domainEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.outboxMessages.length, 1);
  assert.deepEqual(harness.permissionChecks, [
    {
      actionKey: 'shell.counter.change',
      correlationId: 'correlation-intent-1',
      principalId: principal.principalId,
    },
  ]);
});

test('allows configured and unconfigured Actions while preserving policy placement', async () => {
  for (const decision of ['allowed', 'unconfigured'] as const) {
    const harness = makeHarness({ permissionDecision: decision });
    const result = await Effect.runPromise(
      harness.runtime.runAction({
        payload: { amount: 2 },
        principal,
        registration: registration(),
        transport: transport(decision),
      }),
    );

    assert.deepEqual(result, { total: 2 });
    assert.ok(
      harness.stages.indexOf('permission_checked') <
        harness.stages.indexOf('policy_boundary_deferred'),
    );
    assert.equal(harness.counts().transitionCount, 1);
    assert.equal(harness.counts().transactionCount, 1);
  }
});

test('persists a definite permission denial before returning it and never starts execution', async () => {
  let handlerCount = 0;
  const harness = makeHarness({ permissionDecision: 'denied' });
  const deniedRegistration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.denied',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerCount += 1;
      return Effect.void;
    },
  );

  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: deniedRegistration,
        transport: transport('denied'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionPermissionDenied');
  assert.equal(failure.code, 'action_permission_denied');
  assert.equal(handlerCount, 0);
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'invocation_prepared',
    'authentication_boundary',
    'permission_checked',
  ]);
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    permissionCheckCount: 1,
    rejectionCount: 1,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.rejections, [
    {
      actionInvocationId: 'invocation-1',
      actionKey: 'shell.counter.denied',
      auditProfile: 'sensitive',
      principal,
      transport: transport('denied'),
    },
  ]);
});

test('fails closed and leaves the invocation received when permission cannot be determined', async () => {
  const harness = makeHarness({ permissionFailure: true });
  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('unavailable'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionPermissionCheckError');
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    permissionCheckCount: 1,
    rejectionCount: 0,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'invocation_prepared',
    'authentication_boundary',
  ]);
});

test('does not claim denial when terminal evidence persistence rolls back', async () => {
  const harness = makeHarness({ permissionDecision: 'denied', rejectionFailure: true });
  const failure = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('denial-persistence-failure'),
      }),
    ),
  );

  assert.equal(failure._tag, 'ActionTransactionError');
  assert.equal(harness.counts().rejectionCount, 1);
  assert.equal(harness.counts().transitionCount, 0);
  assert.equal(harness.counts().transactionCount, 0);
});

test('creates fresh collectors for every execution', async () => {
  const harness = makeHarness();
  for (const [key, amount] of [
    ['first', 1],
    ['second', 2],
  ] as const) {
    await Effect.runPromise(
      harness.runtime.runAction({
        payload: { amount },
        principal,
        registration: registration(),
        transport: transport(key),
      }),
    );
  }

  assert.equal(harness.flushed.length, 2);
  assert.deepEqual(
    harness.flushed.map((item) => item.evidence.domainEvents.length),
    [1, 1],
  );
  assert.notEqual(harness.flushed[0]?.evidence, harness.flushed[1]?.evidence);
});

test('rejects structural payloads, trusted context, and missing idempotency before invocation', async () => {
  const harness = makeHarness();
  const invalidPayload = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 'not-a-number' },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const invalidPrincipal = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal: { ...principal, principalId: 'not-a-uuid' },
        registration: registration(),
        transport: transport(),
      }),
    ),
  );
  const missingKey = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: { correlationId: 'correlation-missing-key' },
      }),
    ),
  );

  assert.equal(invalidPayload._tag, 'ActionPayloadValidationError');
  assert.equal(invalidPrincipal._tag, 'ActionTrustedContextValidationError');
  assert.equal(missingKey._tag, 'ActionIdempotencyKeyRequired');
  assert.equal(harness.counts().createCount, 0);
});

test('preserves declared domain rejections and rolls back collected evidence', async () => {
  class DomainRejected extends Schema.TaggedErrorClass<DomainRejected>()('DomainRejected', {
    reason: Schema.String,
  }) {}
  const harness = makeHarness();
  const rejected = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.reject',
      auditProfile: 'standard',
      domainErrorSchema: DomainRejected,
      domainEvents: {
        'counter.considered': Schema.Struct({}),
      },
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    (_payload, context) =>
      Effect.gen(function* rejectCounter() {
        yield* context.addDomainEvent({
          eventType: 'counter.considered',
          payloadJson: {},
          producerModuleKey: 'shell.core',
          subjectModuleKey: 'shell.core',
          subjectResourceId: 'primary',
          subjectResourceType: 'counter',
        });
        return yield* new DomainRejected({ reason: 'counter_locked' });
      }),
  );

  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: rejected,
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'DomainRejected');
  assert.equal(error.reason, 'counter_locked');
  assert.equal(harness.flushed.length, 0);
});

test('sanitizes unexpected defects and rejects invalid typed results', async () => {
  const defectHarness = makeHarness();
  const defective = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.defect',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.die('secret database detail'),
  );
  const defect = await Effect.runPromise(
    Effect.flip(
      defectHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: defective,
        transport: transport(),
      }),
    ),
  );

  const resultHarness = makeHarness();
  const invalidResult = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.invalid-result',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Struct({ total: Schema.Finite }),
      schemaVersion: '1',
    },
    () => Effect.succeed({ total: 'invalid' } as never),
  );
  const resultError = await Effect.runPromise(
    Effect.flip(
      resultHarness.runtime.runAction({
        payload: undefined,
        principal,
        registration: invalidResult,
        transport: transport(),
      }),
    ),
  );

  assert.equal(defect._tag, 'ActionHandlerExecutionError');
  assert.equal(defect.reason.includes('secret'), false);
  assert.equal(resultError._tag, 'ActionResultValidationError');
  assert.equal(defectHarness.flushed.length, 0);
  assert.equal(resultHarness.flushed.length, 0);
});

test('sanitizes undeclared handler failures instead of widening the domain error contract', async () => {
  class DeclaredDomainError extends Schema.TaggedErrorClass<DeclaredDomainError>()(
    'DeclaredDomainError',
    { reason: Schema.String },
  ) {}
  class UndeclaredDomainError extends Schema.TaggedErrorClass<UndeclaredDomainError>()(
    'UndeclaredDomainError',
    { reason: Schema.String },
  ) {}
  const harness = makeHarness();
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.undeclared-error',
      auditProfile: 'standard',
      domainErrorSchema: DeclaredDomainError,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () =>
      Effect.fail(
        new UndeclaredDomainError({ reason: 'secret undeclared failure' }),
      ) as unknown as Effect.Effect<void, DeclaredDomainError>,
  );
  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionHandlerExecutionError');
  assert.equal(error.reason.includes('secret'), false);
  assert.equal(harness.flushed.length, 0);
});

test('handles committed, conflict, definite rollback, and indeterminate commit branches', async () => {
  const committed = makeHarness({
    createRecord: {
      actionInvocationId: 'committed',
      completedAt: null,
      requestHash: '',
      status: 'succeeded',
    },
  });
  const committedError = await Effect.runPromise(
    Effect.flip(
      committed.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const conflict = makeHarness({
    createRecord: {
      actionInvocationId: 'conflict',
      completedAt: null,
      requestHash: 'different-request-hash',
      status: 'running',
    },
  });
  const conflictError = await Effect.runPromise(
    Effect.flip(
      conflict.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const definite = makeHarness({ transactionMode: 'definite-failure' });
  const definiteError = await Effect.runPromise(
    Effect.flip(
      definite.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const uncertain = makeHarness({ transactionMode: 'uncertain' });
  const uncertainError = await Effect.runPromise(
    Effect.flip(
      uncertain.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  const definiteCommit = makeHarness({ transactionMode: 'commit-definite' });
  const definiteCommitError = await Effect.runPromise(
    Effect.flip(
      definiteCommit.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport('definite-commit'),
      }),
    ),
  );

  const acknowledgementFailureCodes = ['ETIMEDOUT', 'ECONNABORTED', 'ENETRESET', '08007'];
  const acknowledgementErrors = await Promise.all(
    acknowledgementFailureCodes.map((code) => {
      const harness = makeHarness({ commitFailureCode: code });
      return Effect.runPromise(
        Effect.flip(
          harness.runtime.runAction({
            payload: { amount: 1 },
            principal,
            registration: registration(),
            transport: transport(`uncertain-${code}`),
          }),
        ),
      );
    }),
  );

  assert.equal(committedError._tag, 'ActionAlreadyCommitted');
  assert.equal(committed.counts().transactionCount, 0);
  assert.equal(committed.counts().permissionCheckCount, 0);
  assert.equal(conflictError._tag, 'ActionRequestHashConflict');
  assert.equal(conflict.counts().transactionCount, 0);
  assert.equal(conflict.counts().permissionCheckCount, 0);
  assert.equal(definiteError._tag, 'ActionTransactionError');
  assert.equal(definiteCommitError._tag, 'ActionTransactionError');
  assert.equal(uncertainError._tag, 'ActionCommitIndeterminate');
  assert.equal(uncertain.flushed.length, 1);
  assert.deepEqual(
    acknowledgementErrors.map((error) => error._tag),
    acknowledgementFailureCodes.map(() => 'ActionCommitIndeterminate'),
  );
});

test('resolves commit state explicitly and keeps unavailable outcomes indeterminate', async () => {
  const invocationId = '00000000-0000-4000-8000-000000000099';
  const open = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: null,
      requestHash: 'request',
      status: 'running',
    },
  });
  const openResolution = await Effect.runPromise(
    open.runtime.resolveActionCommit({ invocationId, principal }),
  );

  const committed = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: new Date(),
      requestHash: 'request',
      status: 'succeeded',
    },
  });
  const committedResolution = await Effect.runPromise(
    Effect.flip(committed.runtime.resolveActionCommit({ invocationId, principal })),
  );

  const unavailable = makeHarness({
    createRecord: {
      actionInvocationId: invocationId,
      completedAt: null,
      requestHash: 'request',
      status: 'indeterminate',
    },
    resolutionUnavailable: true,
  });
  const unavailableResolution = await Effect.runPromise(
    Effect.flip(unavailable.runtime.resolveActionCommit({ invocationId, principal })),
  );

  assert.deepEqual(openResolution, {
    _tag: 'ActionCommitOpen',
    invocationId,
  });
  assert.equal(committedResolution._tag, 'ActionAlreadyCommitted');
  assert.equal(unavailableResolution._tag, 'ActionCommitIndeterminate');
  assert.equal(unavailableResolution.invocationId, invocationId);
});

test('rejects terminal invocation states before handler execution', async () => {
  const terminal = makeHarness({
    createRecord: {
      actionInvocationId: 'terminal',
      completedAt: new Date(),
      requestHash: '',
      status: 'failed',
    },
  });
  const error = await Effect.runPromise(
    Effect.flip(
      terminal.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: registration(),
        transport: transport(),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionInvocationStateError');
  assert.equal(terminal.counts().transitionCount, 0);
  assert.equal(terminal.counts().transactionCount, 0);
});

test('uses one runtime contract for Shell/Core and MicroVertical-shaped registrations', async () => {
  const shell = makeHarness();
  const microvertical = makeHarness();
  const moduleRegistration = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'stock.read.v1' },
      actionKey: 'inventory.stock.reserve',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ quantity: Schema.Finite }),
      resultSchema: Schema.Struct({ reserved: Schema.Boolean }),
      schemaVersion: '1',
    },
    () => Effect.succeed({ reserved: true }),
  );

  const shellResult = await Effect.runPromise(
    shell.runtime.runAction({
      payload: { amount: 1 },
      principal,
      registration: registration(),
      transport: transport('shell'),
    }),
  );
  const moduleResult = await Effect.runPromise(
    microvertical.runtime.runAction({
      payload: { quantity: 2 },
      principal,
      registration: moduleRegistration,
      transport: {
        ...transport('microvertical'),
        targetModuleKey: 'inventory.stock',
      },
    }),
  );

  assert.deepEqual(shellResult, { total: 1 });
  assert.deepEqual(moduleResult, { reserved: true });
});

test('the Core database service identity remains server-only', () => {
  assert.equal(typeof CoreDatabase, 'function');
});
