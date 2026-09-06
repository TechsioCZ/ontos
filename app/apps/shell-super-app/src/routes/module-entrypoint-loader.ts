/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect error combinators are the typed async boundary. */
import { Cause, Deferred, Effect } from 'effect';
import type {
  InstalledDeploymentFailureReason,
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService,
  ModuleStateGateError,
  RunGatedModuleEntrypointInput,
  TrustedPrincipalContext,
} from '@app/core-runtime';

export type SettledModuleEntrypointLoad<Value> =
  | { readonly reason: InstalledDeploymentFailureReason; readonly state: 'unavailable' }
  | { readonly state: 'ready'; readonly value: Value };

export interface ModuleEntrypointLoadRequest<Identity, Value> {
  readonly identity: Identity;
  readonly isCompatible: (value: Value) => boolean;
  readonly load: () => Promise<Value>;
  readonly timeoutMs?: number;
}

export type IdentifiedSettledModuleEntrypointLoad<Identity, Value> =
  SettledModuleEntrypointLoad<Value> & { readonly identity: Identity };

/** Bound for independent external module loads so one navigation cannot fan out without limit. */
export const MODULE_LOAD_CONCURRENCY = 4;

const safelyCheckCompatibility = <Value>(
  value: Value,
  isCompatible: (value: Value) => boolean,
): boolean => {
  try {
    return isCompatible(value);
  } catch {
    return false;
  }
};

/** Settles one browser entrypoint independently with a bounded, audience-safe result. */
export const settleModuleEntrypointLoad = <Value>(
  load: () => Promise<Value>,
  isCompatible: (value: Value) => boolean,
  timeoutMs = 5000,
): Effect.Effect<SettledModuleEntrypointLoad<Value>> =>
  Effect.tryPromise(load).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.map((value): SettledModuleEntrypointLoad<Value> =>
      safelyCheckCompatibility(value, isCompatible)
        ? { state: 'ready', value }
        : { reason: 'incompatible', state: 'unavailable' },
    ),
    Effect.catch((error) =>
      Effect.succeed<SettledModuleEntrypointLoad<Value>>({
        reason: Cause.isTimeoutError(error) ? 'timeout' : 'unavailable',
        state: 'unavailable',
      }),
    ),
  );

const timeoutResult = { reason: 'timeout', state: 'unavailable' } as const;

// Runs one load to settlement. The slot (and its concurrency permit) lasts for the whole
// settlement because the underlying import cannot be cancelled; the deadline lives elsewhere.
const settleIntoDeferred = <Value>(
  { isCompatible, load }: ModuleEntrypointLoadRequest<unknown, Value>,
  result: Deferred.Deferred<SettledModuleEntrypointLoad<Value>>,
): Effect.Effect<void> =>
  Effect.tryPromise(load).pipe(
    Effect.map((value): SettledModuleEntrypointLoad<Value> =>
      safelyCheckCompatibility(value, isCompatible)
        ? { state: 'ready', value }
        : { reason: 'incompatible', state: 'unavailable' },
    ),
    Effect.orElseSucceed((): SettledModuleEntrypointLoad<Value> => ({
      reason: 'unavailable',
      state: 'unavailable',
    })),
    Effect.flatMap((settled) => Deferred.succeed(result, settled)),
    Effect.asVoid,
  );

interface PendingModuleEntrypointLoad<Identity, Value> {
  readonly request: ModuleEntrypointLoadRequest<Identity, Value>;
  readonly result: Deferred.Deferred<SettledModuleEntrypointLoad<Value>>;
}

const identify = <Identity, Value>({
  request,
  result,
}: PendingModuleEntrypointLoad<Identity, Value>): Effect.Effect<
  IdentifiedSettledModuleEntrypointLoad<Identity, Value>
> =>
  Deferred.await(result).pipe(
    Effect.map((settled) => ({ identity: request.identity, ...settled })),
  );

/**
 * Settles a set of browser entrypoints concurrently without widening one failure to the set.
 *
 * These loads are independent external module fetches, so they run concurrently, but the bound is
 * explicit and applies to what is in flight: a slot holds its permit until the underlying promise
 * settles, so timed-out imports cannot let one navigation open more remote requests than the
 * bound. Every caller still gets an answer by its deadline, measured from this call, even while it
 * waits for a permit. Results stay in request order and each entry settles on its own.
 */
export const settleModuleEntrypointLoads = <Identity, Value>(
  loads: readonly ModuleEntrypointLoadRequest<Identity, Value>[],
): Effect.Effect<readonly IdentifiedSettledModuleEntrypointLoad<Identity, Value>[]> =>
  Effect.suspend(() => {
    const pending: PendingModuleEntrypointLoad<Identity, Value>[] = loads.map((request) => ({
      request,
      result: Deferred.makeUnsafe<SettledModuleEntrypointLoad<Value>>(),
    }));
    // Deadlines are children of this call's fiber: whichever of settlement or deadline completes
    // the Deferred first wins, and leftover deadline fibers end with the call.
    const deadlines = Effect.forEach(
      pending,
      ({ request, result }) =>
        Effect.sleep(`${request.timeoutMs ?? 5000} millis`).pipe(
          Effect.flatMap(() => Deferred.succeed(result, timeoutResult)),
        ),
      // Every deadline starts now: the ceiling is the number of loads, never the load window.
      { concurrency: Math.max(pending.length, 1), discard: true },
    );
    // Detached: the settlement fibers only observe promises the JS runtime is already executing
    // and cannot cancel them, so they outlive the caller's deadline by design.
    const settlements = Effect.forEach(
      pending,
      ({ request, result }) => settleIntoDeferred(request, result),
      { concurrency: MODULE_LOAD_CONCURRENCY, discard: true },
    );
    const results = Effect.forEach(pending, identify, { concurrency: MODULE_LOAD_CONCURRENCY });
    return Effect.forkChild(deadlines).pipe(
      Effect.flatMap(() => Effect.forkDetach(settlements)),
      Effect.flatMap(() => results),
    );
  });

export type LazyModuleEntrypointLoad<Value, AuthorizationError, LoadError, Requirements> = Omit<
  RunGatedModuleEntrypointInput<Value, AuthorizationError, LoadError, Requirements>,
  'entrypoint' | 'snapshot'
> & {
  readonly entrypoint: ModuleEntrypointDescriptor<'page' | 'public_component'>;
};

/** Shell-only composition seam. Callers pass typed descriptors and lazy thunks, never remote strings. */
export const loadModuleEntrypointComposition = <Value, AuthorizationError, LoadError, Requirements>(
  gateway: ModuleEntrypointGatewayService,
  context: Readonly<TrustedPrincipalContext>,
  loads: readonly LazyModuleEntrypointLoad<Value, AuthorizationError, LoadError, Requirements>[],
): Effect.Effect<
  readonly Value[],
  AuthorizationError | LoadError | ModuleStateGateError,
  Requirements
> =>
  Effect.gen(function* loadModuleEntrypointCompositionEffect() {
    const snapshot = yield* gateway.prepareSnapshot(
      context,
      loads.map((load) => load.entrypoint),
    );
    // Sequential by intent, now stated: the gate must fail closed on the first denied entrypoint
    // before any authorize or load side effect runs for a later one.
    yield* Effect.forEach(
      (load: (typeof loads)[number]) => gateway.check(snapshot, load.entrypoint),
      { concurrency: 1 },
    )(loads);
    // Also sequential by intent: each run re-checks, authorizes, then loads, so concurrency here
    // would let a later entrypoint authorize and load past an earlier failure.
    return yield* Effect.forEach(
      (load: (typeof loads)[number]) => gateway.run({ ...load, snapshot }),
      { concurrency: 1 },
    )(loads);
  });

/** A resolved BFF target is the capability token that permits the browser-side lazy registry lookup. */
export const resolveThenLoadModuleTarget = <
  Target,
  Value,
  ResolutionError,
  LoadError,
  Requirements,
>(
  resolution: Effect.Effect<Target, ResolutionError, Requirements>,
  load: (target: Target) => Effect.Effect<Value, LoadError, Requirements>,
): Effect.Effect<Value, ResolutionError | LoadError, Requirements> =>
  resolution.pipe(Effect.flatMap(load));
