/* eslint-disable promise/prefer-await-to-callbacks, promise/prefer-await-to-then -- Effect error combinators are the typed async boundary. */
import { Cause, Effect } from 'effect';
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

/** Settles one browser entrypoint independently with a bounded, audience-safe result. */
export const settleModuleEntrypointLoad = <Value>(
  load: () => Promise<Value>,
  isCompatible: (value: Value) => boolean,
  timeoutMs = 5000,
): Effect.Effect<SettledModuleEntrypointLoad<Value>> =>
  Effect.tryPromise(load).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.map((value): SettledModuleEntrypointLoad<Value> =>
      isCompatible(value)
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
    yield* Effect.forEach((load: (typeof loads)[number]) =>
      gateway.check(snapshot, load.entrypoint),
    )(loads);
    return yield* Effect.forEach((load: (typeof loads)[number]) =>
      gateway.run({ ...load, snapshot }),
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
