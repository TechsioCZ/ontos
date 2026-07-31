// @effect-diagnostics asyncFunction:off globalDate:off globalDateInEffect:off missingEffectError:off unsafeEffectTypeAssertion:off
/* eslint-disable max-classes-per-file, no-await-in-loop, no-throw-literal, node/callback-return, promise/prefer-await-to-callbacks -- Test-local typed errors, sequential lifecycle assertions, and the controlled Drizzle transaction fake are deliberate. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { CoreDatabase } from '../../src/db/client.ts';
import type {
  ActionInvocationRecord,
  ActionRepositoryService,
  FinalizeActionPolicyDenialInput,
  FlushActionSuccessInput,
} from '../../src/actions/repository.ts';
import { ACTION_RUNTIME_STAGES, makeActionRuntime } from '../../src/actions/runtime.ts';
import type { ActionRuntimeStage } from '../../src/actions/runtime.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { ActionInvocationPersistenceError } from '../../src/actions/errors.ts';
import {
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
} from '../../src/actions/policy.ts';

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
  readonly policyFinalizationFailure?: boolean;
  readonly resolutionUnavailable?: boolean;
  readonly transactionMode?: 'commit-definite' | 'definite-failure' | 'normal' | 'uncertain';
}

const makeHarness = (options: HarnessOptions = {}) => {
  const finalized: FinalizeActionPolicyDenialInput[] = [];
  const flushed: FlushActionSuccessInput[] = [];
  const stages: ActionRuntimeStage[] = [];
  let createCount = 0;
  let lockCount = 0;
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
    finalizePolicyDenial: (_executor, input) => {
      if (options.policyFinalizationFailure === true) {
        return Effect.fail(
          new ActionInvocationPersistenceError({
            code: 'action_invocation_persistence_failed',
            reason: 'test rejection persistence failed',
          }),
        );
      }
      finalized.push(input);
      currentInvocation = {
        ...currentInvocation,
        completedAt: new Date(),
        status: 'rejected',
      };
      return Effect.void;
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

  const runtime = makeActionRuntime(database as never, repository, {
    onStage: (stage) => {
      stages.push(stage);
    },
  });

  return {
    counts: () => ({ createCount, lockCount, transactionCount, transitionCount }),
    finalized,
    flushed,
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
      policies: [],
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
    transactionCount: 1,
    transitionCount: 1,
  });
  assert.equal(harness.flushed.length, 1);
  assert.equal(harness.flushed[0]?.evidence.dataAccessEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.domainEvents.length, 1);
  assert.equal(harness.flushed[0]?.evidence.outboxMessages.length, 1);
  assert.deepEqual(harness.flushed[0]?.allowedPolicies, []);
});

test('evaluates Policies in order before running and hands allowed checkpoints to success', async () => {
  const observed: string[] = [];
  const globalPolicy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => {
      observed.push('global');
      return Effect.void;
    },
    policyKey: 'global.tenant-active.v1',
  });
  const modulePolicy = defineMicroverticalPolicy<{ readonly amount: number }, 'inventory.stock'>({
    evaluate: (input) => {
      observed.push(`module:${input.payload.amount}`);
      assert.equal(input.principal.principalId, principal.principalId);
      assert.equal(input.action.actionKey, 'inventory.stock.policy-allowed');
      assert.equal(input.target.targetResourceId, 'primary');
      assert.equal('idempotencyKey' in input.transport, false);
      return Effect.void;
    },
    owningModuleKey: 'inventory.stock',
    policyKey: 'inventory.stock.allowed.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'inventory.stock.policy-allowed',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'inventory.stock',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [globalPolicy, modulePolicy],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload) => {
      observed.push('handler');
      return Effect.succeed(payload.amount);
    },
  );
  const harness = makeHarness();

  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: action,
      transport: { ...transport(), targetModuleKey: 'inventory.stock' },
    }),
  );

  assert.equal(result, 4);
  assert.deepEqual(observed, ['global', 'module:4', 'handler']);
  assert.deepEqual(harness.flushed[0]?.allowedPolicies, [
    { policyKey: 'global.tenant-active.v1', scope: 'global' },
    {
      owningModuleKey: 'inventory.stock',
      policyKey: 'inventory.stock.allowed.v1',
      scope: 'microvertical',
    },
  ]);
});

test('short-circuits the first Policy denial, finalizes it, and never starts execution', async () => {
  const observed: string[] = [];
  let handlerExecutions = 0;
  const policies = [
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('first');
        return Effect.void;
      },
      policyKey: 'global.first.v1',
    }),
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('denied');
        return Effect.fail(denyPolicy('counter_locked', 'Counter changes are locked — try later'));
      },
      policyKey: 'global.counter-locked.v1',
    }),
    defineGlobalPolicy<{ readonly amount: number }>({
      evaluate: () => {
        observed.push('unreachable');
        return Effect.void;
      },
      policyKey: 'global.unreachable.v1',
    }),
  ] as const;
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.policy-denied',
      auditProfile: 'sensitive',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies,
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerExecutions += 1;
      return Effect.void;
    },
  );
  const harness = makeHarness();

  const denial = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport('policy-denied'),
      }),
    ),
  );

  assert.equal(denial._tag, 'ActionPolicyDenied');
  assert.equal(denial.policyReasonCode, 'counter_locked');
  assert.equal(denial.reason, 'Counter changes are locked — try later');
  assert.deepEqual(observed, ['first', 'denied']);
  assert.equal(handlerExecutions, 0);
  assert.deepEqual(harness.counts(), {
    createCount: 1,
    lockCount: 0,
    transactionCount: 0,
    transitionCount: 0,
  });
  assert.deepEqual(harness.stages, [
    'payload_decoded',
    'trusted_context_validated',
    'invocation_prepared',
    'authentication_boundary',
    'permission_boundary_deferred',
    'policy_boundary',
  ]);
  assert.deepEqual(harness.finalized[0], {
    actionInvocationId: 'invocation-1',
    actionKey: 'shell.counter.policy-denied',
    auditProfile: 'sensitive',
    policy: { policyKey: 'global.counter-locked.v1', scope: 'global' },
    principal,
    reasonCode: 'counter_locked',
    transport: transport('policy-denied'),
  });
  assert.equal(harness.flushed.length, 0);
});

test('sanitizes Policy defects, interrupts, and undeclared failures without finalizing', async () => {
  const evaluators = [
    () => Effect.die('secret evaluator defect'),
    () => Effect.interrupt,
    () => Effect.fail({ _tag: 'UnavailablePolicyCapability', secret: 'database detail' }) as never,
  ] as const;

  for (const [index, evaluate] of evaluators.entries()) {
    let handlerExecutions = 0;
    const policy = defineGlobalPolicy<unknown>({
      evaluate,
      policyKey: `global.failure-${index}.v1`,
    });
    const action = defineAction(
      {
        accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
        actionKey: `shell.counter.policy-failure-${index}`,
        auditProfile: 'standard',
        domainErrorSchema: Schema.Never,
        domainEvents: {},
        idempotency: 'required',
        owningModuleKey: 'shell.core',
        payloadSchema: Schema.Void,
        policies: [policy],
        resultSchema: Schema.Void,
        schemaVersion: '1',
      },
      () => {
        handlerExecutions += 1;
        return Effect.void;
      },
    );
    const harness = makeHarness();
    const error = await Effect.runPromise(
      Effect.flip(
        harness.runtime.runAction({
          payload: undefined,
          principal,
          registration: action,
          transport: transport(`policy-failure-${index}`),
        }),
      ),
    );

    assert.equal(error._tag, 'ActionPolicyEvaluationError');
    assert.equal(error.reason.includes('secret'), false);
    assert.equal(handlerExecutions, 0);
    assert.equal(harness.finalized.length, 0);
    assert.deepEqual(harness.counts(), {
      createCount: 1,
      lockCount: 0,
      transactionCount: 0,
      transitionCount: 0,
    });
  }
});

test('returns persistence failure when denial evidence cannot be finalized', async () => {
  let handlerExecutions = 0;
  const policy = defineGlobalPolicy<unknown>({
    evaluate: () => Effect.fail(denyPolicy('blocked', 'This action is blocked')),
    policyKey: 'global.blocked.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.policy-persistence-failure',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Void,
      policies: [policy],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => {
      handlerExecutions += 1;
      return Effect.void;
    },
  );
  const harness = makeHarness({ policyFinalizationFailure: true });

  const error = await Effect.runPromise(
    Effect.flip(
      harness.runtime.runAction({
        payload: undefined,
        principal,
        registration: action,
        transport: transport('policy-finalization-failure'),
      }),
    ),
  );

  assert.equal(error._tag, 'ActionInvocationPersistenceError');
  assert.equal(handlerExecutions, 0);
  assert.equal(harness.finalized.length, 0);
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

test('evaluates Policies afresh for separate invocations', async () => {
  let evaluations = 0;
  const policy = defineGlobalPolicy<{ readonly amount: number }>({
    evaluate: () => {
      evaluations += 1;
      return Effect.void;
    },
    policyKey: 'global.fresh-evaluation.v1',
  });
  const action = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'counter.read.v1' },
      actionKey: 'shell.counter.fresh-policy',
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      idempotency: 'required',
      owningModuleKey: 'shell.core',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [policy],
      resultSchema: Schema.Void,
      schemaVersion: '1',
    },
    () => Effect.void,
  );
  for (const key of ['fresh-first', 'fresh-second']) {
    const harness = makeHarness({
      createRecord: {
        actionInvocationId: key,
        completedAt: null,
        requestHash: '',
        status: 'received',
      },
    });
    await Effect.runPromise(
      harness.runtime.runAction({
        payload: { amount: 1 },
        principal,
        registration: action,
        transport: transport(key),
      }),
    );
  }

  assert.equal(evaluations, 2);
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
  let policyEvaluations = 0;
  const allowedPolicy = defineGlobalPolicy<unknown>({
    evaluate: () => {
      policyEvaluations += 1;
      return Effect.void;
    },
    policyKey: 'global.domain-rejection-allowed.v1',
  });
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
      policies: [allowedPolicy],
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
  assert.equal(policyEvaluations, 1);
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
      policies: [],
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
      policies: [],
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
      policies: [],
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
  assert.equal(conflictError._tag, 'ActionRequestHashConflict');
  assert.equal(conflict.counts().transactionCount, 0);
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
      policies: [],
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
