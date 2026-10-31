import type { ActionServicePreparationContext } from '@app/core-runtime';
import { Effect } from 'effect';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import type { PurchaseValue } from '../../shared/domain/purchase-limit.ts';

/** The configured owner provider, not an Action or TEST flag, owns source-specific preparation. */
export const preparePurchaseLimitCurrentness = Effect.fn('PurchaseCurrentness.prepare')(function* prepare(
  context: ActionServicePreparationContext,
  source: Pick<PurchaseValue, 'sourceRef' | 'sourceRevision'>,
) {
  const provider = yield* PurchaseLimitEvaluationCurrentnessPort;
  if (provider.prepare === undefined) {
    return yield* Effect.fail(
      PurchaseLimitDependencyUnavailableSchema.make({
        code: 'purchase_limit_dependency_unavailable',
        dependency: 'PURCHASE_CURRENTNESS_PREPARATION',
        reason: 'The configured purchase source cannot prepare exact currentness outside the transaction',
      }),
    );
  }
  return yield* provider.prepare(context, source);
});
