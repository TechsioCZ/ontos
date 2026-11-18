import { Context } from 'effect';

import type { CallRoute } from './contract.ts';

/**
 * The governed HTTP route for calls to verticals. Implemented in shared-contracts
 * (`@app/shared-contracts/server/sdk-module-call-route`) and provided by the host; obligations in
 * `contract.ts`.
 */
export class ModuleCallRoute extends Context.Service<ModuleCallRoute, CallRoute>()(
  '@app/core-runtime/execution/module-call-route/ModuleCallRoute',
) {}
