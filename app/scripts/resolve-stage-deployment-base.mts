import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { FULL_PLAN_SEED_INSTRUCTION } from './plan-deployment-impact.mts';

/**
 * Resolves the comparison base for a stage deployment: the commit of the newest
 * `stage` deployment whose latest status is `success`, excluding the current
 * workflow run. Failed and cancelled deployments are skipped, so their changes stay
 * inside the next diff until one of them reaches stage.
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
  /** Latest status of a deployment, or none when it has no status yet. */
  readonly latestStatus: (deploymentId: number) => Effect.Effect<Option.Option<StageDeploymentStatus>, E, R>;
  /** Deployments of the environment, newest first; an empty page ends the walk. */
  readonly page: (page: number) => Effect.Effect<readonly StageDeployment[], E, R>;
}

export class StageDeploymentBaseError extends Schema.TaggedError<StageDeploymentBaseError>()(
  'StageDeploymentBaseError',
  { message: Schema.String },
) {}

export const resolveStageDeploymentBase = <E, R>(
  source: StageDeploymentSource<E, R>,
  options: { readonly currentRunId: string; readonly environment: string },
) =>
  Effect.gen(function* resolveStageDeploymentBaseEffect() {
    const currentRunPath = `/actions/runs/${options.currentRunId}/`;
    for (let page = 1; ; page += 1) {
      const deployments = yield* source.page(page);
      if (deployments.length === 0) {
        return yield* new StageDeploymentBaseError({
          message: `no successful "${options.environment}" deployment exists outside run ${options.currentRunId}; ${FULL_PLAN_SEED_INSTRUCTION}`,
        });
      }
      for (const deployment of deployments) {
        const status = yield* source.latestStatus(deployment.id);
        if (
          Option.isSome(status) &&
          status.value.state === 'success' &&
          !status.value.logUrl.includes(currentRunPath)
        ) {
          return deployment.sha;
        }
      }
    }
  });

const DEPLOYMENTS_PAGE_SIZE = 100;

const DeploymentsJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.Number, sha: Schema.String })),
);
const StatusesJsonSchema = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ log_url: Schema.optional(Schema.String), state: Schema.String })),
);

const githubApi = (endpoint: string) =>
  Effect.gen(function* githubApiEffect() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return yield* spawner.string(ChildProcess.make('gh', ['api', endpoint]));
  });

export const githubStageDeploymentSource = (
  repository: string,
  environment: string,
): StageDeploymentSource<unknown, ChildProcessSpawner.ChildProcessSpawner> => ({
  latestStatus: (deploymentId) =>
    githubApi(`repos/${repository}/deployments/${deploymentId}/statuses?per_page=1`).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(StatusesJsonSchema)),
      Effect.map(([latest]) =>
        Option.fromNullishOr(latest).pipe(
          Option.map((status) => ({ logUrl: status.log_url ?? '', state: status.state })),
        ),
      ),
    ),
  page: (page) =>
    githubApi(
      `repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=${DEPLOYMENTS_PAGE_SIZE}&page=${page}`,
    ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(DeploymentsJsonSchema))),
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
