import type { NodeServices } from '@effect/platform-node';
import type { GeneratorContext, GeneratorCore } from '@modern-js/codesmith';
import { Effect, flow, Schema } from 'effect';
import { scaffoldingRuntime } from '../scaffolding-runtime.mts';
import { applyMutationPlanEffect } from './shared.mts';
import type { ScaffoldPlan } from './shared.mts';

type TypedGeneratorContext<Config> = Omit<GeneratorContext, 'config'> & {
  readonly config: Config;
};

type EffectScaffoldPlanner<Config, Result, PlannerError, Services> = (
  workspaceRoot: string,
  config: Config,
) => Effect.Effect<ScaffoldPlan<Result>, PlannerError, Services>;

type PromiseScaffoldPlanner<Config, Result> = (
  workspaceRoot: string,
  config: Config,
) => Promise<ScaffoldPlan<Result>>;

type CodesmithGenerator<Config, Result> = (
  context: TypedGeneratorContext<Config>,
  core: GeneratorCore,
) => Promise<Result>;

class GeneratorAdapterFailure extends Schema.TaggedError<GeneratorAdapterFailure>()(
  'GeneratorAdapterFailure',
  {
    cause: Schema.Unknown,
    message: Schema.String,
  },
) {}

export function createCodesmithGenerator<
  Config,
  Result,
  PlannerError,
  Services extends NodeServices.NodeServices,
>(
  planner: EffectScaffoldPlanner<Config, Result, PlannerError, Services>,
): CodesmithGenerator<Config, Result>;
export function createCodesmithGenerator<Config, Result>(
  planner: PromiseScaffoldPlanner<Config, Result>,
): CodesmithGenerator<Config, Result>;
export function createCodesmithGenerator<
  Config,
  Result,
  PlannerError,
  Services extends NodeServices.NodeServices,
>(
  planner:
    | EffectScaffoldPlanner<Config, Result, PlannerError, Services>
    | PromiseScaffoldPlanner<Config, Result>,
): CodesmithGenerator<Config, Result> {
  const codesmithGeneratorEffect = (context: TypedGeneratorContext<Config>, core: GeneratorCore) =>
    Effect.gen(function* planAndApplyScaffold() {
      const planned = planner(core.outputPath, context.config);
      const plan = Effect.isEffect(planned)
        ? yield* planned
        : yield* Effect.tryPromise({
            catch: (cause) =>
              new GeneratorAdapterFailure({ cause, message: 'The scaffold planner failed' }),
            try: async () => await planned,
          });
      return yield* applyMutationPlanEffect(core, plan);
    });
  return flow(codesmithGeneratorEffect, scaffoldingRuntime.runPromise);
}
