import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Layer, Match, Schema, Sink, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import type { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { OpsShellLive } from '../ops/ops-shell.mts';
import {
  StageMigrationContinuationError,
  validateStageMigrationContinuationMode,
  validateStageMigrationContinuationPaths,
  validateStageMigrationContinuationProvenance,
  verifyStageMigrationContinuation,
} from '../verify-stage-migration-continuation.mts';

const BASELINE = 'b6ec8b410dd292099721b7408e0f2285b1c740ed';
const CURRENT = 'f129cfbea0bc168362c90d156126707f0e856def';
const RETIRED = 'a'.repeat(64);
const REPOSITORY = 'TechsioCZ/ontos';
const MIGRATION_PATH = 'app/scripts/stage-demo-migrate.mts';
const expression = (value: string) => ['${{', value, '}}'].join(' ');
const RUN_PATH = 'repos/TechsioCZ/ontos/actions/runs/40252598522';
const PROVENANCE_STEP = 'Verify the completed migration incident and reviewed continuation source';
const CONTINUATION_STEP = 'Continue publication of the completed owner migration';
const MIGRATION_STEP = 'Migrate every owner schema';
// The pinned historical incident must keep its original successful milestone.
const POST_BOOTSTRAP_STEP = 'Bootstrap every database identity after migrations';
const POST_VERIFICATION_STEP = 'Verify every migrated owner schema';
const mode = {
  continueMigratedPublication: true,
  deploy: true,
  eventName: 'workflow_dispatch',
  outboxOnly: false,
  ref: 'refs/heads/demo/sales-crm',
  repository: REPOSITORY,
  retiredCompositionRevision: RETIRED,
  sourceRevision: CURRENT,
};
const run = {
  conclusion: 'failure',
  head_branch: 'demo/sales-crm',
  head_sha: BASELINE,
  id: 40_252_598_522,
  path: '.github/workflows/stage-demo-deploy.yml',
  repository: { full_name: REPOSITORY },
  run_attempt: 1,
  status: 'completed',
};
const migration = { conclusion: 'success', name: MIGRATION_STEP, number: 13, status: 'completed' };
const bootstrap = { conclusion: 'success', name: POST_BOOTSTRAP_STEP, number: 14, status: 'completed' };
const job = {
  conclusion: 'failure',
  head_sha: BASELINE,
  id: 121_349_570_392,
  name: 'Deploy, publish and activate stage',
  run_id: 40_252_598_522,
  status: 'completed',
  steps: [migration, bootstrap],
};
const encodeJobs = (jobs: readonly unknown[]) => JSON.stringify([{ jobs }]);

it.effect('accepts the exact incident milestones despite the later overall deployment failure', () =>
  Effect.gen(function* acceptsCompletedMigration() {
    yield* validateStageMigrationContinuationMode(mode);
    yield* validateStageMigrationContinuationProvenance(
      JSON.stringify(run),
      JSON.stringify([{ jobs: [] }, { jobs: [job] }]),
    );
    yield* validateStageMigrationContinuationPaths([
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
      MIGRATION_PATH,
      'app/scripts/application-composition-authority-publication.mts',
      'app/scripts/tests/stage-demo-migrate.test.mts',
      'app/scripts/tests/stage-demo-deploy-workflow.test.mts',
    ]);
  }),
);

it.effect('rejects other modes, branches, repositories, source shapes and retired revision shapes', () =>
  Effect.gen(function* rejectsInvalidContinuationMode() {
    const invalidModes = [
      { continueMigratedPublication: false },
      { deploy: false },
      { eventName: 'push' },
      { outboxOnly: true },
      { ref: 'refs/heads/main' },
      { repository: 'other/ontos' },
      { sourceRevision: 'HEAD' },
      ...['', `sha256:${RETIRED}`, 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), `${RETIRED}\n`, ` ${RETIRED}`].map(
        (retiredCompositionRevision) => ({ retiredCompositionRevision }),
      ),
    ];
    for (const patch of invalidModes) {
      const failure = yield* validateStageMigrationContinuationMode({ ...mode, ...patch }).pipe(Effect.flip);
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects every mismatched run provenance field and malformed evidence', () =>
  Effect.gen(function* rejectsForeignMigrationEvidence() {
    for (const patch of [
      { head_branch: 'main' },
      { head_sha: CURRENT },
      { id: 40_252_598_523 },
      { path: '.github/workflows/another-deploy.yml' },
      { repository: { full_name: 'other/ontos' } },
      { run_attempt: 2 },
      { status: 'in_progress' },
    ]) {
      const failure = yield* validateStageMigrationContinuationProvenance(
        JSON.stringify({ ...run, ...patch }),
        encodeJobs([job]),
      ).pipe(Effect.flip);
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
    }
    for (const [runJson, jobsJson] of [
      ['{', encodeJobs([job])],
      [JSON.stringify(run), '{}'],
    ]) {
      const failure = yield* validateStageMigrationContinuationProvenance(runJson, jobsJson).pipe(Effect.flip);
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
    }
  }),
);

it.effect('requires both successful ordered steps in the one pinned deploy job, not another job', () =>
  Effect.gen(function* rejectsIncompleteMigrationMilestones() {
    const invalidJobs = [
      [],
      [job, job],
      [{ ...job, name: 'Build shell-super-app' }],
      [{ ...job, id: 1 }],
      [{ ...job, run_id: 1 }],
      [{ ...job, head_sha: CURRENT }],
      [{ ...job, status: 'in_progress' }],
      [{ ...job, steps: [migration] }],
      [{ ...job, steps: [bootstrap] }],
      [{ ...job, steps: [migration, migration, bootstrap] }],
      [{ ...job, steps: [migration, { ...bootstrap, number: 12 }] }],
      [{ ...job, steps: [migration, { ...bootstrap, status: 'in_progress' }] }],
      [
        { ...job, steps: [] },
        { ...job, id: 2, name: 'A different job' },
      ],
      ...['failure', 'skipped', 'cancelled', null].flatMap((conclusion) => [
        [{ ...job, steps: [{ ...migration, conclusion }, bootstrap] }],
        [{ ...job, steps: [migration, { ...bootstrap, conclusion }] }],
      ]),
    ];
    for (const jobs of invalidJobs) {
      const failure = yield* validateStageMigrationContinuationProvenance(JSON.stringify(run), encodeJobs(jobs)).pipe(
        Effect.flip,
      );
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
    }
  }),
);

it.effect('rejects unreviewed paths including schema, SQL, owner migration, packages, lockfiles and manifests', () =>
  Effect.gen(function* rejectsUnreviewedTreeChanges() {
    for (const path of [
      'app/verticals/merchandise/src/db/schema.ts',
      'app/verticals/merchandise/drizzle/0001.sql',
      'app/verticals/merchandise/scripts/migrate.mts',
      'app/packages/core-runtime/src/db/schema.ts',
      'app/pnpm-lock.yaml',
      'app/package.json',
      'app/topology/application-release-intent.json',
      'app/scripts/tests/unreviewed.test.mts',
      'app/scripts/../packages/core-runtime/src/db/schema.ts',
      '',
    ]) {
      const failure = yield* validateStageMigrationContinuationPaths([MIGRATION_PATH, path]).pipe(Effect.flip);
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
    }
  }),
);

const processFixture = (
  options: {
    readonly changed?: string;
    readonly deploy?: boolean;
    readonly dirty?: string;
    readonly head?: string;
    readonly runJson?: string;
  } = {},
) => {
  const commands: ChildProcess.Command[] = [];
  const outputs = [
    `${options.head ?? CURRENT}\n`,
    options.dirty ?? '',
    options.runJson ?? JSON.stringify(run),
    encodeJobs([job]),
    '',
    options.changed ?? 'app/scripts/stage-demo-migrate.mts\0',
  ];
  const spawner = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        commands.push(command);
        const output = outputs.shift();
        if (output === undefined) {
          return expect.unreachable('The continuation guard issued an unexpected external command');
        }
        return ChildProcessSpawner.makeHandle({
          all: Stream.empty,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          pid: ChildProcessSpawner.ProcessId(1),
          stderr: Stream.empty,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(output)),
          unref: Effect.succeed(Effect.void),
        });
      }),
    ),
  );
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      CONTINUE_MIGRATED_PUBLICATION: 'true',
      DEPLOY: String(options.deploy ?? true),
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/demo/sales-crm',
      GITHUB_REPOSITORY: REPOSITORY,
      GITHUB_SHA: CURRENT,
      ONTOS_RETIRED_COMPOSITION_REVISION: RETIRED,
      OUTBOX_ONLY: 'false',
    }),
  );
  return { commands, layer: Layer.merge(config, OpsShellLive.pipe(Layer.provide(spawner))) };
};

it.effect(
  'fetches the pinned shallow baseline and compares every tree path through native processes and GET-only API reads',
  () =>
    Effect.gen(function* verifiesNativeSourceReadBoundary() {
      const fixture = processFixture();
      yield* verifyStageMigrationContinuation().pipe(Effect.provide(fixture.layer));
      const commands = fixture.commands.map((command) =>
        Match.value(command).pipe(
          Match.tag('StandardCommand', (value) => ({
            args: value.args,
            command: value.command,
            options: value.options,
          })),
          Match.tag('PipedCommand', () => expect.unreachable('The guard must not issue shell pipelines')),
          Match.exhaustive,
        ),
      );
      expect(commands.map(({ args, command }) => [command, ...args])).toEqual([
        ['git', 'rev-parse', 'HEAD'],
        ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
        ['gh', 'api', '--method', 'GET', RUN_PATH],
        ['gh', 'api', '--method', 'GET', `${RUN_PATH}/attempts/1/jobs?per_page=100`, '--paginate', '--slurp'],
        ['git', 'fetch', '--no-tags', '--depth=1', 'origin', BASELINE],
        ['git', 'diff', '--name-only', '--no-renames', '-z', BASELINE, 'HEAD', '--'],
      ]);
      for (const command of commands) {
        expect(command.options.stderr).toBe('pipe');
        expect(command.options.stdin).toBe('ignore');
        expect(command.options.env).toBeUndefined();
        expect(command.options.cwd).toBe(new URL('../../..', import.meta.url).pathname.replace(/\/$/u, ''));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('fails closed before external reads on invalid mode and before fetch on dirty source or bad provenance', () =>
  Effect.gen(function* stopsAtFailedSourceGate() {
    for (const [options, commandCount] of [
      [{ deploy: false }, 0],
      [{ head: BASELINE }, 1],
      [{ dirty: ' M app/package.json\n' }, 2],
      [{ runJson: '{}' }, 4],
      [{ changed: 'app/pnpm-lock.yaml\0' }, 6],
      [{ changed: MIGRATION_PATH }, 6],
    ] as const) {
      const fixture = processFixture(options);
      const failure = yield* verifyStageMigrationContinuation().pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(Schema.is(StageMigrationContinuationError)(failure)).toBe(true);
      expect(fixture.commands).toHaveLength(commandCount);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

const WorkflowStepSchema = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    release: Schema.Struct({
      concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
      permissions: Schema.Struct({ actions: Schema.Literal('read') }),
      steps: Schema.Array(WorkflowStepSchema),
    }),
    'release-script-tests': Schema.Struct({ steps: Schema.Array(WorkflowStepSchema) }),
  }),
  on: Schema.Struct({
    workflow_dispatch: Schema.Struct({
      inputs: Schema.Struct({
        continue_migrated_publication: Schema.Struct({ default: Schema.Boolean, type: Schema.Literal('boolean') }),
        retired_composition_revision: Schema.Struct({ default: Schema.String, type: Schema.Literal('string') }),
      }),
    }),
  }),
});

it.effect(
  'gates continuation before stage writes, replaces only migration preparation, and retains the full publication path',
  () =>
    Effect.gen(function* verifiesWorkflowReachability() {
      const fs = yield* FileSystem.FileSystem;
      const workflow = Schema.decodeUnknownSync(WorkflowSchema)(
        parse(
          yield* fs.readFileString(
            new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url).pathname,
          ),
        ),
      );
      expect(workflow.on.workflow_dispatch.inputs.continue_migrated_publication.default).toBe(false);
      expect(workflow.on.workflow_dispatch.inputs.retired_composition_revision.default).toBe('');
      const { concurrency, steps } = workflow.jobs.release;
      expect(concurrency).toEqual({ 'cancel-in-progress': false, group: 'zerops-stage' });
      const index = (name: string) => {
        const found = steps.findIndex((step) => step.name === name);
        expect(found).toBeGreaterThanOrEqual(0);
        return found;
      };
      const step = (name: string) => steps[index(name)];
      expect(step(PROVENANCE_STEP)?.if).toBe('inputs.continue_migrated_publication');
      expect(step(PROVENANCE_STEP)?.run).toBe(
        'mise exec -- pnpm exec node scripts/verify-stage-migration-continuation.mts',
      );
      expect(index(PROVENANCE_STEP)).toBeLessThan(index('Connect the runner to the private Zerops database network'));
      expect(step(PROVENANCE_STEP)?.env?.GH_TOKEN).toBe(expression('github.token'));
      expect(index(CONTINUATION_STEP)).toBeGreaterThan(index('Load the dedicated database identity credentials'));
      expect(index(CONTINUATION_STEP)).toBeLessThan(index(POST_VERIFICATION_STEP));
      const postVerification = Schema.decodeUnknownSync(
        Schema.Struct({
          env: Schema.Struct({
            COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: Schema.String,
            COMMERCE_PORTAL_AUTH_DATABASE_URL: Schema.String,
          }),
          run: Schema.String,
        }),
      )(step(POST_VERIFICATION_STEP));
      expect(postVerification).toEqual({
        env: {
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: expression('secrets.DATABASE_ADMIN_URL'),
          COMMERCE_PORTAL_AUTH_DATABASE_URL: expression('secrets.DATABASE_URL'),
        },
        run: [
          'BETTER_AUTH_SECRET="$(jq -er \'."shell-super-app".BETTER_AUTH_SECRET\' "$ALL_RELEASE_SECRETS_FILE")"',
          'echo "::add-mask::$BETTER_AUTH_SECRET"',
          'export BETTER_AUTH_SECRET',
          'mise exec -- pnpm exec node scripts/demo/reconcile-stage-service-grants.mts --zerops --apply --verify-database',
          '',
        ].join('\n'),
      });
      expect(step(CONTINUATION_STEP)?.if).toBe('inputs.continue_migrated_publication && !inputs.outbox_only');
      expect(step(CONTINUATION_STEP)?.run).toBe(
        'mise exec -- pnpm exec node scripts/stage-demo-migrate.mts --continue-publication',
      );
      expect(step(CONTINUATION_STEP)?.env?.ONTOS_RETIRED_COMPOSITION_REVISION).toBe(
        expression('inputs.retired_composition_revision'),
      );
      expect(index(POST_VERIFICATION_STEP)).toBeGreaterThan(index(CONTINUATION_STEP));
      for (const name of [
        'Upload every immutable release Worker',
        'Assemble the composition candidate',
        'Publish the Application Composition',
        'Activate the Shell ingress',
        'Deploy the AKROS storefront',
        'Smoke the Shell login and OAuth metadata',
      ]) {
        expect(step(name)?.if).toBe(expression('!inputs.outbox_only'));
        expect(index(name)).toBeGreaterThan(index(CONTINUATION_STEP));
      }
      // A continuation reconciles the grants inside the verification step, so the standalone step skips it.
      const reconcile = step('Reconcile storefront, Commerce and Privacy service grants');
      expect(reconcile?.if).toBe(
        expression(
          "inputs.outbox_only || (!inputs.continue_migrated_publication && steps.database-path.outputs.mode == 'full')",
        ),
      );
      // One --apply reads every grant, writes only what is missing and reads the result back.
      expect(reconcile?.run?.match(/--zerops --(?:check|apply|verify)/gu)).toEqual(['--zerops --apply']);
      for (const name of [PROVENANCE_STEP, CONTINUATION_STEP, POST_VERIFICATION_STEP]) {
        expect(step(name)?.['continue-on-error']).toBeUndefined();
      }
      expect(
        workflow.jobs['release-script-tests'].steps.find(({ run: command }) => command?.includes('rstest') === true)
          ?.run,
      ).toContain('scripts/tests/verify-stage-migration-continuation.test.mts');
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('keeps the identity bootstrap on both database paths and the sealed chain on the full path only', () =>
  Effect.gen(function* verifiesDatabasePathConditions() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(WorkflowSchema)(
      parse(
        yield* fs.readFileString(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url).pathname),
      ),
    );
    const step = (name: string) => workflow.jobs.release.steps.find((candidate) => candidate.name === name);
    // A fresh release always bootstraps the identities; only the full database path (not the live light path)
    // writes the cutover receipt and runs the sealed migration.
    expect(step('Bootstrap every database identity before migrations')?.if).toBe(
      expression('!inputs.outbox_only && !inputs.continue_migrated_publication'),
    );
    for (const name of ['Write the initial cutover receipt', MIGRATION_STEP]) {
      expect(step(name)?.if).toBe(
        expression(
          "!inputs.outbox_only && !inputs.continue_migrated_publication && steps.database-path.outputs.mode == 'full'",
        ),
      );
    }
    // The sealed migration ends with db:verify, so only a continuation or the light path verifies here.
    expect(step(POST_VERIFICATION_STEP)?.if).toBe(
      expression(
        "!inputs.outbox_only && (inputs.continue_migrated_publication || steps.database-path.outputs.mode == 'light')",
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
