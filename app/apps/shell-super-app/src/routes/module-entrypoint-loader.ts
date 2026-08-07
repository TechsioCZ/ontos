import { Effect } from 'effect';
import type {
  ModuleEntrypointDescriptor,
  ModuleEntrypointGatewayShape,
  ModuleStateGateError,
  TrustedPrincipalContext,
} from '@app/core-runtime';

export interface LazyModuleEntrypointLoad<Value, AuthorizationError, LoadError, Requirements> {
  readonly authorize: Effect.Effect<void, AuthorizationError, Requirements>;
  readonly entrypoint: ModuleEntrypointDescriptor<'page' | 'public_component'>;
  readonly load: () => Effect.Effect<Value, LoadError, Requirements>;
}

/** Shell-only composition seam. Callers pass typed descriptors and lazy thunks, never remote strings. */
export const loadModuleEntrypointComposition = <Value, AuthorizationError, LoadError, Requirements>(
  gateway: ModuleEntrypointGatewayShape,
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
