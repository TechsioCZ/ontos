import { Context, Effect, Layer } from 'effect';

import type { TrustedPrincipalContext } from '../actions/context.ts';
import { decodeTrustedPrincipalContext } from '../auth/system-principal-context-provenance.ts';
import type { ModuleEntrypointDescriptor } from './module-entrypoint.ts';
import { ModuleStateCheckUnavailableError } from './module-state-gate-errors.ts';
import type { ModuleStateGateError } from './module-state-gate-errors.ts';
import { ModuleStateGate } from './module-state-gate.ts';
import type {
  ModuleStateGateService,
  ModuleStateSnapshot,
} from './module-state-gate.ts';

const unavailable = (cause?: unknown) => {
  const error = new ModuleStateCheckUnavailableError({
    code: 'module_state_check_unavailable',
    reason: 'Module state could not be checked safely',
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: true,
        value: cause,
      });
};

export interface RunGatedModuleEntrypointInput<
  Value,
  AuthorizationError,
  LoadError,
  Requirements,
> {
  readonly authorize: Effect.Effect<void, AuthorizationError, Requirements>;
  readonly entrypoint: ModuleEntrypointDescriptor;
  readonly load: Effect.Effect<Value, LoadError, Requirements>;
  readonly snapshot: ModuleStateSnapshot;
}

export interface ModuleEntrypointGatewayService {
  readonly check: ModuleStateGateService['check'];
  readonly prepareSnapshot: (
    context: Readonly<TrustedPrincipalContext>,
    entrypoints: readonly ModuleEntrypointDescriptor[]
  ) => Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError>;
  readonly prepareSnapshotInput: <Input>(
    context: Input,
    entrypoints: readonly ModuleEntrypointDescriptor[]
  ) => Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError>;
  readonly run: <Value, AuthorizationError, LoadError, Requirements>(
    input: RunGatedModuleEntrypointInput<
      Value,
      AuthorizationError,
      LoadError,
      Requirements
    >
  ) => Effect.Effect<
    Value,
    AuthorizationError | LoadError | ModuleStateGateError,
    Requirements
  >;
}

export const makeModuleEntrypointGateway = <
  Gate extends ModuleStateGateService,
>(
  gate: Gate
): ModuleEntrypointGatewayService => {
  const prepareSnapshotInput = <Input>(
    context: Input,
    entrypoints: readonly ModuleEntrypointDescriptor[]
  ) =>
    decodeTrustedPrincipalContext(context).pipe(
      Effect.mapError(unavailable),
      Effect.flatMap((trustedContext) =>
        gate.prepareSnapshot(trustedContext.tenantId, entrypoints)
      )
    );
  return {
    check: gate.check,
    prepareSnapshot: prepareSnapshotInput,
    prepareSnapshotInput,
    run: (input) =>
      gate
        .check(input.snapshot, input.entrypoint)
        .pipe(Effect.andThen(input.authorize), Effect.andThen(input.load)),
  };
};

export class ModuleEntrypointGateway extends Context.Service<
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayService
>()(
  '@app/core-runtime/modules/module-entrypoint-gateway/ModuleEntrypointGateway'
) {}

export const ModuleEntrypointGatewayLive = Layer.effect(
  ModuleEntrypointGateway,
  ModuleStateGate.pipe(Effect.map(makeModuleEntrypointGateway))
);
