import { OutboxWorkerTenantScope } from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerTenantScopeView } from '@app/core-runtime/outbox/worker';
import { NodeCrypto } from '@effect/platform-node';
import type { OutboxWorkerHandlerContext, ScopedRoutineInvoker } from '@app/core-runtime';
import { trustResolvedSystemPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Effect, Layer, Option, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { SymmyJobNotification, SymmyJobNotificationError } from '../../src/services/symmy-job-notification.service.ts';
import { SymmyJobNotificationStore } from '../../src/services/symmy-job-notification-store.ts';
import { describe, expect, it } from 'effect-rstest';

import { SymmyExecutionEffectStateSchema, SymmyExecutionJobSchema } from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyEffectClaim,
  SymmyExecutionOutcome,
  SymmyPinnedEffect,
  SymmyExecutionJob,
  SymmyOwnerReceipt,
} from '../../shared/domain/symmy-job-execution.ts';
import type { symmyJobExecutionStore } from '../../src/persistence/symmy-job-execution-store.ts';
import {
  makeSymmyJobWorker,
  SymmyJobWorkerError,
  SymmyEffectAdapters,
  SymmyWorkerIdentity,
  SymmyJobExecutionPersistence,
} from '../../src/services/symmy-job-worker.service.ts';
import type { SymmyEffectAdapter, SymmyOriginalEffectRecovery } from '../../src/services/symmy-job-worker.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const principalId = '10000000-0000-4000-8000-000000000002';
const systemId = '10000000-0000-4000-8000-000000000003';
const jobId = '10000000-0000-4000-8000-000000000004';
const routeId = '10000000-0000-4000-8000-000000000005';
const itemId = '10000000-0000-4000-8000-000000000006';
const effectId = '10000000-0000-4000-8000-000000000007';
const siblingId = '10000000-0000-4000-8000-000000000008';
const operation = {
  entrypointKey: 'integration.symmy.fixture-effect',
  moduleId: 'integration.symmy',
  schemaVersion: '1',
};
const pinned = (id: string, effectKey: string) => ({
  effectKey,
  itemId,
  ref: {
    effectId: id,
    mappingVersion: 'mapping-1',
    occurrence: {
      occurrenceId: 'fixture-occurrence',
      record: {
        entityKind: 'fixture',
        issuerId: 'internal',
        route: { integrationRouteId: routeId, tenantId },
        sourceNamespace: 'internal',
        sourceRecordId: 'fixture-record',
      },
    },
    operation,
    originalTarget: {
      moduleId: 'integration.symmy',
      resourceId: 'original-resource',
      resourceType: 'integration.symmy.fixture',
      tenantId,
    },
    routeRevision: 'route-1',
  },
});
const parseJob = Schema.decodeUnknownSync(SymmyExecutionJobSchema, { onExcessProperty: 'error' });
const initialJob = parseJob({
  effects: [
    {
      effect: pinned(siblingId, 'sibling'),
      outcome: { effectId: siblingId, owner: 'integration.symmy', status: 'accepted_change' },
      state: 'settled',
      version: 2,
    },
    { effect: pinned(effectId, 'effect'), outcome: null, state: 'planned', version: 0 },
  ],
  jobId,
  legalEntityId: null,
  mappingVersion: 'mapping-1',
  originalPrincipalId: principalId,
  plan: { items: [{ effects: [pinned(siblingId, 'sibling'), pinned(effectId, 'effect')], itemId, itemKey: 'item' }] },
  routeId,
  routeRevision: 'route-1',
});
const rawContext: OutboxWorkerHandlerContext = {
  actorPrincipalId: principalId,
  attemptNumber: 1,
  claimId: 'owner:claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'integration.symmy',
  deliveryId: '10000000-0000-4000-8000-000000000010',
  domainEventId: '10000000-0000-4000-8000-000000000011',
  legalEntityScope: 'forbidden',
  messageId: '10000000-0000-4000-8000-000000000012',
  originatorInvocationId: '10000000-0000-4000-8000-000000000013',
  producerModuleKey: 'integration.symmy',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'integration.symmy.job-admitted.v1',
  workerKey: 'integration.symmy.execute-symmy-job',
};
const context = attestOutboxWorkerHandlerContext(rawContext);
const unavailable = () =>
  new SymmyJobWorkerError({ code: 'symmy_job_worker_unavailable', reason: 'Fixture unavailable' });
const unusedInvoker: ScopedRoutineInvoker = { invoke: () => Effect.die('No direct test SQL') };

const defaultExecute = (effect: SymmyPinnedEffect): Effect.Effect<SymmyExecutionOutcome, SymmyJobWorkerError> =>
  Effect.succeed({
    effectId: effect.ref.effectId,
    owner: effect.ref.operation.moduleId,
    status: 'accepted_change',
  });
const defaultRecover = (effect: SymmyPinnedEffect): Effect.Effect<SymmyOriginalEffectRecovery, SymmyJobWorkerError> =>
  Effect.succeed({
    outcome: { effectId: effect.ref.effectId, owner: effect.ref.operation.moduleId, status: 'accepted_change' },
    status: 'settled',
  });

const claimMode = (state: string): SymmyEffectClaim['mode'] => {
  if (state === 'planned' || state === 'blocked') {
    return 'execute';
  }
  return state === 'settled' ? 'settled' : 'recover';
};

const harness = () => {
  let job = initialJob;
  let jobPresent = true;
  let originalEligible = true;
  let systemEligible = true;
  let routeEligible = true;
  let notified = 0;
  let notificationFails = false;
  const executed: SymmyPinnedEffect[] = [];
  const recovered: SymmyPinnedEffect[] = [];
  let execute = defaultExecute;
  let recover = defaultRecover;
  const adapter: SymmyEffectAdapter = {
    execute: ({ effect }) =>
      Effect.suspend(() => {
        executed.push(effect);
        return execute(effect);
      }),
    operation,
    recover: ({ effect }) =>
      Effect.suspend(() => {
        recovered.push(effect);
        return recover(effect);
      }),
  };
  const store = {
    canExecute: () => Effect.sync(() => routeEligible),
    claim: (_jobId: string, claimedId: string): Effect.Effect<SymmyEffectClaim> =>
      Effect.sync(() => {
        const entry = job.effects.find(({ effect }) => effect.ref.effectId === claimedId);
        if (entry === undefined) {
          return { effect: Option.none(), mode: 'blocked', version: 0 };
        }
        const mode = claimMode(entry.state);
        const version = entry.version + 1;
        job = {
          ...job,
          effects: job.effects.map((saved) => (saved === entry ? { ...saved, state: 'attempting', version } : saved)),
        };
        return { effect: Option.some(entry.effect), mode, version };
      }),
    load: () => Effect.succeed(jobPresent ? Option.some(job) : Option.none()),
    markBlocked: (_jobId: string, markedId: string) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((entry) =>
            entry.effect.ref.effectId === markedId
              ? {
                  ...entry,
                  outcome: Option.some({
                    effectId: entry.effect.ref.effectId,
                    owner: 'integration.symmy',
                    status: 'denied' as const,
                  }),
                  state: 'blocked',
                }
              : entry,
          ),
        };
        return true;
      }),
    markIndeterminate: (_jobId: string, markedId: string) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((entry) =>
            entry.effect.ref.effectId === markedId ? { ...entry, state: 'indeterminate' } : entry,
          ),
        };
        return true;
      }),
    recordExecutor: (_jobId: string, markedId: string, _token: string, _version: number, executorId: string) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((saved) =>
            saved.effect.ref.effectId === markedId
              ? {
                  ...saved,
                  ownerExecutorPrincipalId: Schema.decodeUnknownSync(
                    SymmyExecutionEffectStateSchema.fields.ownerExecutorPrincipalId,
                  )(executorId),
                }
              : saved,
          ),
        };
        return true;
      }),
    recordInvocation: (_jobId: string, markedId: string, _token: string, _version: number, invocationId: string) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((saved) =>
            saved.effect.ref.effectId === markedId
              ? {
                  ...saved,
                  ownerInvocationId: Schema.decodeUnknownSync(SymmyExecutionEffectStateSchema.fields.ownerInvocationId)(
                    invocationId,
                  ),
                }
              : saved,
          ),
        };
        return true;
      }),
    recordOwnerReceipt: (
      _jobId: string,
      markedId: string,
      _token: string,
      _version: number,
      ownerReceipt: SymmyOwnerReceipt,
    ) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((saved) =>
            saved.effect.ref.effectId === markedId ? { ...saved, ownerReceipt: Option.some(ownerReceipt) } : saved,
          ),
        };
        return true;
      }),
    recordOwnerRequest: (
      _jobId: string,
      markedId: string,
      _token: string,
      _version: number,
      identity: Parameters<ReturnType<typeof symmyJobExecutionStore>['recordOwnerRequest']>[4],
    ) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((saved) =>
            saved.effect.ref.effectId === markedId
              ? {
                  ...saved,
                  ownerAuthContextRef: Option.some(identity.authContextRef),
                  ownerExecutorPrincipalId: Schema.decodeUnknownSync(
                    SymmyExecutionEffectStateSchema.fields.ownerExecutorPrincipalId,
                  )(identity.executorPrincipalId),
                  ownerRequestHash: Option.some(identity.requestHash),
                }
              : saved,
          ),
        };
      }),
    recordResolvedEffect: (
      _jobId: string,
      markedId: string,
      _token: string,
      _version: number,
      effect: SymmyPinnedEffect,
    ) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((saved) =>
            saved.effect.ref.effectId === markedId ? { ...saved, resolvedEffect: Option.some(effect) } : saved,
          ),
        };
        return true;
      }),
    settle: (_jobId: string, settledId: string, _token: string, _version: number, outcome: SymmyExecutionOutcome) =>
      Effect.sync(() => {
        job = {
          ...job,
          effects: job.effects.map((entry) =>
            entry.effect.ref.effectId === settledId
              ? { ...entry, outcome: Option.some(outcome), state: 'settled' }
              : entry,
          ),
        };
        return true;
      }),
  };
  const tenantScope = {
    run: <Failure, Requirements>(
      _context: OutboxWorkerHandlerContext,
      observe: (scope: OutboxWorkerTenantScopeView) => Effect.Effect<void, Failure, Requirements>,
    ) =>
      observe({
        completionPublisher: { publish: () => Effect.die('Completion belongs to Core delivery') },
        readOriginalActionInvocation: () => Effect.succeed(Option.none()),
        readWorkloadPrincipalEligibility: ({ kind }) =>
          Effect.sync(() => (kind === 'system' ? systemEligible : originalEligible)),
        routineInvoker: unusedInvoker,
        tenantId,
      }),
  };
  const identity = {
    resolve: () =>
      Effect.succeed(
        trustResolvedSystemPrincipalContext({
          authContextRef: 'job:fixture:run:1',
          authMethod: 'system',
          principalId: systemId,
          tenantId,
        }),
      ),
  };
  const deliverNotification = () =>
    Effect.suspend(() => {
      notified += 1;
      return notificationFails
        ? Effect.fail(new SymmyJobNotificationError({ code: 'notification_retry' }))
        : Effect.succeed('delivered' as const);
    });
  const makeWorker = (adapters: readonly SymmyEffectAdapter[] = [adapter]) =>
    Effect.succeed({
      execute: (payload: { readonly jobId: string }, workerContext: OutboxWorkerHandlerContext) =>
        makeSymmyJobWorker.pipe(
          Effect.flatMap((worker) => worker.execute(payload, workerContext)),
          Effect.provideService(SymmyEffectAdapters, { adapters }),
          Effect.provideService(SymmyWorkerIdentity, identity),
          Effect.provideService(SymmyJobExecutionPersistence, { storeFor: () => store }),
          Effect.provideService(OutboxWorkerTenantScope, tenantScope),
          Effect.provideService(SymmyJobNotification, { deliver: deliverNotification }),
          Effect.provideService(SymmyJobNotificationStore, {
            claim: () => Effect.die('Unexpected native notification store'),
            settle: () => Effect.die('Unexpected native notification store'),
          }),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
          Effect.provide(NodeCrypto.layer),
        ),
    });
  return {
    execute: (value: typeof execute) => {
      execute = value;
    },
    executed,
    job: () => job,
    jobPresent: (value: boolean) => {
      jobPresent = value;
    },
    makeWorker,
    notificationFails: (value: boolean) => {
      notificationFails = value;
    },
    notified: () => notified,
    originalEligible: (value: boolean) => {
      originalEligible = value;
    },
    recover: (value: typeof recover) => {
      recover = value;
    },
    recovered,
    replaceJob: (value: SymmyExecutionJob) => {
      job = value;
    },
    routeEligible: (value: boolean) => {
      routeEligible = value;
    },
    systemEligible: (value: boolean) => {
      systemEligible = value;
    },
  };
};

describe('Symmy durable execution and original-effect recovery', () => {
  it.effect('refuses an absent stored job before any owner effect or notification', () =>
    Effect.gen(function* absentStoredJob() {
      const fixture = harness();
      fixture.jobPresent(false);
      const failure = yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(failure).toMatchObject({ code: 'symmy_job_worker_invalid' });
      expect(fixture.executed).toHaveLength(0);
      expect(fixture.recovered).toHaveLength(0);
      expect(fixture.notified()).toBe(0);
      expect(fixture.job()).toEqual(initialJob);
    }),
  );

  it.effect('does not repeat a settled effect when the refreshed job becomes absent', () =>
    Effect.gen(function* absentAfterSettlement() {
      const fixture = harness();
      fixture.execute((effect) => {
        fixture.jobPresent(false);
        return defaultExecute(effect);
      });
      const worker = yield* fixture.makeWorker();
      const firstFailure = yield* Effect.flip(worker.execute({ jobId }, context));
      expect(firstFailure).toMatchObject({ code: 'symmy_job_worker_invalid' });
      expect(fixture.executed.map(({ ref }) => ref.effectId)).toEqual([effectId]);
      expect(fixture.job().effects.map(({ state }) => state)).toEqual(['settled', 'settled']);
      const repeatedFailure = yield* Effect.flip(worker.execute({ jobId }, context));
      expect(repeatedFailure).toMatchObject({ code: 'symmy_job_worker_invalid' });
      expect(fixture.executed).toHaveLength(1);
      expect(fixture.recovered).toHaveLength(0);
      expect(fixture.notified()).toBe(0);
    }),
  );

  it.effect('shows fresh revoked authority as blocked and reactivates only the same effect', () =>
    Effect.gen(function* blockedOriginal() {
      const fixture = harness();
      fixture.originalEligible(false);
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.job().effects[1]?.state).toBe('blocked');
      expect(fixture.executed).toHaveLength(0);
      expect(fixture.recovered).toHaveLength(0);
      fixture.originalEligible(true);
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed).toEqual([initialJob.effects[1]?.effect]);
      expect(fixture.recovered).toHaveLength(0);
      expect(fixture.job().effects.map(({ state }) => state)).toEqual(['settled', 'settled']);
    }),
  );

  it.effect('recovers a lost acknowledgement after restart and never replays an accepted sibling', () =>
    Effect.gen(function* lostAcknowledgement() {
      const fixture = harness();
      fixture.execute(() => Effect.fail(unavailable()));
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.job().effects[1]?.state).toBe('indeterminate');
      fixture.originalEligible(false);
      fixture.routeEligible(false);
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed.map(({ ref }) => ref.effectId)).toEqual([effectId]);
      expect(fixture.recovered).toEqual([initialJob.effects[1]?.effect]);
      expect(fixture.job().effects.map(({ state }) => state)).toEqual(['settled', 'settled']);
    }),
  );

  it.effect('requires definite not-committed recovery and fresh authorization before reusing the same effect', () =>
    Effect.gen(function* definiteRecovery() {
      const fixture = harness();
      fixture.execute(() => Effect.fail(unavailable()));
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      fixture.recover(() => Effect.succeed({ status: 'not_committed' }));
      fixture.execute((effect) =>
        Effect.succeed({ effectId: effect.ref.effectId, owner: 'integration.symmy', status: 'accepted_no_change' }),
      );
      fixture.originalEligible(false);
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed).toHaveLength(1);
      fixture.originalEligible(true);
      fixture.routeEligible(false);
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed).toHaveLength(1);
      fixture.routeEligible(true);
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed).toEqual([initialJob.effects[1]?.effect, initialJob.effects[1]?.effect]);
    }),
  );

  it.effect('keeps ambiguous recovery retryable without attempting another mutation', () =>
    Effect.gen(function* ambiguousRecovery() {
      const fixture = harness();
      fixture.execute(() => Effect.fail(unavailable()));
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      fixture.recover(() => Effect.succeed({ status: 'unavailable' }));
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed).toHaveLength(1);
      expect(fixture.job().effects[1]?.state).toBe('indeterminate');
    }),
  );

  it.effect('does not run without the current exact system workload binding', () =>
    Effect.gen(function* systemRevoked() {
      const fixture = harness();
      fixture.systemEligible(false);
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed).toHaveLength(0);
      expect(fixture.recovered).toHaveLength(0);
    }),
  );

  it.effect('keeps unconfigured production dispatch unavailable and rejects unattested deliveries', () =>
    Effect.gen(function* unavailableDispatch() {
      const fixture = harness();
      yield* Effect.flip((yield* fixture.makeWorker([])).execute({ jobId }, context));
      const failure = yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, rawContext));
      expect(failure).toMatchObject({ code: 'symmy_job_worker_invalid' });
      expect(fixture.job().effects[1]?.state).toBe('planned');
      expect(fixture.executed).toHaveLength(0);
    }),
  );

  it.effect('rejects a receipt for another effect without settling the original', () =>
    Effect.gen(function* wrongReceipt() {
      const fixture = harness();
      fixture.execute(() =>
        Effect.succeed({
          effectId: initialJob.plan.items[0].effects[0].ref.effectId,
          owner: 'integration.symmy',
          status: 'accepted_change',
        }),
      );
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.job().effects[1]?.state).toBe('indeterminate');
      expect(Option.isNone(fixture.job().effects[1]?.outcome ?? Option.none())).toBe(true);
    }),
  );
  it.effect('continues an independent branch after an uncertain owner response', () =>
    Effect.gen(function* independentBranches() {
      const fixture = harness();
      fixture.replaceJob({
        ...initialJob,
        effects: initialJob.effects.map((saved) => ({ ...saved, outcome: Option.none(), state: 'planned' as const })),
      });
      fixture.execute((effect) =>
        effect.ref.effectId === siblingId ? Effect.fail(unavailable()) : defaultExecute(effect),
      );
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed.map(({ ref }) => ref.effectId)).toEqual([siblingId, effectId]);
      expect(fixture.job().effects.map(({ state }) => state)).toEqual(['indeterminate', 'settled']);
    }),
  );

  it.effect('executes a named cross-item parent before its child regardless of array order', () =>
    Effect.gen(function* dependencyOrder() {
      const fixture = harness();
      const childItem = '10000000-0000-4000-8000-000000000020';
      const parent = pinned(siblingId, 'parent-effect');
      const child = {
        ...pinned(effectId, 'child-effect'),
        dependsOn: [{ effectKey: 'parent-effect', itemKey: 'parent-item' }],
        itemId: childItem,
      };
      fixture.replaceJob(
        parseJob({
          ...initialJob,
          effects: [
            { effect: child, outcome: null, state: 'planned', version: 0 },
            { effect: parent, outcome: null, state: 'planned', version: 0 },
          ],
          legalEntityId: null,
          plan: {
            items: [
              { effects: [child], itemId: childItem, itemKey: 'child-item' },
              { effects: [parent], itemId, itemKey: 'parent-item' },
            ],
          },
        }),
      );
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed.map(({ ref }) => ref.effectId)).toEqual([siblingId, effectId]);
      expect(fixture.job().effects.every(({ state }) => state === 'settled')).toBe(true);
    }),
  );

  it.effect('does not call a child owner when its exact parent effect was rejected', () =>
    Effect.gen(function* rejectedDependency() {
      const fixture = harness();
      const parent = pinned(siblingId, 'parent');
      const child = { ...pinned(effectId, 'child'), dependsOn: ['parent'] };
      fixture.replaceJob(
        parseJob({
          ...initialJob,
          effects: [
            { effect: child, outcome: null, state: 'planned', version: 0 },
            { effect: parent, outcome: null, state: 'planned', version: 0 },
          ],
          legalEntityId: null,
          plan: { items: [{ effects: [child, parent], itemId, itemKey: 'item' }] },
        }),
      );
      fixture.execute((effect) =>
        Effect.succeed({ effectId: effect.ref.effectId, owner: 'integration.symmy', status: 'denied' }),
      );
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed.map(({ ref }) => ref.effectId)).toEqual([siblingId]);
      expect(Option.getOrUndefined(fixture.job().effects[0]?.outcome ?? Option.none())).toEqual({
        owner: 'integration.symmy',
        reason: 'missing_context',
        status: 'unsupported',
      });
    }),
  );
  it.effect('does not send a completion callback for a retention-only policy', () =>
    Effect.gen(function* retentionOnly() {
      const fixture = harness();
      fixture.replaceJob({
        ...initialJob,
        lifecyclePolicy: Schema.decodeUnknownSync(SymmyExecutionJobSchema.fields.lifecyclePolicy)({
          policyId: 'retention-policy',
          revision: '1',
        }),
      });
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.notified()).toBe(0);
    }),
  );
  it.effect('retries a requested failed callback without running settled owner effects again', () =>
    Effect.gen(function* callbackRetry() {
      const fixture = harness();
      fixture.replaceJob({
        ...initialJob,
        lifecyclePolicy: Schema.decodeUnknownSync(SymmyExecutionJobSchema.fields.lifecyclePolicy)({
          notificationRequested: true,
          policyId: 'retention-policy',
          revision: '1',
        }),
      });
      fixture.notificationFails(true);
      yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
      expect(fixture.executed).toHaveLength(1);
      fixture.notificationFails(false);
      yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
      expect(fixture.executed).toHaveLength(1);
      expect(fixture.notified()).toBe(2);
    }),
  );
  for (const stamped of [false, true]) {
    it.effect(
      stamped
        ? 'preserves indeterminate original work after an executor pin despite a later invalid result'
        : 'settles a finite invalid command with no durable owner attempt as unsupported',
      () =>
        Effect.gen(function* definitiveInvalid() {
          const fixture = harness();
          const raw = Schema.encodeSync(SymmyExecutionJobSchema)(initialJob);
          const effect = {
            ...pinned(effectId, 'effect'),
            intent: {
              _tag: 'CatalogCreateProduct',
              payload: {
                name: 'Internal fixture Product',
                sourceCorrelation: {
                  issuerId: 'internal',
                  mappingRevision: 'mapping-1',
                  recordId: 'fixture-record',
                  recordNamespace: 'internal',
                  routeScope: routeId,
                },
              },
            },
          };
          const state = { effect, outcome: null, state: 'planned', version: 0 };
          const selectedState = stamped ? { ...state, ownerExecutorPrincipalId: systemId } : state;
          fixture.replaceJob(
            parseJob({
              ...raw,
              effects: [raw.effects[0], selectedState],
              plan: { items: [{ effects: [pinned(siblingId, 'sibling'), effect], itemId, itemKey: 'item' }] },
            }),
          );
          fixture.execute(() =>
            Effect.fail(
              new SymmyJobWorkerError({
                code: 'symmy_job_worker_invalid',
                reason: 'Fixture finite command rejected before dispatch',
              }),
            ),
          );
          if (stamped) {
            yield* Effect.flip((yield* fixture.makeWorker()).execute({ jobId }, context));
            expect(fixture.job().effects[1]?.state).toBe('indeterminate');
          } else {
            yield* (yield* fixture.makeWorker()).execute({ jobId }, context);
            expect(fixture.job().effects[1]?.state).toBe('settled');
            expect(Option.getOrUndefined(fixture.job().effects[1]?.outcome ?? Option.none())).toMatchObject({
              reason: 'missing_context',
              status: 'unsupported',
            });
          }
          expect(fixture.job().effects[0]?.state).toBe('settled');
        }),
    );
  }
});
