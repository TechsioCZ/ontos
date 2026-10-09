import { Context } from 'effect';
import type { Effect } from 'effect';

import type { ActiveApplicationCompositionSourceReadError } from './active-application-composition-source-errors.ts';

/** The private transport boundary owns lazy, bounded reads of one complete encoded snapshot. */
interface ActiveApplicationCompositionSourceContract {
  readonly load: Effect.Effect<string, ActiveApplicationCompositionSourceReadError>;
}

export class ActiveApplicationCompositionSource extends Context.Service<
  ActiveApplicationCompositionSource,
  ActiveApplicationCompositionSourceContract
>()('@app/core-runtime/modules/active-application-composition-source-service/ActiveApplicationCompositionSource') {}
