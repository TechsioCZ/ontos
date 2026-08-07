// @effect-diagnostics lazyEffect:off
import { Context, Effect, Layer, Schema } from 'effect';
import { TrustedPrincipalContextSchema } from '../actions/context.ts';
import type { TrustedPrincipalContext } from '../actions/context.ts';
import type { ModuleEntrypointDescriptor } from './module-entrypoint.ts';
import { ModuleStateGate, ModuleStateGateLive } from './module-state-gate.ts';
import type { ModuleStateGateShape, ModuleStateSnapshot } from './module-state-gate.ts';
import { ModuleStateCheckUnavailableError } from './module-state-gate-errors.ts';
import type { ModuleStateGateError } from './module-state-gate-errors.ts';

const unavailable = () =>
  new ModuleStateCheckUnavailableError({
    code: 'module_state_check_unavailable',
    reason: 'Module state could not be checked safely',
  });

export interface RunGatedModuleEntrypointInput<Value, AuthorizationError, LoadError, Requirements> {
  readonly authorize: Effect.Effect<void, AuthorizationError, Requirements>;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly load: () => Effect.Effect<Value, LoadError, Requirements>;
  readonly snapshot: ModuleStateSnapshot;
}

export interface ModuleEntrypointGatewayShape {
  readonly check: ModuleStateGateShape['check'];
  readonly prepareSnapshot: (
    context: Readonly<TrustedPrincipalContext>,
    entrypoints: readonly ModuleEntrypointDescriptor[],
  ) => Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError>;
  readonly run: <Value, AuthorizationError, LoadError, Requirements>(
    input: RunGatedModuleEntrypointInput<Value, AuthorizationError, LoadError, Requirements>,
  ) => Effect.Effect<Value, AuthorizationError | LoadError | ModuleStateGateError, Requirements>;
}

export const makeModuleEntrypointGateway = (
  gate: ModuleStateGateShape,
): ModuleEntrypointGatewayShape => ({
  check: gate.check,
  prepareSnapshot: (context, entrypoints) =>
    Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(context).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((trustedContext) =>
        gate.prepareSnapshot(trustedContext.tenantId, entrypoints),
      ),
    ),
  run: (input) =>
    gate
      .check(input.snapshot, input.entrypoint)
      .pipe(Effect.andThen(input.authorize), Effect.andThen(Effect.suspend(input.load))),
});

export class ModuleEntrypointGateway extends Context.Service<
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayShape
>()('@app/core-runtime/modules/module-entrypoint-gateway/ModuleEntrypointGateway') {}

export const ModuleEntrypointGatewayLive = Layer.effect(
  ModuleEntrypointGateway,
  ModuleStateGate.pipe(Effect.map(makeModuleEntrypointGateway)),
).pipe(Layer.provide(ModuleStateGateLive));
