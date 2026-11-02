import type { OperationalScope, ScopedRoutineInvoker } from '@app/core-runtime';
import { OperationContextUnavailable } from '@app/core-runtime';
import { Effect } from 'effect';

import type { MarketRetirementIntentPersistence } from './market-retirement-intent-persistence.ts';
import { marketRetirementIntentPersistenceForInvoker } from './market-retirement-intent-persistence.ts';

/** Intent routines for a governed Action or read transaction, which must carry a trusted Legal Entity. */
export const marketRetirementIntentPersistenceForScope = (
  invoker: ScopedRoutineInvoker,
  scope: OperationalScope,
): Effect.Effect<MarketRetirementIntentPersistence, OperationContextUnavailable> =>
  scope.legalEntityId === undefined
    ? Effect.fail(
        new OperationContextUnavailable({
          code: 'operation_context_unavailable',
          reason: 'Market retirement requires a trusted Legal Entity scope',
        }),
      )
    : Effect.succeed(marketRetirementIntentPersistenceForInvoker(invoker));
