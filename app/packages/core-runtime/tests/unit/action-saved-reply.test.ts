import type { AnyActionRegistration } from '../../src/actions/definition.ts';
import { DateTime, Deferred, Effect, Fiber, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { commitActionThenReject } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:saved-reply-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;
const otherPrincipal = {
  ...principal,
  authBindingId: '10000000-0000-4000-8000-000000000002',
  principalId: '20000000-0000-4000-8000-000000000002',
} as const;
const otherTenantPrincipal = {
  ...principal,
  authBindingId: '10000000-0000-4000-8000-000000000003',
  tenantId: '30000000-0000-4000-8000-000000000002',
} as const;

class CounterRejected extends Schema.TaggedError<CounterRejected>()('CounterRejected', {
  reason: Schema.String,
}) {}

interface CounterProbe {
  handlerRuns: number;
  policyRuns: number;
}

/** A counter whose reply names the handler run that produced it, so a replay is told apart from a re-run. */
const counterAction = (
  probe: CounterProbe,
  options: {
    readonly beforeReply?: (run: number) => Effect.Effect<void>;
    readonly reject?: boolean;
  } = {},
) =>
  defineAction(
    {
      accessDeclaration: fixtureActionAccess('test.saved-reply'),
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.saved-reply.read.v1' },
      actionKey: 'test.saved-reply.increment',
      auditProfile: 'standard',
      domainErrorSchema: CounterRejected,
      domainEvents: { 'test.saved-reply.incremented.v1': Schema.Struct({ amount: Schema.Finite }) },
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: 'test.saved-reply.increment',
        moduleKey: 'test.saved-reply',
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: 'test.saved-reply',
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [
        defineGlobalPolicy({
          evaluate: () =>
            Effect.sync(() => {
              probe.policyRuns += 1;
            }),
          policyKey: 'global.saved-reply-counter.v1',
        }),
      ],
      resultSchema: Schema.Struct({ at: Schema.DateTimeUtcFromString, run: Schema.Finite, total: Schema.Finite }),
      schemaVersion: '1',
    },
    Effect.fn(function* incrementCounter(payload, context) {
      probe.handlerRuns += 1;
      const run = probe.handlerRuns;
      yield* options.beforeReply?.(run) ?? Effect.void;
      const event = yield* context.addDomainEvent({
        eventType: 'test.saved-reply.incremented.v1',
        payloadJson: { amount: payload.amount },
        producerModuleKey: 'test.saved-reply',
        subjectModuleKey: 'test.saved-reply',
        subjectResourceId: 'primary',
        subjectResourceType: 'counter',
      });
      yield* context.addOutboxMessage(event, {
        payloadJson: { amount: payload.amount },
        producerModuleKey: 'test.saved-reply',
        topic: 'test.saved-reply.incremented.v1',
      });
      if (options.reject === true) {
        return commitActionThenReject(new CounterRejected({ reason: `run-${run}` }));
      }
      return { at: DateTime.makeUnsafe(Date.UTC(2026, 10, 18, 12, run)), run, total: payload.amount };
    }),
  );

const fixtureOwner = (action: AnyActionRegistration) => {
  const moduleId = action.descriptor.owningModuleKey;
  const base = makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId }).manifest;
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [action], api: {}, components: {} },
  });
  return defineVerticalRuntimeRegistration({ actions: [action], manifest, outboxWorkers: [] });
};

const harnessFor = (action: AnyActionRegistration) =>
  makeActionTestHarness({ actionPermission: 'allowed', ownerRegistration: fixtureOwner(action) });

const request = <Registration>(
  registration: Registration,
  options: {
    readonly amount?: number;
    readonly idempotencyKey?: string;
    readonly who?: typeof otherPrincipal | typeof otherTenantPrincipal | typeof principal;
  } = {},
) => ({
  payload: { amount: options.amount ?? 2 },
  principal: options.who ?? principal,
  registration,
  transport: { correlationId: 'saved-reply-test', idempotencyKey: options.idempotencyKey ?? 'increment-once' },
});

it.effect('answers a same-key retry with the saved reply and runs nothing again', () =>
  Effect.gen(function* savedReplyReplay() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    const harness = yield* harnessFor(action);

    const original = yield* harness.runtime.runAction(request(action));
    const retry = yield* harness.runtime.runAction(request(action));
    const snapshot = harness.snapshot();

    expect(retry).toEqual(original);
    expect(retry.run).toBe(1);
    expect(retry.at.epochMilliseconds).toBe(original.at.epochMilliseconds);
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 1 });
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.committed[0]?.committedReply).toEqual({
      encoded: { at: '2026-11-18T12:01:00.000Z', run: 1, total: 2 },
      kind: 'result',
    });
    expect(snapshot.committed[0]?.evidence.domainEvents).toHaveLength(1);
    expect(snapshot.committed[0]?.evidence.outboxMessages).toHaveLength(1);
    // The owner transaction, then the retry's scoped read of the saved reply.
    expect(snapshot.transactionCount).toBe(2);
    expect(snapshot.stages.filter((stage) => stage === 'invocation_locked')).toHaveLength(1);
    expect(snapshot.stages.filter((stage) => stage === 'handler_executed')).toHaveLength(1);
  }),
);

it.effect('keeps a same-key retry with a different payload a request-hash conflict', () =>
  Effect.gen(function* savedReplyConflict() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    const harness = yield* harnessFor(action);

    yield* harness.runtime.runAction(request(action));
    const conflict = yield* harness.runtime.runAction(request(action, { amount: 3 })).pipe(Effect.flip);

    expect(Predicate.isTagged(conflict, 'ActionRequestHashConflict')).toBe(true);
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 1 });
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('never answers another principal or tenant with a saved reply of the same key', () =>
  Effect.gen(function* savedReplyBinding() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    const harness = yield* harnessFor(action);

    const original = yield* harness.runtime.runAction(request(action));
    const otherPrincipalReply = yield* harness.runtime.runAction(request(action, { who: otherPrincipal }));
    const otherTenantReply = yield* harness.runtime.runAction(request(action, { who: otherTenantPrincipal }));
    const snapshot = harness.snapshot();

    expect(original.run).toBe(1);
    expect(otherPrincipalReply.run).toBe(2);
    expect(otherTenantReply.run).toBe(3);
    expect(snapshot.invocations).toHaveLength(3);
    expect(new Set(snapshot.invocations.map((invocation) => invocation.actionInvocationId)).size).toBe(3);
    expect(snapshot.committed).toHaveLength(3);
  }),
);

it.effect('replays a committed domain rejection as the same declared failure', () =>
  Effect.gen(function* savedRejectionReplay() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe, { reject: true });
    const harness = yield* harnessFor(action);

    const original = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    const snapshot = harness.snapshot();

    expect(Predicate.isTagged(original, 'CounterRejected')).toBe(true);
    expect(retry).toBeInstanceOf(CounterRejected);
    expect(retry).toEqual(original);
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 1 });
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.committed[0]?.committedReply).toEqual({
      encoded: { _tag: 'CounterRejected', reason: 'run-1' },
      kind: 'rejection',
    });
  }),
);

it.effect('still replays a recorded Policy rejection on a same-key retry', () =>
  Effect.gen(function* recordedRejectionReplay() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const base = counterAction(probe);
    const action = defineAction(
      {
        ...base.descriptor,
        policies: [
          defineGlobalPolicy({
            evaluate: () =>
              Effect.suspend(() => {
                probe.policyRuns += 1;
                return Effect.fail(denyPolicy('counter_locked', 'Counter is locked'));
              }),
            policyKey: 'global.saved-reply-locked.v1',
          }),
        ],
      },
      () => Effect.die('A denied Policy must not execute the handler'),
    );
    const harness = yield* harnessFor(action);

    const original = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);

    expect(Predicate.isTagged(original, 'ActionPolicyDenied')).toBe(true);
    expect(Predicate.isTagged(retry, 'ActionPolicyDenied')).toBe(true);
    expect(probe.policyRuns).toBe(1);
    expect(harness.snapshot().committed).toHaveLength(0);
  }),
);

it.effect('answers the saved reply to a retry that waited while the first attempt committed', () =>
  Effect.gen(function* concurrentSavedReply() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const firstEntered = Deferred.makeUnsafe<null>();
    const releaseFirst = Deferred.makeUnsafe<null>();
    const action = counterAction(probe, {
      beforeReply: (run) =>
        run === 1
          ? Deferred.succeed(firstEntered, null).pipe(Effect.andThen(Deferred.await(releaseFirst)))
          : Effect.void,
    });
    const harness = yield* harnessFor(action);
    const runningStages = () => harness.snapshot().stages.filter((stage) => stage === 'invocation_running').length;

    const first = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
    // The retry passed the first lookup while the invocation was still running and now waits for the
    // owner transaction the first attempt holds.
    for (let turn = 0; turn < 1000 && runningStages() < 2; turn += 1) {
      yield* Effect.yieldNow;
    }
    expect(runningStages()).toBe(2);
    yield* Deferred.succeed(releaseFirst, null);

    const original = yield* Fiber.join(first);
    const replayed = yield* Fiber.join(retry);
    const snapshot = harness.snapshot();

    expect(replayed).toEqual(original);
    expect(probe.handlerRuns).toBe(1);
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.transactionCount).toBe(2);
    expect(snapshot.stages.filter((stage) => stage === 'handler_executed')).toHaveLength(1);
  }),
);
