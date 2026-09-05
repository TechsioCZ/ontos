// expect-count: 3
import * as Types from 'effect/Types';

export type TopologyEntry =
  | Types.Simplify<{ readonly _tag: 'module'; readonly moduleId: string }>
  | Types.Simplify<{ readonly _tag: 'vertical'; readonly verticalId: string }>;

export interface RolloutContract {
  readonly _tag: 'RolloutContract' | 'RolloutContractDraft';
  readonly revision: number;
}
