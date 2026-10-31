import { Context, Effect } from 'effect';

import type { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';

/** Share a single wire observation only within the request that builds this service. */
export const requestScopedActiveApplicationCompositionSource = (
  load: ActiveApplicationCompositionSourceContract['load'],
) => Effect.cached(load).pipe(Effect.map((requestLoad) => Object.freeze({ load: requestLoad })));

/** The private transport boundary owns lazy, bounded reads of one complete encoded snapshot. */
interface ActiveApplicationCompositionSourceContract {
  readonly load: Effect.Effect<string, ActiveApplicationCompositionSourceReadError>;
}

export class ActiveApplicationCompositionSource extends Context.Service<
  ActiveApplicationCompositionSource,
  ActiveApplicationCompositionSourceContract
>()('@app/core-runtime/modules/active-application-composition-source-service/ActiveApplicationCompositionSource') {}
