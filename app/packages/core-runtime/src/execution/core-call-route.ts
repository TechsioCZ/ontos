import { Context } from 'effect';

import type { CallRoute } from './contract.ts';

/** Core's in-process route for calls to Core's own operations; obligations in `contract.ts`. */
export class CoreCallRoute extends Context.Service<CoreCallRoute, CallRoute>()(
  '@app/core-runtime/execution/core-call-route/CoreCallRoute',
) {}
