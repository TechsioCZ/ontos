import { Effect } from 'effect';
import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayService,
  ModuleStateGateError,
  RunGatedModuleEntrypointInput,
  TrustedPrincipalContext,
} from '@app/core-runtime';

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
