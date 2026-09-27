import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { FULL_PLAN_SEED_INSTRUCTION } from './plan-deployment-impact.mts';

/**
 * Resolves the comparison base for a stage deployment: the commit of the newest
 * `stage` deployment that reached `success`, excluding the current workflow run.
 * The whole status history counts because GitHub marks earlier successful
 * deployments `inactive` once a newer one succeeds. Failed and cancelled
 * deployments never reach `success`, so their changes stay inside the next diff
 * until one of them reaches stage. A success without a workflow run in its log
 * URL cannot be proven foreign to the current run, so it never becomes the base.
 */

export interface StageDeployment {
  readonly id: number;
  readonly sha: string;
}

export interface StageDeploymentStatus {
  readonly logUrl: string;
  readonly state: string;
}

export interface StageDeploymentSource<E, R> {
  /** Deployments of the environment, newest first; an empty page ends the walk. */
  readonly page: (page: number) => Effect.Effect<readonly StageDeployment[], E, R>;
  /** Status history of a deployment, newest first. */
  readonly statuses: (deploymentId: number) => Effect.Effect<readonly StageDeploymentStatus[], E, R>;
}

export class StageDeploymentBaseError extends Schema.TaggedError<StageDeploymentBaseError>()(
  'StageDeploymentBaseError',
  { message: Schema.String },
) {}

const RUN_PATH_PATTERN = /\/actions\/runs\/(?<runId>\d+)(?:\/|$)/u;

/** Run id of a deployment status log URL, which may end at the run or continue into a job or attempt. */
const runIdOf = (logUrl: string) => RUN_PATH_PATTERN.exec(URL.parse(logUrl)?.pathname ?? '')?.groups?.runId;

export const resolveStageDeploymentBase = <E, R>(
  source: StageDeploymentSource<E, R>,
  options: { readonly currentRunId: string; readonly environment: string },
) =>
  Effect.gen(function* resolveStageDeploymentBaseEffect() {
    for (let page = 1; ; page += 1) {
      const deployments = yield* source.page(page);
      if (deployments.length === 0) {
        return yield* new StageDeploymentBaseError({
          message: `no successful "${options.environment}" deployment exists outside run ${options.currentRunId}; ${FULL_PLAN_SEED_INSTRUCTION}`,
        });
      }
      for (const deployment of deployments) {
        const statuses = yield* source.statuses(deployment.id);
        const success = statuses.find((status) => status.state === 'success');
        const runId = success === undefined ? undefined : runIdOf(success.logUrl);
        if (runId !== undefined && runId !== options.currentRunId) {
          return deployment.sha;
        }
      }
    }
  });

const DEPLOYMENTS_PAGE_SIZE = 100;
const STATUSES_PAGE_SIZE = 100;

const DeploymentsJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.Number, sha: Schema.String })),
);
/** Every page of the status history, as `gh api --paginate --slurp` wraps them. */
export const StatusPagesJsonSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Array(Schema.Struct({ log_url: Schema.OptionFromOptionalNullOr(Schema.String), state: Schema.String })),
  ),
);

const githubApi = (args: readonly string[]) =>
  Effect.gen(function* githubApiEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make('gh', ['api', ...args]));
  });

export const githubStageDeploymentSource = (
  repository: string,
  environment: string,
): StageDeploymentSource<unknown, ChildProcessSpawner.ChildProcessSpawner> => ({
  page: (page) =>
    githubApi([
      `repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOYMENTS_PAGE_SIZE}&page=${page}`,
    ]).pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeploymentsJsonSchema))),
  statuses: (deploymentId) =>
    githubApi([
      '--paginate',
      '--slurp',
      `repos/${repository}/deployments/${deploymentId}/statuses?per_page=${STATUSES_PAGE_SIZE}`,
    ]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StatusPagesJsonSchema)),
      Effect.map((pages) =>
        pages.flat().map((status) => ({ logUrl: Option.getOrUndefined(status.log_url) ?? '', state: status.state })),
      ),
    ),
});

const resolveStageDeploymentBaseCommand = Command.make(
  'resolve-stage-deployment-base',
  { environment: Flag.String('environment') },
  ({ environment }) =>
    Effect.gen(function* resolveStageDeploymentBaseCommandEffect() {
      const repository = yield* Config.String('GITHUB_REPOSITORY');
      const currentRunId = yield* Config.String('GITHUB_RUN_ID');
      const base = yield* resolveStageDeploymentBase(githubStageDeploymentSource(repository, environment), {
        currentRunId,
        environment,
      });
      yield* Console.log(base);
      const outputPath = yield* Config.option(Config.String('GITHUB_OUTPUT'));
      if (Option.isSome(outputPath)) {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.writeFileString(outputPath.value, `base=${base}\n`, { flag: 'a' });
      }
    }),
);

export const main = Command.run({ version: '1.0.0' })(resolveStageDeploymentBaseCommand);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(main).pipe(Layer.provide(NodeServices.layer))).pipe(Effect.scoped),
  );
}
