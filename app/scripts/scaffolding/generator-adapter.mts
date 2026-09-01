import type { GeneratorContext, GeneratorCore } from '@modern-js/codesmith';
import { applyMutationPlan } from './shared.mts';
import type { ScaffoldPlan } from './shared.mts';

type ScaffoldPlanner<Config, Result> = (
  workspaceRoot: string,
  config: Config,
) => Promise<ScaffoldPlan<Result>>;

export const createCodesmithGenerator = <Config, Result>(
  planner: ScaffoldPlanner<Config, Result>,
) =>
  async function codesmithGenerator(
    context: GeneratorContext,
    core: GeneratorCore,
  ): Promise<Result> {
    // SAFETY: The CLI constructs config through a typed command `toConfig` function before Codesmith erases its type to `Record<string, any>`.
    return applyMutationPlan(core, await planner(core.outputPath, context.config as Config));
  };
