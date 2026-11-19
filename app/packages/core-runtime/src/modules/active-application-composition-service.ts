import { Context } from 'effect';

import type { ActiveApplicationCompositionServiceContract } from './active-application-composition.ts';

/** The active composition authority of this runtime; only `active-application-composition.ts` builds its value. */
export class ActiveApplicationCompositionService extends Context.Service<
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionServiceContract
>()('@app/core-runtime/modules/active-application-composition-service/ActiveApplicationCompositionService') {}
