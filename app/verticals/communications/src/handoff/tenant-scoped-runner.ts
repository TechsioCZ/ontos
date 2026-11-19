import type { ScopedRoutineInvoker } from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerTenantScopeService } from '@app/core-runtime/outbox/worker';
import { Data, Effect, Option, Ref } from 'effect';

import { storeUnavailable } from './process-intent-handoff.ts';
import type { HandoffStoreUnavailable, ScopedRunner } from './process-intent-handoff.ts';

type TenantScopeRun = OutboxWorkerTenantScopeService['run'];

/** The scope ran its program to the end and still held no value: a defect of Core's scope, never a recoverable failure. */
class ScopedProgramProducedNoValue extends Data.TaggedError('ScopedProgramProducedNoValue') {}

const runScoped = Effect.fn('Communications.runInTenantScope')(function* runScoped<Value, Requirements>(
  run: TenantScopeRun,
  context: OutboxWorkerHandlerContext,
  program: (invoker: ScopedRoutineInvoker) => Effect.Effect<Value, HandoffStoreUnavailable, Requirements>,
): Effect.fn.Return<Value, HandoffStoreUnavailable, Requirements> {
  const result = yield* Ref.make(Option.none<Value>());
  yield* run(context, (scope) =>
    program(scope.routineInvoker).pipe(Effect.flatMap((value) => Ref.set(result, Option.some(value)))),
  ).pipe(
    Effect.catchTag('OutboxWorkerTenantScopeError', (failure) =>
      Effect.fail(storeUnavailable('The worker Tenant scope is unavailable', failure)),
    ),
  );
  const found = yield* Ref.get(result);
  return yield* Option.match(found, {
    onNone: () => Effect.die(new ScopedProgramProducedNoValue()),
    onSome: (value) => Effect.succeed(value),
  });
});

/**
 * The step's scoped runner over Core's Tenant worker scope: each program runs in ONE transaction of the verified
 * Tenant, and its value leaves the scope (Core's scope itself only returns void).
 */
export const tenantScopedRunner =
  (run: TenantScopeRun, context: OutboxWorkerHandlerContext): ScopedRunner =>
  (program) =>
    runScoped(run, context, program);
