import { Cause, Effect, Exit, Schema } from 'effect';
import { FetchHttpClient, HttpClient } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import type { ActionRegistration } from '../../src/actions/definition.ts';
import { IoInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { moduleReleaseFetch } from '../../src/http/unit-service-fetch.export.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { makeOutboxWorkerComposition } from '../support/outbox-worker-composition.ts';
import { makeActionTestHarness } from '../../src/testing/actions.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:action-guard-test',
  authMethod: 'session',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '30000000-0000-4000-8000-000000000001',
} as const;

const descriptor = {
  accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: 'test.guard.read.v1' },
  actionKey: 'test.guard.record',
  auditProfile: 'standard',
  domainErrorSchema: Schema.Never,
  domainEvents: {},
  entrypoint: defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: 'test.guard.record',
    moduleKey: 'test.guard',
    role: 'action',
  }),
  idempotency: 'optional',
  legalEntityScope: 'optional',
  owningModuleKey: 'test.guard',
  payloadSchema: Schema.Struct({ amount: Schema.Finite }),
  policies: [],
  resultSchema: Schema.Struct({ total: Schema.Finite }),
  schemaVersion: '1',
} as const;

type GuardAction = ActionRegistration<
  typeof descriptor.payloadSchema,
  typeof descriptor.resultSchema,
  typeof Schema.Never,
  typeof descriptor.domainEvents,
  typeof descriptor.owningModuleKey
>;

type GuardWrite = (payload: { readonly amount: number }) => Effect.Effect<{ readonly total: number }>;

const isRequest = Schema.is(Schema.instanceOf(Request));
/** Every fetch that reaches the platform is recorded; inside the Action transaction none may. */
const recordingFetch =
  (events: string[]) =>
  (input: Request | URL | string): Promise<Response> => {
    events.push(`fetch:${isRequest(input) ? input.url : String(input)}`);
    return Promise.resolve(new Response('{}', { status: 200 }));
  };
// @effect-diagnostics-next-line strictEffectProvide:off -- Test owner call over the platform fetch client.
const ownerFetch = HttpClient.get('https://owner.example/current').pipe(Effect.provide(FetchHttpClient.layer));
const [ownerModule] = makeOutboxWorkerComposition([{ appId: 'owner-release', moduleId: 'commerce.owner' }]).modules;

const run = (events: string[], registration: GuardAction) =>
  Effect.gen(function* runGuardedAction() {
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
    const exit = yield* Effect.exit(
      harness.runtime.runAction({
        payload: { amount: 3 },
        principal,
        registration,
        transport: { correlationId: 'action-guard-test' },
      }),
    );
    return { exit, snapshot: harness.snapshot() };
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch(events)));

const diedInsideTransaction = (exit: Exit.Exit<unknown, unknown>, io: string): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      Schema.is(Schema.instanceOf(IoInsideDatabaseTransaction))(reason.defect) &&
      reason.defect.operationKey === descriptor.actionKey &&
      reason.defect.io === io,
  );

it.effect('runs prepare before BEGIN, write inside the transaction, and finish after COMMIT', () =>
  Effect.gen(function* pipelineOrder() {
    const events: string[] = [];
    const { exit, snapshot } = yield* run(
      events,
      defineAction(descriptor, {
        // oxlint-disable perfectionist/sort-objects -- Steps stay in execution order: each step's types infer from the previous one.
        prepare: (payload, context) =>
          ownerFetch.pipe(
            Effect.andThen(
              context.transaction((transaction) =>
                Effect.sync(() => events.push(`owner-state:${transaction.scope.tenantId === principal.tenantId}`)),
              ),
            ),
            Effect.orDie,
            Effect.as(payload.amount * 2),
          ),
        write: (_payload, context) =>
          Effect.sync(() => {
            events.push(`write:${context.prepared}`);
            return { total: context.prepared };
          }),
        finish: (_payload, context) =>
          ownerFetch.pipe(
            Effect.orDie,
            Effect.andThen(Effect.sync(() => events.push(`finish:${context.result.total}`))),
          ),
        // oxlint-enable perfectionist/sort-objects
      }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ total: 6 });
    expect(events).toEqual([
      'fetch:https://owner.example/current',
      'owner-state:true',
      'write:6',
      'fetch:https://owner.example/current',
      'finish:6',
    ]);
    // One short owner transaction in prepare, then the Action's own.
    expect(snapshot.transactionCount).toBe(2);
    expect(snapshot.committed).toHaveLength(1);
  }),
);

it.effect('refuses outbound fetch and module transport inside the write step, and commits nothing', () =>
  Effect.gen(function* remoteIoInWrite() {
    const events: string[] = [];
    const releaseModule = yield* Effect.fromNullishOr(ownerModule).pipe(Effect.orDie);
    const writing = (io: Effect.Effect<unknown>): GuardAction =>
      defineAction(descriptor, { write: () => io.pipe(Effect.as({ total: 0 })) });
    const fetchInWrite = yield* run(events, writing(ownerFetch.pipe(Effect.orDie)));
    // Owner code that maps the failed fetch away still dies: the mark re-raises the refusal.
    const fetchMappedAway = yield* run(events, writing(ownerFetch.pipe(Effect.ignore)));
    const moduleTransport = yield* run(
      events,
      writing(moduleReleaseFetch(new Request('https://owner.example/api/records'), releaseModule).pipe(Effect.orDie)),
    );
    // The write step's own defect is logged and surfaces as a handler failure; the re-raised refusal dies.
    expect(Exit.isFailure(fetchInWrite.exit)).toBe(true);
    expect(diedInsideTransaction(fetchMappedAway.exit, 'outbound-fetch')).toBe(true);
    expect(Exit.isFailure(moduleTransport.exit)).toBe(true);
    expect(events).toEqual([]);
    for (const { snapshot } of [fetchInWrite, fetchMappedAway, moduleTransport]) {
      expect(snapshot.committed).toEqual([]);
    }
  }),
);

it.effect('logs a failed finish step without failing the committed Action', () =>
  Effect.gen(function* finishFailure() {
    const { exit, snapshot } = yield* run(
      [],
      defineAction(descriptor, {
        finish: () => Effect.die('notification transport down'),
        write: (payload) => Effect.succeed({ total: payload.amount }),
      }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ total: 3 });
    expect(snapshot.committed).toHaveLength(1);
  }),
);

it.effect('abandons what prepare reserved when the transaction does not commit, and only then', () =>
  Effect.gen(function* abandonAfterRollback() {
    const events: string[] = [];
    const reserving = (write: GuardWrite) =>
      defineAction(descriptor, {
        abandon: () => Effect.sync(() => events.push('release')),
        finish: () => Effect.sync(() => events.push('commit')),
        prepare: () => Effect.sync(() => events.push('reserve')),
        write,
      });
    const rolledBack = yield* run(events, reserving(() => Effect.die('owner write failed')));
    expect(Exit.isFailure(rolledBack.exit)).toBe(true);
    expect(rolledBack.snapshot.committed).toEqual([]);
    expect(events).toEqual(['reserve', 'release']);
    events.length = 0;
    const committed = yield* run(events, reserving((payload) => Effect.succeed({ total: payload.amount })));
    expect(Exit.isSuccess(committed.exit)).toBe(true);
    expect(events).toEqual(['reserve', 'commit']);
  }),
);
