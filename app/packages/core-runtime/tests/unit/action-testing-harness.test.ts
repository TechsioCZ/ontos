// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { defineAction } from '../../src/actions/definition.ts';
import { ACTION_RUNTIME_STAGES } from '../../src/actions/runtime.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { bindActionTestServices, makeActionTestHarness } from '../../src/testing/actions.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:action-harness-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

const lifecycleAction = defineAction(
  {
    accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.counter.read.v1' },
    actionKey: 'test.counter.increment',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Never,
    domainEvents: { 'test.counter.incremented.v1': Schema.Struct({ amount: Schema.Finite }) },
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      entrypointKey: 'test.counter.increment',
      moduleKey: 'test.counter',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'optional',
    owningModuleKey: 'test.counter',
    payloadSchema: Schema.Struct({ amount: Schema.Finite }),
    policies: [],
    resultSchema: Schema.Struct({ total: Schema.Finite }),
    schemaVersion: '1',
    tenantPermission: () => 'manage_party_identity',
  },
  (payload, context) =>
    Effect.gen(function* lifecycleHandler() {
      const event = yield* context.addDomainEvent({
        eventType: 'test.counter.incremented.v1',
        payloadJson: { amount: payload.amount },
        producerModuleKey: 'test.counter',
        subjectModuleKey: 'test.counter',
        subjectResourceId: 'primary',
        subjectResourceType: 'counter',
      });
      yield* context.addOutboxMessage(event, {
        payloadJson: { amount: payload.amount },
        producerModuleKey: 'test.counter',
        topic: 'test.counter.incremented.v1',
      });
      return { total: payload.amount };
    }),
);

const request = {
  payload: { amount: 2 },
  principal,
  registration: lifecycleAction,
  transport: { correlationId: 'action-harness-test', idempotencyKey: 'increment-once' },
} as const;

test('runs the real Action lifecycle and preserves committed replay semantics', async () => {
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });

  assert.deepEqual(await Effect.runPromise(harness.runtime.runAction(request)), { total: 2 });
  const replay = await Effect.runPromise(harness.runtime.runAction(request).pipe(Effect.flip));
  const snapshot = harness.snapshot();

  assert.equal(replay._tag, 'ActionAlreadyCommitted');
  assert.deepEqual(snapshot.stages.slice(0, ACTION_RUNTIME_STAGES.length), ACTION_RUNTIME_STAGES);
  assert.equal(snapshot.invocations.length, 1);
  assert.equal(snapshot.invocations[0]?.status, 'succeeded');
  assert.equal(snapshot.transactionCount, 1);
  assert.equal(snapshot.committed.length, 1);
  assert.equal(snapshot.committed[0]?.evidence.domainEvents.length, 1);
  assert.equal(snapshot.committed[0]?.evidence.outboxMessages.length, 1);
});

test('defaults authorization closed and never starts a transaction for a denial', async () => {
  const harness = makeActionTestHarness();
  const denied = await Effect.runPromise(harness.runtime.runAction(request).pipe(Effect.flip));
  const snapshot = harness.snapshot();

  assert.equal(denied._tag, 'ActionPermissionDenied');
  assert.equal(snapshot.invocations.length, 1);
  assert.equal(snapshot.invocations[0]?.status, 'rejected');
  assert.equal(snapshot.permissionDenials.length, 1);
  assert.equal(snapshot.transactionCount, 0);
  assert.equal(snapshot.stages.includes('handler_executed'), false);
});

test('substitutes typed owner services without replacing the private handler', async () => {
  interface CounterServices {
    readonly increment: (amount: number) => Effect.Effect<number>;
  }
  const serviceAction = defineAction(
    {
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.service.read.v1' },
      actionKey: 'test.service.increment',
      auditProfile: 'minimal',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        entrypointKey: 'test.service.increment',
        moduleKey: 'test.service',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'test.service',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [],
      resultSchema: Schema.Finite,
      schemaVersion: '1',
    },
    (payload, context) => context.services.increment(payload.amount),
    (): Effect.Effect<CounterServices> =>
      Effect.die('production owner services must not run in this test'),
  );
  let calls = 0;
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    services: [
      bindActionTestServices(serviceAction, {
        increment: (amount) =>
          Effect.sync(() => {
            calls += 1;
            return amount + 1;
          }),
      } satisfies CounterServices),
    ],
  });

  const result = await Effect.runPromise(
    harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: serviceAction,
      transport: { correlationId: 'service-test', idempotencyKey: 'service-once' },
    }),
  );

  assert.equal(result, 5);
  assert.equal(calls, 1);
  assert.equal(harness.snapshot().committed.length, 1);
});

test('rejects missing idempotency before creating an invocation', async () => {
  const harness = makeActionTestHarness({
    actionPermission: 'allowed',
    tenantPermission: 'allowed',
  });
  const failure = await Effect.runPromise(
    harness.runtime
      .runAction({
        payload: { amount: 2 },
        principal,
        registration: lifecycleAction,
        transport: { correlationId: 'missing-idempotency' },
      })
      .pipe(Effect.flip),
  );

  assert.equal(failure._tag, 'ActionIdempotencyKeyRequired');
  assert.equal(harness.snapshot().invocations.length, 0);
});
