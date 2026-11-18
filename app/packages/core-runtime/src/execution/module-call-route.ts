/**
 * `@app/core-runtime/execution/module-call-route` (server only): the governed HTTP route for calls to
 * verticals. Implemented in shared-contracts (`@app/shared-contracts/server/sdk-module-call-route`,
 * `ModuleCallRouteLive`) and provided by a vertical host; obligations in `contract.ts`. This subpath
 * exports exactly the tag and the data a route implementation needs, nothing else of the engine.
 */
import { Context } from 'effect';

import type { CallRoute } from './contract.ts';

export { RouteAnswerSchema } from './contract.ts';
export type { CallRoute, CallRouteRequest, ResolvedCallRequirement, RouteAnswer, SelectedCaller } from './contract.ts';

export class ModuleCallRoute extends Context.Service<ModuleCallRoute, CallRoute>()(
  '@app/core-runtime/execution/module-call-route/ModuleCallRoute',
) {}
