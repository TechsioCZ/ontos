import { expect, it } from 'effect-rstest';
import { Effect, Schema, Predicate } from 'effect';
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
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
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
  Effect.fn(function* lifecycleHandler(payload, context) {
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

it.effect(
  'runs the real Action lifecycle and preserves committed replay semantics',
  Effect.fn(function* testProgram1() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
    });

    expect(yield* harness.runtime.runAction(request)).toEqual({ total: 2 });
    const replay = yield* harness.runtime.runAction(request).pipe(Effect.flip);
    const snapshot = harness.snapshot();

    expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);

    expect(snapshot.stages.slice(0, ACTION_RUNTIME_STAGES.length)).toEqual(ACTION_RUNTIME_STAGES);
    expect(snapshot.invocations.length).toBe(1);
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
    expect(snapshot.transactionCount).toBe(1);
    expect(snapshot.committed.length).toBe(1);
    expect(snapshot.committed[0]?.evidence.domainEvents.length).toBe(1);
    expect(snapshot.committed[0]?.evidence.outboxMessages.length).toBe(1);
  }),
);

it.effect(
  'defaults authorization closed and never starts a transaction for a denial',
  Effect.fn(function* testProgram2() {
    const harness = yield* makeActionTestHarness();
    const denied = yield* harness.runtime.runAction(request).pipe(Effect.flip);
    const snapshot = harness.snapshot();

    expect(Predicate.isTagged(denied, 'ActionPermissionDenied')).toBe(true);

    expect(snapshot.invocations.length).toBe(1);
    expect(snapshot.invocations[0]?.status).toBe('rejected');
    expect(snapshot.permissionDenials.length).toBe(1);
    expect(snapshot.transactionCount).toBe(0);
    expect(snapshot.stages.includes('handler_executed')).toBe(false);
  }),
);

it.effect(
  'substitutes typed owner services without replacing the private handler',
  Effect.fn(function* testProgram3() {
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
          authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
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
    const harness = yield* makeActionTestHarness({
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

    const result = yield* harness.runtime.runAction({
      payload: { amount: 4 },
      principal,
      registration: serviceAction,
      transport: { correlationId: 'service-test', idempotencyKey: 'service-once' },
    });

    expect(result).toBe(5);
    expect(calls).toBe(1);
    expect(harness.snapshot().committed.length).toBe(1);
  }),
);

it.effect(
  'rejects missing idempotency before creating an invocation',
  Effect.fn(function* testProgram4() {
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      tenantPermission: 'allowed',
    });
    const failure = yield* harness.runtime
      .runAction({
        payload: { amount: 2 },
        principal,
        registration: lifecycleAction,
        transport: { correlationId: 'missing-idempotency' },
      })
      .pipe(Effect.flip);

    expect(Predicate.isTagged(failure, 'ActionIdempotencyKeyRequired')).toBe(true);

    expect(harness.snapshot().invocations.length).toBe(0);
  }),
);
