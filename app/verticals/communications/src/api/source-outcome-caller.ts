import { ReadPermissionDenied } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { Effect, Option } from 'effect';

import { verifiedCallerModuleOf } from '../integrations/source-caller.ts';

/**
 * The source outcome Read answers a registered source workflow only, about its OWN requests: the module is the one Core verified
 * on the sealed workload scope of the source's own delivery, never a field of the request (see `source-caller.ts`). A call that
 * names no verified source module (a person holding the declaration, an admission that is not a worker delivery) is refused
 * before anything is read.
 */
export const requireSourceCaller = Effect.fn('Communications.requireSourceCaller')(function* requireSourceCaller(
  scope: OperationalScope,
) {
  const caller = verifiedCallerModuleOf(scope);
  if (Option.isNone(caller)) {
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason:
        'Only a registered source workflow, as the verified calling module, may ask for the outcome of its requests',
    });
  }
  return caller.value;
});
