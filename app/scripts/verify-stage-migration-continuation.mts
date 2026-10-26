#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Config, Effect, Layer, Option, Path, Schema } from 'effect';

import { OpsShellLive, runCommand } from './ops/ops-shell.mts';

const incident = {
  branch: 'demo/sales-crm',
  deployJob: 'Deploy, publish and activate stage',
  deployJobId: 121_349_570_392,
  repository: 'TechsioCZ/ontos',
  runAttempt: 1,
  runId: 40_252_598_522,
  sourceRevision: 'b6ec8b410dd292099721b7408e0f2285b1c740ed',
  workflowPath: '.github/workflows/stage-demo-deploy.yml',
} as const;

// Only the reviewed commerce/operator fixes and the incident continuation may differ from the migrated tree.
const reviewedPaths = new Set([
  'app/akros-storefront/src/features/cart/cart-provider.tsx',
  'app/akros-storefront/src/features/checkout/checkout-provider.tsx',
  'app/akros-storefront/tests/component/ontos-checkout-provider.test.tsx',
  'app/verticals/merchandise/src/services/merchandise-store.ts',
  'app/verticals/merchandise/tests/integration/merchandise-store-postgres.test.ts',
  'app/apps/shell-super-app/scripts/bootstrap-stage-accounts.mts',
  'app/apps/shell-super-app/tests/integration/stage-accounts-bootstrap.test.ts',
  '.github/workflows/stage-demo-deploy.yml',
  'app/scripts/verify-stage-migration-continuation.mts',
  'app/scripts/tests/verify-stage-migration-continuation.test.mts',
  'app/scripts/stage-demo-migrate.mts',
  'app/scripts/application-composition-authority-publication.mts',
  'app/scripts/tests/stage-demo-migrate.test.mts',
  'app/scripts/tests/stage-demo-deploy-workflow.test.mts',
]);

export class StageMigrationContinuationError extends Schema.TaggedError<StageMigrationContinuationError>()(
  'StageMigrationContinuationError',
  { message: Schema.String },
) {}

const invalid = (message: string) => new StageMigrationContinuationError({ message });

export interface StageMigrationContinuationMode {
  readonly continueMigratedPublication: boolean;
  readonly deploy: boolean;
  readonly eventName: string;
  readonly outboxOnly: boolean;
  readonly ref: string;
  readonly repository: string;
  readonly retiredCompositionRevision: string;
  readonly sourceRevision: string;
}

export const validateStageMigrationContinuationMode = (mode: StageMigrationContinuationMode) =>
  Effect.gen(function* validateContinuationMode() {
    if (
      !mode.continueMigratedPublication ||
      mode.eventName !== 'workflow_dispatch' ||
      !mode.deploy ||
      mode.outboxOnly ||
      mode.repository !== incident.repository ||
      mode.ref !== `refs/heads/${incident.branch}`
    ) {
      return yield* invalid(
        'Migration continuation requires a full manual deployment of TechsioCZ/ontos demo/sales-crm',
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(mode.retiredCompositionRevision)) {
      return yield* invalid('The retired composition revision must be 64 lowercase hexadecimal digits');
    }
    if (!/^[a-f0-9]{40}$/u.test(mode.sourceRevision)) {
      return yield* invalid('The continuation source must be an exact Git commit');
    }
    return yield* Effect.void;
  });

const RunSchema = Schema.Struct({
  head_branch: Schema.Literal(incident.branch),
  head_sha: Schema.Literal(incident.sourceRevision),
  id: Schema.Literal(incident.runId),
  path: Schema.Literal(incident.workflowPath),
  repository: Schema.Struct({ full_name: Schema.Literal(incident.repository) }),
  run_attempt: Schema.Literal(incident.runAttempt),
  status: Schema.Literal('completed'),
});
const StepSchema = Schema.Struct({
  conclusion: Schema.OptionFromNullOr(Schema.String),
  name: Schema.String,
  number: Schema.Number,
  status: Schema.String,
});
const JobSchema = Schema.Struct({
  head_sha: Schema.String,
  id: Schema.Number,
  name: Schema.String,
  run_id: Schema.Number,
  status: Schema.String,
  steps: Schema.Array(StepSchema),
});
const JobPagesSchema = Schema.Array(Schema.Struct({ jobs: Schema.Array(JobSchema) }));

/** A failed overall job does not undo the two completed migration milestones. */
export const validateStageMigrationContinuationProvenance = (runJson: string, jobPagesJson: string) =>
  Effect.gen(function* validateContinuationProvenance() {
    yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunSchema))(runJson).pipe(
      Effect.mapError(() => invalid('The completed migration run does not match the pinned incident provenance')),
    );
    const pages = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JobPagesSchema))(jobPagesJson).pipe(
      Effect.mapError(() => invalid('The migration job evidence is malformed')),
    );
    const jobs = pages.flatMap((page) => page.jobs).filter((job) => job.name === incident.deployJob);
    const [job] = jobs;
    if (
      jobs.length !== 1 ||
      job === undefined ||
      job.id !== incident.deployJobId ||
      job.run_id !== incident.runId ||
      job.head_sha !== incident.sourceRevision ||
      job.status !== 'completed'
    ) {
      return yield* invalid('The pinned deploy job must be completed and unambiguous');
    }
    let previousStep = 0;
    for (const name of ['Migrate every owner schema', 'Bootstrap every database identity after migrations']) {
      const steps = job.steps.filter((step) => step.name === name);
      const [step] = steps;
      if (
        steps.length !== 1 ||
        step === undefined ||
        step.status !== 'completed' ||
        !Option.contains('success')(step.conclusion) ||
        !Number.isSafeInteger(step.number) ||
        step.number <= previousStep
      ) {
        return yield* invalid(`The pinned deploy job must prove successful ${name}`);
      }
      previousStep = step.number;
    }
    return yield* Effect.void;
  });

export const validateStageMigrationContinuationPaths = (changedPaths: readonly string[]) =>
  Effect.gen(function* validateContinuationPaths() {
    if (changedPaths.some((path) => !reviewedPaths.has(path))) {
      return yield* invalid('The continuation tree contains changes outside the exact reviewed incident paths');
    }
    return yield* Effect.void;
  });

/** All external reads cross the native process seam; GitHub credentials stay in the inherited environment. */
export const verifyStageMigrationContinuation = Effect.fn('StageDemo.verifyMigrationContinuation')(
  function* verifyStageMigrationContinuation() {
    const mode = yield* Config.all({
      continueMigratedPublication: Config.Boolean('CONTINUE_MIGRATED_PUBLICATION'),
      deploy: Config.Boolean('DEPLOY'),
      eventName: Config.String('GITHUB_EVENT_NAME'),
      outboxOnly: Config.Boolean('OUTBOX_ONLY'),
      ref: Config.String('GITHUB_REF'),
      repository: Config.String('GITHUB_REPOSITORY'),
      retiredCompositionRevision: Config.String('ONTOS_RETIRED_COMPOSITION_REVISION'),
      sourceRevision: Config.String('GITHUB_SHA'),
    });
    yield* validateStageMigrationContinuationMode(mode);
    const path = yield* Path.Path;
    const cwd = path.resolve(import.meta.dirname, '../..');
    const git = (args: readonly string[]) => runCommand({ args, captureProviderFailure: true, command: 'git', cwd });
    const api = (endpoint: string, pagination: readonly string[] = []) =>
      runCommand({
        args: ['api', '--method', 'GET', endpoint, ...pagination],
        captureProviderFailure: true,
        command: 'gh',
        cwd,
      });
    const head = yield* git(['rev-parse', 'HEAD']);
    if (head.trim() !== mode.sourceRevision) {
      return yield* invalid('The checkout does not match the dispatch source revision');
    }
    const dirty = yield* git(['status', '--porcelain=v1', '--untracked-files=all']);
    if (dirty !== '') {
      return yield* invalid('Migration continuation requires a clean checkout');
    }
    const runPath = `repos/${incident.repository}/actions/runs/${String(incident.runId)}`;
    const run = yield* api(runPath);
    const jobs = yield* api(`${runPath}/attempts/${String(incident.runAttempt)}/jobs?per_page=100`, [
      '--paginate',
      '--slurp',
    ]);
    yield* validateStageMigrationContinuationProvenance(run, jobs);
    // Checkout is shallow: fetch the exact migrated commit, never a moving branch or merge base.
    yield* git(['fetch', '--no-tags', '--depth=1', 'origin', incident.sourceRevision]);
    const changed = yield* git(['diff', '--name-only', '--no-renames', '-z', incident.sourceRevision, 'HEAD', '--']);
    if (changed !== '' && !changed.endsWith('\0')) {
      return yield* invalid('The continuation tree comparison is malformed');
    }
    return yield* validateStageMigrationContinuationPaths(changed === '' ? [] : changed.slice(0, -1).split('\0'));
  },
);

if (import.meta.main) {
  NodeRuntime.runMain(
    verifyStageMigrationContinuation().pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}
