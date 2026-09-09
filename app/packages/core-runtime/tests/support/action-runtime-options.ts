import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import { openModuleEntrypointGateway } from './open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from './open-module-state-gate.ts';

export const openActionRuntimeOptions = {
  moduleEntrypointGateway: openModuleEntrypointGateway,
  moduleStateGate: openModuleStateGate,
} satisfies Pick<ActionRuntimeOptions, 'moduleEntrypointGateway' | 'moduleStateGate'>;
