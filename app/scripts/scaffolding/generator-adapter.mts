import type { NodeServices } from '@effect/platform-node';
import type { GeneratorContext, GeneratorCore } from '@modern-js/codesmith';
import { Effect } from 'effect';

import { applyMutationPlanEffect } from './shared.mts';
import type { ScaffoldPlan } from './shared.mts';

type TypedGeneratorContext<Config> = Omit<GeneratorContext, 'config'> & {
  readonly config: Config;
};

type EffectScaffoldPlanner<Config, Result, PlannerError, Services> = (
  workspaceRoot: string,
  config: Config
) => Effect.Effect<ScaffoldPlan<Result>, PlannerError, Services>;

export const createCodesmithGenerator = <
  Config,
  Result,
  PlannerError,
  Services extends NodeServices.NodeServices,
>(
  planner: EffectScaffoldPlanner<Config, Result, PlannerError, Services>
) =>
  Effect.fn('planAndApplyScaffold')(function* planAndApplyScaffold(
    context: TypedGeneratorContext<Config>,
    core: GeneratorCore
  ) {
    const plan = yield* planner(core.outputPath, context.config);
    return yield* applyMutationPlanEffect(core, plan);
  });
