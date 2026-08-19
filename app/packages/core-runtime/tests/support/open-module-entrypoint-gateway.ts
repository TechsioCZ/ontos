import { Effect } from 'effect';
import { decodeTrustedPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import type { ModuleEntrypointDescriptor } from '../../src/modules/module-entrypoint.ts';
import type { ModuleEntrypointGatewayService } from '../../src/modules/module-entrypoint-gateway.ts';
import { ModuleStateCheckUnavailableError } from '../../src/modules/module-state-gate-errors.ts';
import { openModuleStateGate } from './open-module-state-gate.ts';

const unavailable = () =>
  new ModuleStateCheckUnavailableError({
    code: 'module_state_check_unavailable',
    reason: 'Module state could not be checked safely',
  });

const prepareSnapshotInput = <Input>(
  context: Input,
  entrypoints: readonly ModuleEntrypointDescriptor[],
) =>
  decodeTrustedPrincipalContext(context).pipe(
    Effect.mapError(unavailable),
    Effect.flatMap((trustedContext) =>
      openModuleStateGate.prepareSnapshot(trustedContext.tenantId, entrypoints),
    ),
  );

const run: ModuleEntrypointGatewayService['run'] = (input) =>
  input.authorize.pipe(Effect.andThen(Effect.suspend(input.load)));

export const openModuleEntrypointGateway: ModuleEntrypointGatewayService = Object.freeze({
  check: () => Effect.void,
  prepareSnapshot: prepareSnapshotInput,
  prepareSnapshotInput,
  run,
});
