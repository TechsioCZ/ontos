import { Effect } from 'effect';

import type { ActionRuntimeOptions } from '../../src/actions/runtime.ts';
import { openModuleEntrypointGateway } from './open-module-entrypoint-gateway.ts';
import { openModuleStateGate } from './open-module-state-gate.ts';

export const openActionRuntimeOptions = {
  moduleEntrypointGateway: openModuleEntrypointGateway,
  moduleStateGate: openModuleStateGate,
  // These fixtures test unrelated Action boundaries. Composition fencing has its own native
  // PostgreSQL suite; the fixture authority must never become the production default.
  lockCompositionAuthority: () => Effect.succeed([]),
  resolveCompositionRevision: () => Effect.succeed('a'.repeat(64)),
} satisfies Pick<
  ActionRuntimeOptions,
  'moduleEntrypointGateway' | 'moduleStateGate' | 'lockCompositionAuthority' | 'resolveCompositionRevision'
>;
