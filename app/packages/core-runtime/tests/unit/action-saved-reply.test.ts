import type { AnyActionRegistration } from '../../src/actions/definition.ts';
import type { BoundAccessGate } from '../../src/operations/access-gate.ts';
import { DateTime, Deferred, Effect, Exit, Fiber, Match, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { ActionTransactionError } from '../../src/actions/errors.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { expect, it } from 'effect-rstest';

import { commitActionThenReject } from '../../src/actions/context.ts';
import { defineAction } from '../../src/actions/definition.ts';
import type { PolicyDenied } from '../../src/actions/policy.ts';
import { defineGlobalPolicy, denyPolicy } from '../../src/actions/policy.ts';
import { defineOntosModuleManifest } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { makeScriptedBoundAccessGate } from '../../src/testing/access-gate.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';
import {
  makeApplicationCompositionSnapshotFixture,
  makeModuleContractFixture,
  makeOwnerApplicationCompositionFixture,
} from '../../src/testing/module-contract.ts';
import { fixtureActionAccess } from '../support/access-declaration-fixtures.ts';
import { makeActiveApplicationCompositionService } from '../../src/modules/active-application-composition.ts';

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
    /** The owning module; a composition fixture names its modules `<app>.module`. */
    readonly moduleKey?: string;
    /** What the Policy answers on its nth evaluation; it allows by default. */
    readonly policy?: (run: number) => Effect.Effect<void, PolicyDenied>;
    /** `protected` puts the Action behind the access gate instead of the action-execution permission. */
    readonly protectedAccess?: boolean;
    readonly reject?: boolean;
  } = {},
) => {
  const moduleKey = options.moduleKey ?? 'test.saved-reply';
  return defineAction(
    {
      accessDeclaration: fixtureActionAccess(moduleKey),
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${moduleKey}.read.v1` },
      actionKey: `${moduleKey}.increment`,
      auditProfile: 'standard',
      domainErrorSchema: CounterRejected,
      domainEvents: { 'test.saved-reply.incremented.v1': Schema.Struct({ amount: Schema.Finite }) },
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization:
          options.protectedAccess === true
            ? { kind: 'protected' }
            : { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: `${moduleKey}.increment`,
        moduleKey,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: moduleKey,
      payloadSchema: Schema.Struct({ amount: Schema.Finite }),
      policies: [
        defineGlobalPolicy({
          evaluate: () =>
            Effect.suspend(() => {
              probe.policyRuns += 1;
              return options.policy?.(probe.policyRuns) ?? Effect.void;
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
        producerModuleKey: moduleKey,
        subjectModuleKey: moduleKey,
        subjectResourceId: 'primary',
        subjectResourceType: 'counter',
      });
      yield* context.addOutboxMessage(event, {
        payloadJson: { amount: payload.amount },
        producerModuleKey: moduleKey,
        topic: 'test.saved-reply.incremented.v1',
      });
      if (options.reject === true) {
        return commitActionThenReject(new CounterRejected({ reason: `run-${run}` }));
      }
      return { at: DateTime.makeUnsafe(Date.UTC(2026, 10, 18, 12, run)), run, total: payload.amount };
    }),
  );
};

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
    readonly who?: Omit<typeof principal, 'authBindingId' | 'principalId' | 'tenantId'> & {
      readonly authBindingId: string;
      readonly principalId: string;
      readonly tenantId: string;
    };
  } = {},
) => ({
  payload: { amount: options.amount ?? 2 },
  principal: options.who ?? principal,
  registration,
  // The request a transport sends: its client can lose the reply, so it asks for the saved one.
  savedReply: 'answer' as const,
  transport: { correlationId: 'saved-reply-test', idempotencyKey: options.idempotencyKey ?? 'increment-once' },
});

/** The same request from an in-process caller, which never asks for the saved reply. */
const inProcessRequest = <Registration>(registration: Registration, options: Parameters<typeof request>[1] = {}) => {
  const { savedReply: _transportOnly, ...rest } = request(registration, options);
  return rest;
};

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

it.effect('keeps ActionAlreadyCommitted for an in-process caller that does not ask for the saved reply', () =>
  Effect.gen(function* inProcessStopSignal() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const outcomes: string[] = [];
    const replays: string[] = [];
    const counter = counterAction(probe);
    const action = defineAction(
      counter.descriptor,
      (payload) =>
        Effect.sync(() => {
          probe.handlerRuns += 1;
          return { at: DateTime.makeUnsafe(0), run: probe.handlerRuns, total: payload.amount };
        }),
      () => Effect.succeed({}),
      undefined,
      (context) =>
        Effect.sync(() => {
          outcomes.push(context.outcome._tag);
          return { _tag: 'Settled' as const };
        }),
    );
    const harness = yield* harnessFor(action);

    yield* harness.runtime.runAction(inProcessRequest(action));
    const retry = yield* harness.runtime
      .runAction({
        ...inProcessRequest(action),
        onReplay: (replay) =>
          Effect.sync(() => {
            replays.push(replay.invocationId);
          }),
      })
      .pipe(Effect.flip);
    const snapshot = harness.snapshot();

    expect(Predicate.isTagged(retry, 'ActionAlreadyCommitted')).toBe(true);
    expect(retry).toMatchObject({ invocationId: snapshot.invocations[0]?.actionInvocationId });
    expect(outcomes).toEqual(['Committed', 'AlreadyCommitted']);
    expect(replays).toEqual([]);
    // The reply is still saved with the commit, but the in-process retry reads nothing.
    expect(snapshot.committed[0]?.committedReply).toEqual({
      encoded: { at: '1970-01-01T00:00:00.000Z', run: 1, total: 2 },
      kind: 'result',
    });
    expect(snapshot.transactionCount).toBe(1);
    expect(probe.handlerRuns).toBe(1);
  }),
);

it.effect('answers the saved reply only to a caller the access gate still allows', () =>
  Effect.gen(function* savedReplyNeedsAccess() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe, { protectedAccess: true });
    const allowed = makeScriptedBoundAccessGate('allowed').bound;
    const denied = makeScriptedBoundAccessGate('denied').bound;
    let gate: BoundAccessGate = allowed;
    let decisions = 0;
    const harness = yield* makeActionTestHarness({
      accessDecision: {
        ...allowed,
        decide: (gateInput, transaction) =>
          Effect.suspend(() => {
            decisions += 1;
            return gate.decide(gateInput, transaction);
          }),
      },
      actionPermission: 'allowed',
      ownerRegistration: fixtureOwner(action),
    });

    const original = yield* harness.runtime.runAction(request(action));
    gate = denied;
    const decisionsBeforeRefusedRetry = decisions;
    const refused = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    expect(decisions).toBeGreaterThan(decisionsBeforeRefusedRetry);
    gate = allowed;
    const replayed = yield* harness.runtime.runAction(request(action));
    const snapshot = harness.snapshot();

    expect(Predicate.isTagged(refused, 'ActionAlreadyCommitted')).toBe(true);
    expect(replayed).toEqual(original);
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 1 });
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
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
    // Policies run before the invocation lock, so the request that waited evaluated them too; only the
    // winning transaction wrote anything.
    expect(probe.policyRuns).toBe(2);
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.transactionCount).toBe(2);
    expect(snapshot.stages.filter((stage) => stage === 'handler_executed')).toHaveLength(1);
  }),
);

/** A gate the test switches between allowing and denying, counting every decision it makes. */
const switchableGate = () => {
  const allowed = makeScriptedBoundAccessGate('allowed').bound;
  const denied = makeScriptedBoundAccessGate('denied').bound;
  const state = { allow: true, decisions: 0 };
  const gate: BoundAccessGate = {
    ...allowed,
    decide: (gateInput, transaction) =>
      Effect.suspend(() => {
        state.decisions += 1;
        return (state.allow ? allowed : denied).decide(gateInput, transaction);
      }),
  };
  return { gate, state };
};

it.effect('refuses the saved reply when the grant is withdrawn while the retry waits on the invocation lock', () =>
  Effect.gen(function* withdrawnWhileWaiting() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const firstEntered = Deferred.makeUnsafe<null>();
    const releaseFirst = Deferred.makeUnsafe<null>();
    const action = counterAction(probe, {
      beforeReply: (run) =>
        run === 1
          ? Deferred.succeed(firstEntered, null).pipe(Effect.andThen(Deferred.await(releaseFirst)))
          : Effect.void,
      protectedAccess: true,
    });
    const { gate, state } = switchableGate();
    const harness = yield* makeActionTestHarness({
      accessDecision: gate,
      actionPermission: 'allowed',
      ownerRegistration: fixtureOwner(action),
    });
    const runningStages = () => harness.snapshot().stages.filter((stage) => stage === 'invocation_running').length;

    const first = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
    yield* Deferred.await(firstEntered);
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
    for (let turn = 0; turn < 1000 && runningStages() < 2; turn += 1) {
      yield* Effect.yieldNow;
    }
    // The retry was allowed before it waited; the grant goes away while it waits on the lock.
    expect(runningStages()).toBe(2);
    state.allow = false;
    yield* Deferred.succeed(releaseFirst, null);

    const original = yield* Fiber.join(first);
    const refused = yield* Fiber.join(retry).pipe(Effect.flip);

    expect(original.run).toBe(1);
    expect(Predicate.isTagged(refused, 'ActionAlreadyCommitted')).toBe(true);
    expect(refused).toMatchObject({ invocationId: harness.snapshot().invocations[0]?.actionInvocationId });
    expect(probe.handlerRuns).toBe(1);
    expect(harness.snapshot().committed).toHaveLength(1);

    // With the grant back, the same retry answers the saved reply.
    state.allow = true;
    expect(yield* harness.runtime.runAction(request(action))).toEqual(original);
  }),
);

it.effect('refuses the saved reply to a request admitted under a stale composition revision', () =>
  Effect.gen(function* staleCompositionReplay() {
    const appId = 'test-replay';
    const buildMarker = 'test-replay-build';
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe, { moduleKey: 'test.replay.module' });
    const snapshot = yield* makeApplicationCompositionSnapshotFixture([appId], buildMarker);
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
      expectedDeployment: { appId, buildMarker },
      ownerRegistration: fixtureOwner(action),
    });

    const original = yield* harness.runtime.runAction(request(action));
    const stale = yield* harness.runtime
      .runAction(request(action, { who: trustVerifiedGatewayPrincipalContext({ ...principal }, 'b'.repeat(64)) }))
      .pipe(Effect.flip);
    const current = yield* harness.runtime.runAction(
      request(action, { who: trustVerifiedGatewayPrincipalContext({ ...principal }, snapshot.composition.revision) }),
    );

    // The stale request gets what a first attempt under that revision gets; the current one the reply.
    expect(Schema.is(ActionTransactionError)(stale)).toBe(true);
    expect(current).toEqual(original);
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 1 });
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

it.effect('keeps a refused replay refused whatever the post-attempt hook answers', () =>
  Effect.gen(function* refusedReplayIsTerminal() {
    for (const recovery of ['recovered', 'hook-fails'] as const) {
      const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
      const outcomes: string[] = [];
      // What the owner hook answers when it sees the replay: a recovered value, or a failure.
      const onReplay =
        recovery === 'recovered'
          ? Effect.succeed({ _tag: 'Recovered' as const, result: { at: DateTime.makeUnsafe(0), run: 99, total: 99 } })
          : Effect.fail(new CounterRejected({ reason: 'hook' }));
      const action = defineAction(
        counterAction(probe, { protectedAccess: true }).descriptor,
        (payload) =>
          Effect.sync(() => {
            probe.handlerRuns += 1;
            return { at: DateTime.makeUnsafe(0), run: probe.handlerRuns, total: payload.amount };
          }),
        () => Effect.succeed({}),
        undefined,
        (context) => {
          outcomes.push(context.outcome._tag);
          return Match.value(context.outcome).pipe(
            Match.tag('AlreadyCommitted', () => onReplay),
            Match.orElse(() => Effect.succeed({ _tag: 'Settled' as const })),
          );
        },
      );
      const { gate, state } = switchableGate();
      const harness = yield* makeActionTestHarness({
        accessDecision: gate,
        actionPermission: 'allowed',
        ownerRegistration: fixtureOwner(action),
      });

      const original = yield* harness.runtime.runAction(request(action));
      state.allow = false;
      const refused = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
      state.allow = true;
      const replayed = yield* harness.runtime.runAction(request(action)).pipe(Effect.exit);

      expect(Predicate.isTagged(refused, 'ActionAlreadyCommitted')).toBe(true);
      expect(outcomes).toEqual(['Committed', 'AlreadyCommitted', 'AlreadyCommitted']);
      // An allowed replay answers the saved reply after a recovering hook; a failing hook still fails it.
      if (recovery === 'recovered') {
        expect(replayed).toEqual(Exit.succeed(original));
      } else {
        expect(Exit.isFailure(replayed)).toBe(true);
      }
      expect(probe.handlerRuns).toBe(1);
    }
  }),
);

it.effect('answers a saved reply inside the recovery window and withholds it after', () =>
  Effect.gen(function* recoveryWindow() {
    const day = 24 * 60 * 60 * 1000;
    const committedAt = Date.UTC(2026, 10, 1, 12, 0);
    yield* TestClock.setTime(committedAt);
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    const ownerRegistration = fixtureOwner(action);
    // The harness's own composition observation is valid for an hour; this proof moves the clock a week, so the
    // composition is observed again at every load, as the live source does.
    const observeComposition = makeOwnerApplicationCompositionFixture({ ownerRegistration });
    const { expectedDeployment } = yield* observeComposition;
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      applicationComposition: makeActiveApplicationCompositionService(
        observeComposition.pipe(
          Effect.map(({ snapshot }) => snapshot),
          Effect.orDie,
        ),
      ),
      expectedDeployment,
      ownerRegistration,
    });

    const inside = yield* harness.runtime.runAction(request(action, { idempotencyKey: 'inside-window' }));
    const outside = yield* harness.runtime.runAction(request(action, { idempotencyKey: 'outside-window' }));
    yield* TestClock.setTime(committedAt + 7 * day - 60_000);
    const insideRetry = yield* harness.runtime.runAction(request(action, { idempotencyKey: 'inside-window' }));
    yield* TestClock.setTime(committedAt + 7 * day + 60_000);
    const outsideRetry = yield* harness.runtime
      .runAction(request(action, { idempotencyKey: 'outside-window' }))
      .pipe(Effect.flip);

    expect(insideRetry).toEqual(inside);
    expect(outside.run).toBe(2);
    expect(Predicate.isTagged(outsideRetry, 'ActionAlreadyCommitted')).toBe(true);
    expect(probe.handlerRuns).toBe(2);
    expect(harness.snapshot().committed).toHaveLength(2);
  }),
);

it.effect('measures the recovery window with the clock that stamped the commit, whatever PostgreSQL time says', () =>
  Effect.gen(function* windowUsesCommitClock() {
    const day = 24 * 60 * 60 * 1000;
    const committedAt = Date.UTC(2026, 8, 25, 10, 12);
    yield* TestClock.setTime(committedAt);
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    // PostgreSQL's transaction time runs weeks ahead of the Effect clock that stamps `completedAt`.
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      ownerRegistration: fixtureOwner(action),
      transactionTime: () => DateTime.toDateUtc(DateTime.makeUnsafe(committedAt + 54 * day)),
    });

    const original = yield* harness.runtime.runAction(request(action, { idempotencyKey: 'pinned-clock' }));
    const retry = yield* harness.runtime.runAction(request(action, { idempotencyKey: 'pinned-clock' }));

    expect(retry).toEqual(original);
    expect(probe.handlerRuns).toBe(1);
  }),
);

it.effect('saves no reply for an invocation without an idempotency key', () =>
  Effect.gen(function* keylessInvocation() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = defineAction({ ...counterAction(probe).descriptor, idempotency: 'optional' }, (payload) =>
      Effect.sync(() => {
        probe.handlerRuns += 1;
        return { at: DateTime.makeUnsafe(0), run: probe.handlerRuns, total: payload.amount };
      }),
    );
    const harness = yield* harnessFor(action);

    const result = yield* harness.runtime.runAction({
      payload: { amount: 2 },
      principal,
      registration: action,
      transport: { correlationId: 'saved-reply-keyless' },
    });
    const snapshot = harness.snapshot();

    expect(result.run).toBe(1);
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.committed[0]?.committedReply).toBeNull();
    expect(snapshot.invocations[0]?.idempotencyKey).toBeUndefined();
  }),
);

it.effect('saves no reply that PostgreSQL jsonb cannot hold and commits the Action as before', () =>
  Effect.gen(function* unstorableReply() {
    // jsonb refuses NUL in a string value or an object key, and a lone UTF-16 surrogate.
    for (const labels of [{ note: 'before\u0000after' }, { 'key\u0000': 'value' }, { note: 'lone \uD800' }]) {
      let handlerRuns = 0;
      const action = defineAction(
        {
          ...counterAction({ handlerRuns: 0, policyRuns: 0 }).descriptor,
          resultSchema: Schema.Struct({ labels: Schema.Record(Schema.String, Schema.String) }),
        },
        () =>
          Effect.sync(() => {
            handlerRuns += 1;
            return { labels };
          }),
      );
      const harness = yield* harnessFor(action);

      const original = yield* harness.runtime.runAction(request(action));
      const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
      const snapshot = harness.snapshot();

      expect(original).toEqual({ labels });
      expect(snapshot.committed).toHaveLength(1);
      expect(snapshot.committed[0]?.committedReply).toBeNull();
      expect(snapshot.invocations[0]?.status).toBe('succeeded');
      expect(Predicate.isTagged(retry, 'ActionAlreadyCommitted')).toBe(true);
      expect(handlerRuns).toBe(1);
    }
  }),
);

/** A Date declared without a JSON codec: the result hashes, but a reply holding it has no JSON form. */
const DateWithoutJsonForm = Schema.declare(Predicate.isDate);
const epoch = DateTime.toDateUtc(DateTime.makeUnsafe(0));

it.effect('saves no reply that has no JSON form and commits the Action as before', () =>
  Effect.gen(function* replyWithoutJsonForm() {
    let handlerRuns = 0;
    const at = epoch;
    const action = defineAction(
      {
        ...counterAction({ handlerRuns: 0, policyRuns: 0 }).descriptor,
        resultSchema: Schema.Struct({ at: DateWithoutJsonForm }),
      },
      () =>
        Effect.sync(() => {
          handlerRuns += 1;
          return { at };
        }),
    );
    const harness = yield* harnessFor(action);

    const original = yield* harness.runtime.runAction(request(action));
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    const snapshot = harness.snapshot();

    expect(original.at).toBe(at);
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.committed[0]?.committedReply).toBeNull();
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
    expect(Predicate.isTagged(retry, 'ActionAlreadyCommitted')).toBe(true);
    expect(handlerRuns).toBe(1);
  }),
);

it.effect('replays a retry whose Policy denies only after the concurrent first attempt committed', () =>
  Effect.gen(function* policyRaceReplay() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const firstEntered = Deferred.makeUnsafe<null>();
    const releaseFirst = Deferred.makeUnsafe<null>();
    const firstCommitted = Deferred.makeUnsafe<null>();
    // The Policy allows the first attempt. The retry evaluates it while the first attempt holds the
    // invocation lock; it lets that attempt commit, and the committed state makes it deny.
    const action = counterAction(probe, {
      beforeReply: (run) =>
        run === 1
          ? Deferred.succeed(firstEntered, null).pipe(Effect.andThen(Deferred.await(releaseFirst)))
          : Effect.void,
      policy: (run) =>
        run === 1
          ? Effect.void
          : Deferred.succeed(releaseFirst, null).pipe(
              Effect.andThen(Deferred.await(firstCommitted)),
              Effect.andThen(Effect.fail(denyPolicy('counter_already_used', 'The counter was already used'))),
            ),
    });
    const harness = yield* harnessFor(action);

    const first = yield* harness.runtime.runAction(request(action)).pipe(
      Effect.tap(() => Deferred.succeed(firstCommitted, null)),
      Effect.forkChild,
    );
    yield* Deferred.await(firstEntered);
    // The retry reads the invocation still open and evaluates its Policy before the invocation lock.
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.exit);
    const original = yield* Fiber.join(first);
    const snapshot = harness.snapshot();

    expect(retry).toEqual(Exit.succeed(original));
    expect(probe).toEqual({ handlerRuns: 1, policyRuns: 2 });
    // The denial was not recorded on the committed invocation.
    expect(snapshot.policyDenials).toEqual([]);
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
    expect(snapshot.committed).toHaveLength(1);
  }),
);

it.effect('answers ActionAlreadyCommitted to a Policy-race retry whose commit saved no reply', () =>
  Effect.gen(function* policyRaceWithoutReply() {
    let policyRuns = 0;
    let handlerRuns = 0;
    const firstEntered = Deferred.makeUnsafe<null>();
    const releaseFirst = Deferred.makeUnsafe<null>();
    const firstCommitted = Deferred.makeUnsafe<null>();
    const action = defineAction(
      {
        ...counterAction({ handlerRuns: 0, policyRuns: 0 }).descriptor,
        policies: [
          defineGlobalPolicy({
            evaluate: () =>
              Effect.suspend(() => {
                policyRuns += 1;
                return policyRuns === 1
                  ? Effect.void
                  : Deferred.succeed(releaseFirst, null).pipe(
                      Effect.andThen(Deferred.await(firstCommitted)),
                      Effect.andThen(Effect.fail(denyPolicy('counter_already_used', 'The counter was already used'))),
                    );
              }),
            policyKey: 'global.saved-reply-once.v1',
          }),
        ],
        resultSchema: Schema.Struct({ note: Schema.String }),
      },
      () =>
        Effect.gen(function* unstorableResult() {
          handlerRuns += 1;
          yield* Deferred.succeed(firstEntered, null);
          yield* Deferred.await(releaseFirst);
          // A reply jsonb cannot hold is not saved.
          return { note: 'nul\u0000' };
        }),
    );
    const harness = yield* harnessFor(action);

    const first = yield* harness.runtime.runAction(request(action)).pipe(
      Effect.tap(() => Deferred.succeed(firstCommitted, null)),
      Effect.forkChild,
    );
    yield* Deferred.await(firstEntered);
    const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.flip);
    yield* Fiber.join(first);

    expect(Predicate.isTagged(retry, 'ActionAlreadyCommitted')).toBe(true);
    expect({ handlerRuns, policyRuns }).toEqual({ handlerRuns: 1, policyRuns: 2 });
    expect(harness.snapshot().policyDenials).toEqual([]);
    expect(harness.snapshot().committed).toHaveLength(1);
  }),
);

/** A request whose `onReplay` records every saved reply the runtime reports for it. */
const reportingRequest = <Registration>(
  registration: Registration,
  replays: string[],
  options: Parameters<typeof request>[1] = {},
) => ({
  ...request(registration, options),
  onReplay: (replay: { readonly invocationId: string }) =>
    Effect.sync(() => {
      replays.push(replay.invocationId);
    }),
});

it.effect('tells the caller, and only the caller, that its answer is the saved reply', () =>
  Effect.gen(function* replayIsReported() {
    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe);
    const harness = yield* harnessFor(action);
    const replays: string[] = [];

    const original = yield* harness.runtime.runAction(reportingRequest(action, replays));
    expect(replays).toEqual([]);
    const retry = yield* harness.runtime.runAction(reportingRequest(action, replays));
    const fresh = yield* harness.runtime.runAction(reportingRequest(action, replays, { idempotencyKey: 'another' }));

    // The committing request and a request of another key commit; only the same-key retry replays.
    const [committed] = harness.snapshot().invocations;
    expect(retry).toEqual(original);
    expect(fresh.run).toBe(2);
    expect(replays).toEqual([committed?.actionInvocationId]);
  }),
);

it.effect('reports a replayed committed rejection and never a refused replay', () =>
  Effect.gen(function* rejectionAndRefusalReports() {
    const rejectedProbe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const rejecting = counterAction(rejectedProbe, { reject: true });
    const rejectingHarness = yield* harnessFor(rejecting);
    const rejectionReplays: string[] = [];
    yield* rejectingHarness.runtime.runAction(reportingRequest(rejecting, rejectionReplays)).pipe(Effect.flip);
    const replayedRejection = yield* rejectingHarness.runtime
      .runAction(reportingRequest(rejecting, rejectionReplays))
      .pipe(Effect.flip);
    expect(replayedRejection).toBeInstanceOf(CounterRejected);
    expect(rejectionReplays).toEqual([rejectingHarness.snapshot().invocations[0]?.actionInvocationId]);

    const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
    const action = counterAction(probe, { protectedAccess: true });
    const { gate, state } = switchableGate();
    const harness = yield* makeActionTestHarness({
      accessDecision: gate,
      actionPermission: 'allowed',
      ownerRegistration: fixtureOwner(action),
    });
    const replays: string[] = [];
    yield* harness.runtime.runAction(reportingRequest(action, replays));
    state.allow = false;
    const refused = yield* harness.runtime.runAction(reportingRequest(action, replays)).pipe(Effect.flip);
    expect(Predicate.isTagged(refused, 'ActionAlreadyCommitted')).toBe(true);
    expect(replays).toEqual([]);
  }),
);

it.effect('reports a replay through the post-attempt hook only when the saved reply is the answer', () =>
  Effect.gen(function* hookReplayReports() {
    for (const hookAnswer of ['settled', 'hook-fails'] as const) {
      const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
      const action = defineAction(
        counterAction(probe).descriptor,
        (payload) =>
          Effect.sync(() => {
            probe.handlerRuns += 1;
            return { at: DateTime.makeUnsafe(0), run: probe.handlerRuns, total: payload.amount };
          }),
        () => Effect.succeed({}),
        undefined,
        (context) =>
          Match.value(context.outcome).pipe(
            Match.tag('AlreadyCommitted', () =>
              hookAnswer === 'hook-fails'
                ? Effect.fail(new CounterRejected({ reason: 'hook' }))
                : Effect.succeed({ _tag: 'Settled' as const }),
            ),
            Match.orElse(() => Effect.succeed({ _tag: 'Settled' as const })),
          ),
      );
      const harness = yield* harnessFor(action);
      const replays: string[] = [];

      const original = yield* harness.runtime.runAction(reportingRequest(action, replays));
      const retry = yield* harness.runtime.runAction(reportingRequest(action, replays)).pipe(Effect.exit);

      if (hookAnswer === 'settled') {
        expect(retry).toEqual(Exit.succeed(original));
        expect(replays).toEqual([harness.snapshot().invocations[0]?.actionInvocationId]);
      } else {
        // The hook's failure is the answer, so the request did not answer the saved reply.
        expect(Exit.isFailure(retry)).toBe(true);
        expect(replays).toEqual([]);
      }
    }
  }),
);

/**
 * A first attempt held at its handler, so a same-key retry passes the first lookup and waits on the
 * invocation lock; `release` lets the first attempt commit.
 */
const heldFirstAttempt = () => {
  const firstEntered = Deferred.makeUnsafe<null>();
  const releaseFirst = Deferred.makeUnsafe<null>();
  return {
    beforeReply: (run: number) =>
      run === 1 ? Deferred.succeed(firstEntered, null).pipe(Effect.andThen(Deferred.await(releaseFirst))) : Effect.void,
    entered: Deferred.await(firstEntered),
    release: Deferred.succeed(releaseFirst, null),
  };
};

it.effect('refuses the saved reply when the module state denies the Action while the retry waits', () =>
  Effect.gen(function* moduleStateDeniedWhileWaiting() {
    for (const changed of ['suspended', 'unavailable'] as const) {
      const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
      const held = heldFirstAttempt();
      const action = counterAction(probe, { beforeReply: held.beforeReply });
      let moduleState: 'active' | typeof changed = 'active';
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        moduleState: () => moduleState,
        ownerRegistration: fixtureOwner(action),
      });
      const runningStages = () => harness.snapshot().stages.filter((stage) => stage === 'invocation_running').length;

      const first = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
      yield* held.entered;
      const retry = yield* harness.runtime.runAction(request(action)).pipe(Effect.forkChild);
      for (let turn = 0; turn < 1000 && runningStages() < 2; turn += 1) {
        yield* Effect.yieldNow;
      }
      expect(runningStages()).toBe(2);
      moduleState = changed;
      yield* held.release;

      const original = yield* Fiber.join(first);
      const failure = yield* Fiber.join(retry).pipe(Effect.flip);

      expect(original.run).toBe(1);
      if (changed === 'suspended') {
        // A definite denial refuses the replay: the bodyless ActionAlreadyCommitted, never the module error.
        expect(Predicate.isTagged(failure, 'ActionAlreadyCommitted')).toBe(true);
        expect(failure).toMatchObject({ invocationId: harness.snapshot().invocations[0]?.actionInvocationId });
      } else {
        // An unreadable module state stays the retryable failure a first attempt would get.
        expect(Predicate.isTagged(failure, 'ModuleStateCheckUnavailableError')).toBe(true);
      }
      expect(probe.handlerRuns).toBe(1);
      expect(harness.snapshot().committed).toHaveLength(1);

      // With the module active again, the same retry answers the saved reply.
      moduleState = 'active';
      expect(yield* harness.runtime.runAction(request(action))).toEqual(original);
    }
  }),
);

it.effect('decides a permission denial that loses to a concurrent commit as a replay', () =>
  Effect.gen(function* permissionDenialMeetsCommit() {
    for (const asks of [true, false]) {
      const probe: CounterProbe = { handlerRuns: 0, policyRuns: 0 };
      const held = heldFirstAttempt();
      const firstCommitted = Deferred.makeUnsafe<null>();
      const outcomes: string[] = [];
      const counter = counterAction(probe, { protectedAccess: true });
      const action = defineAction(
        counter.descriptor,
        (payload) =>
          Effect.gen(function* heldHandler() {
            probe.handlerRuns += 1;
            const run = probe.handlerRuns;
            yield* held.beforeReply(run);
            return { at: DateTime.makeUnsafe(0), run, total: payload.amount };
          }),
        () => Effect.succeed({}),
        undefined,
        (context) =>
          Effect.sync(() => {
            outcomes.push(context.outcome._tag);
            return { _tag: 'Settled' as const };
          }),
      );
      // The retry's access decision is denied against the state before the first attempt commits: it
      // lets that attempt commit before it answers. Every other decision allows.
      const allowedGate = makeScriptedBoundAccessGate('allowed').bound;
      const deniedGate = makeScriptedBoundAccessGate('denied').bound;
      let firstHeld = false;
      let raced = false;
      const gate: BoundAccessGate = {
        ...allowedGate,
        decide: (gateInput, transaction) =>
          Effect.suspend(() => {
            if (!firstHeld || raced) {
              return allowedGate.decide(gateInput, transaction);
            }
            raced = true;
            return held.release.pipe(
              Effect.andThen(Deferred.await(firstCommitted)),
              Effect.andThen(deniedGate.decide(gateInput, transaction)),
            );
          }),
      };
      const harness = yield* makeActionTestHarness({
        accessDecision: gate,
        actionPermission: 'allowed',
        ownerRegistration: fixtureOwner(action),
      });

      const first = yield* harness.runtime.runAction(request(action)).pipe(
        Effect.tap(() => Deferred.succeed(firstCommitted, null)),
        Effect.forkChild,
      );
      yield* held.entered;
      firstHeld = true;
      const retry = yield* harness.runtime
        .runAction(asks ? request(action) : inProcessRequest(action))
        .pipe(Effect.exit);
      const original = yield* Fiber.join(first);
      const snapshot = harness.snapshot();

      expect(raced).toBe(true);
      if (asks) {
        expect(retry).toEqual(Exit.succeed(original));
      } else {
        const failure = yield* Effect.flip(retry);
        expect(Predicate.isTagged(failure, 'ActionAlreadyCommitted')).toBe(true);
      }
      // The hook sees the commit, never an uncommitted attempt, and the denial is not recorded.
      expect(outcomes).toEqual(['Committed', 'AlreadyCommitted']);
      expect(snapshot.permissionDenials).toEqual([]);
      expect(snapshot.invocations[0]?.status).toBe('succeeded');
      expect(snapshot.committed).toHaveLength(1);
      expect(probe.handlerRuns).toBe(1);
    }
  }),
);
