import { Effect } from 'effect';
import type { ModuleStateGateService } from '../../src/modules/module-state-gate.ts';

const prepareSnapshot: ModuleStateGateService['prepareSnapshot'] = (tenantId, entrypoints) =>
  Effect.succeed(
    Object.freeze({
      entrypointKeys: Object.freeze(entrypoints.map(({ entrypointKey }) => entrypointKey)),
      moduleKeys: Object.freeze([
        ...new Set(
          entrypoints
            .filter((entrypoint) => entrypoint.scope === 'tenant')
            .map(({ moduleKey }) => moduleKey),
        ),
      ]),
      tenantId,
    }),
  );

export const openModuleStateGate: ModuleStateGateService = Object.freeze({
  check: () => Effect.void,
  prepareSnapshot,
  recheckWrite: () => Effect.void,
});
