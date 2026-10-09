import { Context } from 'effect';
import type { Effect } from 'effect';
import type {
  AvailabilityEvaluationInput,
  AvailabilityEvaluatedDecision,
  AvailabilityEvaluationInputRejected,
} from './availability-decision.ts';

export class AvailabilityCurrentnessEvaluator extends Context.Service<
  AvailabilityCurrentnessEvaluator,
  {
    readonly evaluate: (
      input: AvailabilityEvaluationInput,
    ) => Effect.Effect<AvailabilityEvaluatedDecision, AvailabilityEvaluationInputRejected>;
  }
>()('@app/availability/shared/domain/availability-currentness-evaluator-port/AvailabilityCurrentnessEvaluator') {}
