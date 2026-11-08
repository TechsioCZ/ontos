import { Context, Layer } from 'effect';

import { makeDrizzleActionMandateDispatch } from './action-mandate-dispatch.ts';
import type { ActionMandateDispatch } from './action-mandate-dispatch.ts';

/** Optional only at composition time. Missing wiring never turns a mandate into direct-run authority. */
export class ActionMandateDispatcher extends Context.Service<ActionMandateDispatcher, ActionMandateDispatch>()(
  '@app/core-runtime/access/approvals/action-mandate-dispatch-service/ActionMandateDispatcher',
) {}

export const ActionMandateDispatcherLive = Layer.effect(ActionMandateDispatcher, makeDrizzleActionMandateDispatch());
