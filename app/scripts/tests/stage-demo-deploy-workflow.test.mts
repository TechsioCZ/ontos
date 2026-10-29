import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import {
  Array as EffectArray,
  Config,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Order,
  Redacted,
  Schema,
} from 'effect';
import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
import { STOREFRONT_ENV_KEYS } from '../ci/deploy-plan.mts';
import { emptyLedger, parseLedger, serializeLedger } from '../ci/release-ledger.mts';
import { HOST_BUILD_JOB, STOREFRONT_BUILD_JOB } from '../ci/release-stream.mts';
import { sharedBuildSourceDigest } from '../demo/shared-build-source-digest.mts';
import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import { gatewayPublicJwksFor, workerSecretPlan } from '../ops/cloudflare-stage-cutover.mts';
import { readEdgeUnits } from '../ops/stage-edge-units.mts';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const StepSchema = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  'timeout-minutes': Schema.optionalKey(Schema.Number),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(
    Schema.Struct({
      'if-no-files-found': Schema.optionalKey(Schema.String),
      'install-args': Schema.optionalKey(Schema.String),
      key: Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      overwrite: Schema.optionalKey(Schema.Boolean),
      path: Schema.optionalKey(Schema.String),
      'restore-typescript-build': Schema.optionalKey(Schema.String),
      'retention-days': Schema.optionalKey(Schema.Number),
      'save-store': Schema.optionalKey(Schema.String),
      'typescript-build-unit': Schema.optionalKey(Schema.String),
    }),
  ),
  'working-directory': Schema.optionalKey(Schema.String),
});
const EnvironmentSchema = Schema.Struct({ deployment: Schema.Boolean, name: Schema.String });
const JobSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  environment: Schema.optionalKey(Schema.Union([EnvironmentSchema, Schema.String])),
  if: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  outputs: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  steps: Schema.Array(StepSchema),
  strategy: Schema.optionalKey(
    Schema.Struct({
      'fail-fast': Schema.Boolean,
      matrix: Schema.Record(Schema.String, Schema.String),
      'max-parallel': Schema.Number,
    }),
  ),
  'timeout-minutes': Schema.Number,
});
const WorkflowSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  jobs: Schema.Struct({
    build: JobSchema,
    'build-outbox-host': JobSchema,
    'build-storefront': JobSchema,
    plan: JobSchema,
    'profile-recovery': Schema.Struct({ if: Schema.String, steps: Schema.Array(StepSchema) }),
    'prune-workers': JobSchema,
    release: JobSchema,
    'release-script-tests': Schema.Struct({
      environment: EnvironmentSchema,
      if: Schema.String,
      needs: Schema.optionalKey(Schema.Array(Schema.String)),
      steps: Schema.Array(StepSchema),
    }),
    verify: Schema.Struct({
      needs: Schema.Array(Schema.String),
      steps: Schema.Array(StepSchema),
      'timeout-minutes': Schema.Number,
    }),
  }),
});
const STAGE_DEMO_WORKFLOW = new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url);
const readWorkflow = () => Schema.decodeUnknownSync(WorkflowSchema)(parse(readFileSync(STAGE_DEMO_WORKFLOW, 'utf-8')));
const readJobs = () => readWorkflow().jobs;
const SHELL_INGRESS = 'Activate the Shell ingress';
const fullPublicationCondition = ['${{', '!inputs.outbox_only', '}}'].join(' ');

it('runs the native rental rebrand only after Shell activation and gates it on its own tests', () => {
  const { release, 'release-script-tests': tests } = readJobs();
  const rebrandName = 'Rebrand the rental demo through the native Shell Action';
  const position = release.steps.findIndex((step) => step.name === rebrandName);
  const step = release.steps[position];
  expect(position).toBeGreaterThan(release.steps.findIndex(({ name }) => name === SHELL_INGRESS));
  expect(position).toBeLessThan(
    release.steps.findIndex(({ name }) => name === 'Smoke the Shell login and OAuth metadata'),
  );
  expect(step?.if).toBe(fullPublicationCondition);
  expect(step?.['working-directory']).toBe('app');
  expect(step?.['timeout-minutes']).toBe(5);
  expect(step?.['continue-on-error']).toBeUndefined();
  expect(step?.run).toBe(
    `mise exec -- pnpm demo:rebrand:rental --apply --shell-url "$STAGE_SHELL_URL" --idempotency-key "\${GITHUB_SHA}-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}-najempark-v1"`,
  );
  expect(tests.steps.find(({ run }) => run?.includes('rstest') === true)?.run).toContain(
    'scripts/tests/rebrand-rental-demo.test.mts',
  );
});

it.effect('the actual outbox materialization step writes only the native host setup and exports its path', () =>
  Effect.scoped(
    Effect.gen(function* materializesWorkflowOutbox() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-outbox-materialization-' });
      const output = `${directory}/zerops.outbox.yaml`;
      const githubEnv = `${directory}/github-env`;
      const step = readJobs().release.steps.find(
        ({ name }) => name === 'Materialize the stage outbox host zerops.yaml',
      );
      expect(step?.['working-directory']).toBe('app');
      expect(step?.env?.ZEROPS_YAML_PATH).toBe(['${{', 'runner.temp', '}}/zerops.outbox.yaml'].join(' '));
      expect(step?.run).toContain('--setup outbox-worker-host');
      expect(step?.run).not.toMatch(/\b(?:awk|grep)\b/u);
      yield* runCommand({
        args: ['-euo', 'pipefail', '-c', step?.run ?? 'exit 1'],
        command: 'bash',
        cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
        env: {
          GITHUB_ENV: Redacted.make(githubEnv),
          RUNNER_TEMP: Redacted.make(directory),
          ZEROPS_YAML_PATH: Redacted.make(output),
        },
      });
      const text = yield* fs.readFileString(output);
      const source = Schema.decodeUnknownSync(
        Schema.Struct({ zerops: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
      )(parse(readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8')));
      expect(parse(text)).toEqual({
        zerops: [source.zerops.find((item) => item.setup === 'outbox-worker-host')],
      });
      expect(new TextEncoder().encode(text).byteLength).toBeLessThan(50_000);
      expect(yield* fs.readFileString(githubEnv)).toBe(`ZEROPS_YAML_PATH=${output}\n`);
    }),
  ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

const localBootstrapScript = new URL('../demo/up.sh', import.meta.url);
const MIGRATE = 'Migrate every owner schema';
const POST_MIGRATION_BOOTSTRAP = 'Verify every migrated owner schema';
const READINESS = 'Inspect migration readiness before database preparation';
const INITIAL_BOOTSTRAP = 'Bootstrap every database identity before migrations';
const RECOVERY_CONFIG_CHECK = 'Validate canonical enrollment recovery host configuration';
const RECOVERY_CONFIG_APPLY = 'Provision canonical enrollment recovery host configuration';
const PREPARE_SECRETS = 'Prepare the runner-only immutable release secret bundle';
const CLEANUP_SECRETS = 'Remove the runner-only immutable release secret bundle';
const preparedFileReference = ['${{', 'steps.release-secrets.outputs.path', '}}'].join(' ');
const rawFileReference = ['${{', 'steps.release-secrets.outputs.raw-path', '}}'].join(' ');
const loadPreparedSecrets = [
  'ALL_RELEASE_SECRETS="$(cat -- "$ALL_RELEASE_SECRETS_FILE")"',
  'export ALL_RELEASE_SECRETS',
];
const RELEASE_SECRET_CHECK = 'Validate the complete immutable release secret inventory';
const SERVICE_GRANTS = 'Reconcile storefront, Commerce and Privacy service grants';
const STREAM_START = 'Start the unit upload stream';
const IMMUTABLE_UPLOAD = 'Upload every immutable release Worker';
const UPLOAD_JOIN = 'Wait for every unit upload';
const PUBLICATION = 'Publish the Application Composition';
const RECOMPUTE_PLAN = 'Recompute the deploy plan at the clean checkout';
const OUTBOX_PLAN = 'Plan the outbox host of the published revision';
const DATABASE_PATH = 'Decide the database preparation path';
const DATABASE_RECORD = 'Record the prepared database fingerprint';
const INSTALL_APP_STEP = 'Install the app workspace';
const UNIT_BUILD_STEP = 'Build and verify the unit for Cloudflare';
const RELEASE_TESTS_BARRIER = 'Wait for the release script tests';
const WORKER_GUARD = 'Keep the account under its Worker limit';
const HOST_DEPLOY_START = 'Start the outbox worker host deploy';
const HOST_DEPLOY_JOIN = 'Push the outbox worker host';
const HOST_ADMISSION = 'Require the new host to admit the published composition';
const CONTINUE_PUBLICATION = 'Continue publication of the completed owner migration';
const UPLOAD_ARTIFACT = 'actions/upload-artifact@';
const INSTALL_APP = './.github/actions/install-app';
const LEDGER_UNITS = 'Record the uploaded units in the release ledger';
const HOST_FETCH = 'Fetch the outbox host build output';
const STOREFRONT_FETCH = 'Fetch the storefront build output';
const HOST_MATERIALIZE = 'Materialize the stage outbox host zerops.yaml';
const HOST_RELEASE = 'Name the outbox host release';
const STOP_UPLOADS = 'Stop the unit uploads after a failed release step';
const STOREFRONT_DEPLOY = 'Deploy the AKROS storefront';
const CANDIDATE = 'Assemble the composition candidate';
const workflowExpression = (body: string) => ['${{', body, '}}'].join(' ');
const freshMigrationCondition = ['${{', '!inputs.outbox_only && !inputs.continue_migrated_publication', '}}'].join(' ');
const fullDatabaseCondition = [
  '${{',
  "!inputs.outbox_only && !inputs.continue_migrated_publication && steps.database-path.outputs.mode == 'full'",
  '}}',
].join(' ');
const ownerVerifyCondition = [
  '${{',
  "!inputs.outbox_only && (inputs.continue_migrated_publication || steps.database-path.outputs.mode == 'light')",
  '}}',
].join(' ');
const ORIGINAL_SHARED_SOURCE = 'export const value = 1;';
const secretReference = (name: string) => ['${{', `secrets.${name}`, '}}'].join(' ');
const indexOf = (steps: readonly { readonly name: string }[], name: string) =>
  steps.findIndex((step) => step.name === name);
const TEST_STAGE_URL = 'https://stage.example.test';
const TEST_STAGE_ZONE = 'example.test';
const RUNNER_TEMP_CONTEXT = 'runner.temp';
const SECRET_CLEANUP_CONDITION = "always() && steps.release-secrets.outputs.directory != ''";
const OUTBOX_ONLY_SUCCESS = 'outbox-only-success';
const EARLY_SECRET_CHECK = 'Check release secret bindings before deployment builds';

it('checks the protected release secret inventory without creating a deployment or retaining a bundle', () => {
  const jobs = readJobs();
  const checks = jobs['release-script-tests'];
  expect(checks.environment).toEqual({ deployment: false, name: 'stage-edge' });
  // The tests start with the plan; builds never wait for them, the release does (barrier B1).
  expect(checks.needs).toBeUndefined();
  expect(checks.if).toBe(jobs.plan.if);
  expect(jobs.build.needs).toEqual(['plan']);
  expect(jobs['build-storefront'].needs).toEqual(['plan']);
  const preflight = checks.steps.find(({ name }) => name === EARLY_SECRET_CHECK);
  const testsIndex = checks.steps.findIndex(({ run }) => run?.includes('rstest') === true);
  expect(testsIndex).toBeGreaterThan(-1);
  expect(indexOf(checks.steps, EARLY_SECRET_CHECK)).toBeGreaterThan(testsIndex);
  expect(preflight?.if).toBe("github.event_name == 'push' || inputs.deploy");
  expect(preflight?.env).toEqual({ ALL_RELEASE_SECRETS: secretReference('DEMO_IMMUTABLE_RELEASE_SECRETS') });
  expect(preflight?.['continue-on-error']).toBeUndefined();
  expect(preflight?.run).toContain('umask 077');
  expect(preflight?.run).toContain('trap cleanup EXIT');
  expect(preflight?.run).toContain("trap 'exit 143' TERM");
  expect(preflight?.run).toContain('prepare-stage-release-secrets.mts --output-file "$directory/bundle.json"');
  expect(preflight?.run).toContain('rm -f -- "$directory/bundle.json"');
  expect(preflight?.run).toContain('rmdir -- "$directory"');
  expect(preflight?.run).not.toContain('GITHUB_OUTPUT');
  expect(checks.steps.filter(({ env }) => env?.ALL_RELEASE_SECRETS !== undefined)).toEqual([preflight]);
  expect(checks.steps.some(({ uses }) => uses?.startsWith(UPLOAD_ARTIFACT) === true)).toBe(false);
});

// Deliberately bounded to the conditions used by the producer and its file consumers.
// An unfamiliar condition fails this test model instead of being treated as unreachable.
const secretStepRuns = (condition: string | undefined, outboxOnly: boolean, precedingSuccess: boolean) => {
  const expression = condition?.replace('${{', '').replace('}}', '').trim() ?? 'success()';
  if (expression === '!inputs.outbox_only') {
    return precedingSuccess && !outboxOnly;
  }
  if (expression === 'inputs.outbox_only') {
    return precedingSuccess && outboxOnly;
  }
  if (expression === 'always()') {
    return true;
  }
  expect(expression).toBe('success()');
  return precedingSuccess;
};
/** Every step reading the prepared bundle or the raw stored copy that unit digests fingerprint. */
const readsSecretFile = ({ env }: typeof StepSchema.Type) =>
  env?.ALL_RELEASE_SECRETS_FILE !== undefined ||
  env?.RAW_RELEASE_SECRETS_FILE !== undefined ||
  env?.PREPARED_SECRETS_FILE !== undefined;
const secretFileSafetyViolations = (steps: readonly (typeof StepSchema.Type)[]) => {
  const violations: string[] = [];
  const producer = steps.find(({ name }) => name === PREPARE_SECRETS);
  const producerIndex = indexOf(steps, PREPARE_SECRETS);
  for (const outboxOnly of [false, true]) {
    for (const producerSucceeds of [false, true]) {
      const producerRuns = producer !== undefined && secretStepRuns(producer.if, outboxOnly, true);
      const fileAvailable = producerRuns && producerSucceeds;
      const precedingSuccess = !producerRuns || producerSucceeds || producer?.['continue-on-error'] === true;
      for (const consumer of steps.filter(readsSecretFile)) {
        if (
          secretStepRuns(consumer.if, outboxOnly, precedingSuccess) &&
          (!fileAvailable || producerIndex >= indexOf(steps, consumer.name))
        ) {
          violations.push(consumer.name);
        }
      }
    }
  }
  if (steps.find(({ name }) => name === CLEANUP_SECRETS)?.if !== SECRET_CLEANUP_CONDITION) {
    violations.push(CLEANUP_SECRETS);
  }
  return [...new Set(violations)];
};

it('makes every file consumer unreachable unless its producer has run successfully, including outbox-only', () => {
  const { steps } = readJobs().release;
  expect(secretFileSafetyViolations(steps)).toEqual([]);
  const original = steps.find(({ name }) => name === PREPARE_SECRETS);
  expect(original?.if).toBeUndefined();
  expect(original?.['continue-on-error']).toBeUndefined();
  // A full-only producer is the exact regression: the always-running native recovery steps
  // would read an undefined path during an exact-revision outbox-only retry.
  const fullOnlyProducer = steps.map((step) =>
    step.name === PREPARE_SECRETS ? { ...step, if: fullPublicationCondition } : step,
  );
  expect(secretFileSafetyViolations(fullOnlyProducer)).toEqual(
    expect.arrayContaining([RECOVERY_CONFIG_CHECK, RECOVERY_CONFIG_APPLY, SERVICE_GRANTS]),
  );
});

it('rejects fail-open producer/consumer guards, late producers, and success-only cleanup', () => {
  const { steps } = readJobs().release;
  const ignoredProducerFailure = steps.map((step) =>
    step.name === PREPARE_SECRETS ? { ...step, 'continue-on-error': true } : step,
  );
  expect(secretFileSafetyViolations(ignoredProducerFailure)).toContain(RECOVERY_CONFIG_CHECK);
  const unguardedConsumer = steps.map((step) =>
    step.name === RECOVERY_CONFIG_CHECK ? { ...step, if: 'always()' } : step,
  );
  expect(secretFileSafetyViolations(unguardedConsumer)).toContain(RECOVERY_CONFIG_CHECK);
  const lateProducer = [
    ...steps.filter(({ name }) => name !== PREPARE_SECRETS),
    ...steps.filter(({ name }) => name === PREPARE_SECRETS),
  ];
  expect(secretFileSafetyViolations(lateProducer)).toContain(RECOVERY_CONFIG_CHECK);
  const successOnlyCleanup = steps.map((step) =>
    step.name === CLEANUP_SECRETS ? { ...step, if: SECRET_CLEANUP_CONDITION.replace('always()', 'success()') } : step,
  );
  expect(secretFileSafetyViolations(successOnlyCleanup)).toContain(CLEANUP_SECRETS);
});

it('keeps isolated profile recovery on its original bundle without the release producer or file consumers', () => {
  const job = readJobs()['profile-recovery'];
  const command = job.steps.find(({ name }) => name === 'Run only the exact admitted profile recovery');
  expect(job.if).toContain("inputs.profile_recovery_mode != 'none'");
  expect(command?.env?.ALL_RELEASE_SECRETS).toBe(secretReference('DEMO_IMMUTABLE_RELEASE_SECRETS'));
  expect(job.steps.some(({ env }) => env?.ALL_RELEASE_SECRETS_FILE !== undefined)).toBe(false);
  expect(indexOf(job.steps, PREPARE_SECRETS)).toBe(-1);
  expect(indexOf(job.steps, CLEANUP_SECRETS)).toBe(-1);
});

const PROFILE_TRANSITION = 'ensure-retail-customer-profile';
const DIRECTORY_TRANSITION = 'party-customer-enroll';
it('routes each reviewed recovery transition to its own operator command and tests both before stage access', () => {
  const RecoveryInputsSchema = Schema.Struct({
    on: Schema.Struct({
      workflow_dispatch: Schema.Struct({
        inputs: Schema.Struct({
          profile_recovery_transition: Schema.Struct({
            default: Schema.String,
            options: Schema.Array(Schema.String),
            type: Schema.String,
          }),
        }),
      }),
    }),
  });
  const { on } = Schema.decodeUnknownSync(RecoveryInputsSchema)(parse(readFileSync(STAGE_DEMO_WORKFLOW, 'utf-8')));
  expect(on.workflow_dispatch.inputs.profile_recovery_transition).toEqual({
    default: PROFILE_TRANSITION,
    options: [PROFILE_TRANSITION, DIRECTORY_TRANSITION],
    type: 'choice',
  });
  const { steps } = readJobs()['profile-recovery'];
  const transition = ['${{', 'inputs.profile_recovery_transition', '}}'].join(' ');
  const gate = steps.find(({ name }) => name === 'Require an isolated manual operator request on demo');
  const command = steps.find(({ name }) => name === 'Run only the exact admitted profile recovery');
  const tests = steps.find(({ name }) => name === 'Test the bounded operator command before stage access');
  expect(gate?.env?.RECOVERY_TRANSITION).toBe(transition);
  expect(gate?.run).toContain(`"$RECOVERY_TRANSITION" != ${DIRECTORY_TRANSITION}`);
  expect(command?.env?.RECOVERY_TRANSITION).toBe(transition);
  const branches = command?.run?.split('case "$RECOVERY_TRANSITION" in')[1]?.split('esac')[0] ?? '';
  const scriptFor = (label: string) =>
    branches
      .split(';;')
      .find((branch) => branch.trim().startsWith(`${label})`))
      ?.match(/recover-admitted-[a-z-]+\.mts/u)?.[0];
  expect(scriptFor(PROFILE_TRANSITION)).toBe('recover-admitted-retail-profile.mts');
  expect(scriptFor(DIRECTORY_TRANSITION)).toBe('recover-admitted-customer-directory.mts');
  expect(branches).toContain("*)\n    echo '::error::Unsupported profile recovery transition' >&2\n    exit 1");
  expect(tests?.run).toContain('scripts/tests/recover-admitted-customer-directory.test.mts');
  expect(
    readJobs()['release-script-tests'].steps.some(
      ({ run }) => run?.includes('scripts/tests/recover-admitted-customer-directory.test.mts') === true,
    ),
  ).toBe(true);
});

it('keeps the original bundle only in preparation and gives every later release consumer the same private file', () => {
  expect(readWorkflow().env.STAGE_ZONE).toBe('bleeding.dev');
  expect(readWorkflow().env.STAGE_SHELL_URL).toBe('https://ontos-stage.bleeding.dev');
  const { steps } = readJobs().release;
  const prepare = steps.find(({ name }) => name === PREPARE_SECRETS);
  const cleanup = steps.find(({ name }) => name === CLEANUP_SECRETS);
  expect(prepare?.id).toBe('release-secrets');
  expect(prepare?.if).toBeUndefined();
  expect(prepare?.env).toEqual({ ALL_RELEASE_SECRETS: secretReference('DEMO_IMMUTABLE_RELEASE_SECRETS') });
  expect(prepare?.run).toContain('umask 077');
  expect(prepare?.run).toContain('trap cleanup EXIT');
  expect(prepare?.run).toContain("trap 'exit 143' TERM");
  expect(indexOf(steps, PREPARE_SECRETS)).toBeLessThan(indexOf(steps, RELEASE_SECRET_CHECK));
  const consumers = steps.filter(readsSecretFile);
  expect(consumers.map(({ name }) => name)).toEqual([
    RELEASE_SECRET_CHECK,
    RECOMPUTE_PLAN,
    OUTBOX_PLAN,
    RECOVERY_CONFIG_CHECK,
    STREAM_START,
    SERVICE_GRANTS,
    RECOVERY_CONFIG_APPLY,
    SHELL_INGRESS,
  ]);
  // The planner fingerprints the raw stored secrets (before Projects is derived), exactly as the plan job did; the
  // Shell ingress recomputes a kept Shell's digest that way too.
  const rawReaders = new Set([RECOMPUTE_PLAN, OUTBOX_PLAN, SHELL_INGRESS]);
  for (const step of consumers) {
    expect(step.env?.ALL_RELEASE_SECRETS_FILE).toBe(
      rawReaders.has(step.name) ? rawFileReference : preparedFileReference,
    );
    expect(step.env?.ALL_RELEASE_SECRETS).toBeUndefined();
    expect(step.run).toMatch(
      /ALL_RELEASE_SECRETS_FILE|PREPARED_SECRETS_FILE|scripts\/ci\/deploy-plan\.mts|release-stream\.mts stream/u,
    );
    expect(indexOf(steps, step.name)).toBeGreaterThan(indexOf(steps, PREPARE_SECRETS));
  }
  const upload = steps.find(({ name }) => name === STREAM_START);
  expect(upload?.env?.RAW_RELEASE_SECRETS_FILE).toBe(rawFileReference);
  expect(steps.filter(({ env }) => env?.RAW_RELEASE_SECRETS_FILE !== undefined)).toEqual([upload]);
  expect(steps.filter(({ env }) => env?.ALL_RELEASE_SECRETS !== undefined)).toEqual([prepare]);
  expect(cleanup?.if).toBe(SECRET_CLEANUP_CONDITION);
  expect(indexOf(steps, CLEANUP_SECRETS)).toBe(steps.length - 1);
  for (const step of steps.filter(({ uses }) => uses?.startsWith(UPLOAD_ARTIFACT) === true)) {
    expect(step.with?.path).not.toContain('stage-release-secrets');
    expect(step.with?.path).not.toContain('steps.release-secrets.outputs');
    expect(step.with?.path).not.toBe(['${{', RUNNER_TEMP_CONTEXT, '}}'].join(' '));
  }
});

it('gives the Shell ingress its prepared owner secrets and the inputs.json that proves a kept Shell unchanged', () => {
  const { steps } = readJobs().release;
  const ingress = steps.find(({ name }) => name === SHELL_INGRESS);
  expect(ingress?.env?.PREPARED_SECRETS_FILE).toBe(preparedFileReference);
  expect(ingress?.env?.ALL_RELEASE_SECRETS_FILE).toBe(rawFileReference);
  expect(ingress?.run).toContain(`'.["shell-super-app"] | select(type == "object")' "$PREPARED_SECRETS_FILE"`);
  expect(ingress?.run).toContain('--inputs-file .codex/reports/releases/shell-super-app/inputs.json');
  expect(steps.filter(({ env }) => env?.PREPARED_SECRETS_FILE !== undefined)).toEqual([ingress]);
});

const runnerBundleFixture = Effect.gen(function* validRunnerBundleFixture() {
  const units = yield* readEdgeUnits;
  const key = JSON.stringify({
    ...generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' }),
    alg: 'EdDSA',
    kid: 'runner-test-key',
    use: 'sig',
  });
  const secret = Redacted.make('synthetic-runner-shared-service-secret');
  const plan = workerSecretPlan(
    units,
    { shellHostname: 'stage.example.test', stageZone: TEST_STAGE_ZONE },
    {
      betterAuthSecret: secret,
      commerceCustomerContextGatewayApiKey: secret,
      commerceMarketCatalogGatewayApiKey: secret,
      crmPartyIntakeApiKey: secret,
      gatewayPrivateJwk: Redacted.make(key),
      gatewayPublicJwks: yield* gatewayPublicJwksFor(Redacted.make(key)),
      pricingGatewayApiKey: secret,
      spicedbPresharedKey: secret,
    },
  );
  const owners = Object.fromEntries(
    units
      .filter(({ id }) => id !== 'projects')
      .map((unit) => [
        unit.id,
        Object.fromEntries(
          Object.entries(plan.get(unit.workerName) ?? {}).map(([name, value]) => [name, Redacted.value(value)]),
        ),
      ]),
  );
  return { encoded: JSON.stringify(owners), key };
});

const verifyNativeRecoveryFileLoaders = (steps: readonly (typeof StepSchema.Type)[], file: string) =>
  Effect.forEach([RECOVERY_CONFIG_CHECK, RECOVERY_CONFIG_APPLY], (name) => {
    const prefix = steps.find((step) => step.name === name)?.run?.split('mise exec --')[0];
    // Execute only the exact loader, never the native command or a new unreviewed shell prefix.
    expect(prefix?.trim()).toBe(loadPreparedSecrets.join('\n'));
    return runCommand({
      args: [
        '-euo',
        'pipefail',
        '-c',
        `${prefix}\njq -e 'has("projects") and (.projects | length == 5)' <<<"$ALL_RELEASE_SECRETS" >/dev/null`,
      ],
      command: 'bash',
      env: { ALL_RELEASE_SECRETS_FILE: Redacted.make(file) },
    });
  });

for (const mode of [
  'success',
  OUTBOX_ONLY_SUCCESS,
  'preparation-failure',
  'registration-failure',
  'termination-after-write',
]) {
  it.effect(`the actual runner preparation owns and cleans its exact secret file: ${mode}`, () =>
    Effect.scoped(
      Effect.gen(function* verifiesRunnerSecretLifecycle() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-secret-lifecycle-' });
        const { encoded, key } = yield* runnerBundleFixture;
        const unrelated = `${root}/unrelated.txt`;
        yield* fs.writeFileString(unrelated, 'preserved');
        const output = `${root}/step-output`;
        const log = `${root}/process.log`;
        const { steps } = readJobs().release;
        const expectedSuccess = mode === 'success' || mode === OUTBOX_ONLY_SUCCESS;
        const prepare = steps.find(({ name }) => name === PREPARE_SECRETS)?.run;
        const cleanup = steps.find(({ name }) => name === CLEANUP_SECRETS)?.run;
        expect(prepare).toBeDefined();
        expect(cleanup).toBeDefined();
        const program =
          mode === 'termination-after-write'
            ? prepare?.replace("printf 'directory=", "kill -TERM $$\nprintf 'directory=")
            : prepare;
        const status = yield* runCommand({
          args: [
            '-euo',
            'pipefail',
            '-c',
            'status=0\nbash -euo pipefail - >"$1" 2>&1 || status=$?\nprintf "%s" "$status"',
            'runner-lifecycle-test',
            log,
          ],
          command: 'bash',
          cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
          env: {
            ALL_RELEASE_SECRETS: Redacted.make(
              mode === 'preparation-failure' ? '{"synthetic-runner-shared-service-secret":' : encoded,
            ),
            GITHUB_OUTPUT: Redacted.make(mode === 'registration-failure' ? `${root}/missing/step-output` : output),
            RUNNER_TEMP: Redacted.make(root),
            STAGE_SHELL_URL: Redacted.make(TEST_STAGE_URL),
            STAGE_ZONE: Redacted.make(TEST_STAGE_ZONE),
            UNITS_JSON: Redacted.make(''),
          },
          stdin: Redacted.make(program ?? ''),
        });
        expect(status === '0').toBe(expectedSuccess);
        const diagnostics = yield* fs.readFileString(log);
        expect(diagnostics).not.toContain(key);
        expect(diagnostics).not.toContain('synthetic-runner-shared-service-secret');
        const directories = (yield* fs.readDirectory(root)).filter((name) => name.startsWith('stage-release-secrets.'));
        if (expectedSuccess) {
          expect(directories).toHaveLength(1);
          const directory = `${root}/${directories[0]}`;
          const file = `${directory}/bundle.json`;
          expect((yield* fs.stat(file)).mode % 0o1000).toBe(0o600);
          expect(yield* fs.readFileString(output)).toContain(`path=${file}`);
          const raw = `${directory}/raw.json`;
          expect((yield* fs.stat(raw)).mode % 0o1000).toBe(0o600);
          expect(yield* fs.readFileString(raw)).toBe(encoded);
          expect(yield* fs.readFileString(output)).toContain(`raw-path=${raw}`);
          const prepared = Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String))),
          )(yield* fs.readFileString(file));
          expect(Object.keys(prepared.projects)).toHaveLength(5);
          yield* verifyNativeRecoveryFileLoaders(steps, file);
          expect((yield* fs.stat(directory)).mode % 0o1000).toBe(0o700);
          const intent = Schema.decodeUnknownSync(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
            readFileSync(new URL('../../topology/application-release-intent.json', import.meta.url), 'utf-8'),
          );
          const gate = steps.find(({ name }) => name === RELEASE_SECRET_CHECK)?.run;
          expect(
            secretStepRuns(
              steps.find(({ name }) => name === RELEASE_SECRET_CHECK)?.if,
              mode === OUTBOX_ONLY_SUCCESS,
              true,
            ),
          ).toBe(mode !== OUTBOX_ONLY_SUCCESS);
          yield* runCommand({
            args: ['-euo', 'pipefail', '-c', gate ?? ''],
            command: 'bash',
            cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
            env: {
              ALL_RELEASE_SECRETS_FILE: Redacted.make(file),
              STAGE_SHELL_URL: Redacted.make(TEST_STAGE_URL),
              STAGE_ZONE: Redacted.make(TEST_STAGE_ZONE),
              UNITS_JSON: Redacted.make(
                JSON.stringify([{ id: 'shell-super-app' }, ...intent.modules.map(({ appId }) => ({ id: appId }))]),
              ),
            },
          });
          for (const _ of [0, 1]) {
            yield* runCommand({
              args: ['-euo', 'pipefail', '-c', cleanup ?? ''],
              command: 'bash',
              env: { PREPARED_SECRETS_DIRECTORY: Redacted.make(directory), RUNNER_TEMP: Redacted.make(root) },
            });
          }
          expect(yield* fs.exists(directory)).toBe(false);
        } else {
          expect(directories).toEqual([]);
        }
        expect(yield* fs.readFileString(unrelated)).toBe('preserved');
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

it.effect('the actual cleanup refuses caller-owned and symlinked directories', () =>
  Effect.scoped(
    Effect.gen(function* fencesSecretCleanup() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-secret-cleanup-fence-' });
      const unrelated = `${root}/unrelated`;
      yield* fs.makeDirectory(unrelated);
      yield* fs.writeFileString(`${unrelated}/bundle.json`, 'preserved');
      const link = `${root}/stage-release-secrets.link`;
      yield* fs.symlink(unrelated, link);
      const cleanup = readJobs().release.steps.find(({ name }) => name === CLEANUP_SECRETS)?.run;
      for (const directory of [unrelated, link]) {
        const result = yield* runCommand({
          args: ['-euo', 'pipefail', '-c', cleanup ?? ''],
          command: 'bash',
          env: { PREPARED_SECRETS_DIRECTORY: Redacted.make(directory), RUNNER_TEMP: Redacted.make(root) },
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(yield* fs.readFileString(`${unrelated}/bundle.json`)).toBe('preserved');
      }
    }),
  ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it('checks every served owner secret before private network access or any stage mutation', () => {
  const { steps } = readJobs().release;
  const check = steps.find(({ name }) => name === RELEASE_SECRET_CHECK);
  expect(check?.env).toEqual({ ALL_RELEASE_SECRETS_FILE: preparedFileReference });
  expect(check?.if).toBe(fullPublicationCondition);
  expect(check?.['continue-on-error']).toBeUndefined();
  expect(check?.['working-directory']).toBe('app');
  expect(check?.run).toContain('workerSecretPlan');
  expect(indexOf(steps, RELEASE_SECRET_CHECK)).toBeGreaterThan(indexOf(steps, INSTALL_APP_STEP));
  for (const later of [
    'Connect the runner to the private Zerops database network',
    RECOVERY_CONFIG_CHECK,
    READINESS,
    INITIAL_BOOTSTRAP,
    MIGRATE,
    CONTINUE_PUBLICATION,
    SERVICE_GRANTS,
    STREAM_START,
    IMMUTABLE_UPLOAD,
  ]) {
    expect(indexOf(steps, RELEASE_SECRET_CHECK)).toBeLessThan(indexOf(steps, later));
  }
});

type SyntheticReleaseBundle = Readonly<Record<string, Readonly<Record<string, string>>>>;
interface PlannedSecretUnit {
  readonly id: string;
}
interface SecretInventoryExample {
  readonly diagnostic?: string;
  readonly input: (bundle: SyntheticReleaseBundle) => string;
  readonly name: string;
  readonly passes: boolean;
  readonly select?: (units: readonly PlannedSecretUnit[]) => readonly PlannedSecretUnit[];
}
const SYNTHETIC_SECRET = 'synthetic-secret-must-never-be-rendered';
const PROJECTS_BINDING = 'projects.SPICEDB_PRESHARED_KEY';
const encodeBundle = (bundle: SyntheticReleaseBundle) => JSON.stringify(bundle);
const withoutSecretName = (owner: Readonly<Record<string, string>>, key: string) =>
  Object.fromEntries(Object.entries(owner).filter(([name]) => name !== key));
const withoutCatalogGatewayClient = (owner: Readonly<Record<string, string>>) =>
  withoutSecretName(
    withoutSecretName(owner, 'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY'),
    'ONTOS_SHELL_GATEWAY_BASE_URL',
  );
const secretInventoryExamples: readonly SecretInventoryExample[] = [
  { input: encodeBundle, name: 'complete native inventory', passes: true },
  {
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        'commerce-market-catalog': withoutCatalogGatewayClient(bundle['commerce-market-catalog']),
      }),
    name: 'existing catalog without the outbound gateway client capability',
    passes: true,
  },
  {
    diagnostic: 'commerce-market-catalog.ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        'commerce-market-catalog': withoutSecretName(
          bundle['commerce-market-catalog'],
          'ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY',
        ),
      }),
    name: 'catalog gateway URL without its caller key',
    passes: false,
  },
  {
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        pricing: withoutSecretName(
          withoutSecretName(bundle.pricing, 'ONTOS_PRICING_GATEWAY_API_KEY'),
          'ONTOS_SHELL_GATEWAY_BASE_URL',
        ),
      }),
    name: 'existing Pricing with native unavailable outbound issuers',
    passes: true,
  },
  {
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        crm: {
          ...withoutSecretName(bundle.crm, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
          ONTOS_GATEWAY_ISSUER: TEST_STAGE_URL,
        },
      }),
    name: 'CRM using its own key and trusted issuer-derived destination',
    passes: true,
  },
  {
    diagnostic: 'crm.ONTOS_SHELL_GATEWAY_BASE_URL',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        crm: {
          ...withoutSecretName(bundle.crm, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
          ONTOS_GATEWAY_ISSUER: 'https://foreign.invalid',
        },
      }),
    name: 'CRM missing both an explicit destination and a trusted issuer',
    passes: false,
  },
  {
    diagnostic: 'commerce-market-catalog.ONTOS_SHELL_GATEWAY_BASE_URL',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        'commerce-market-catalog': withoutSecretName(bundle['commerce-market-catalog'], 'ONTOS_SHELL_GATEWAY_BASE_URL'),
      }),
    name: 'catalog caller key without its gateway URL',
    passes: false,
  },
  {
    diagnostic: 'commerce-market-catalog.ONTOS_GATEWAY_PUBLIC_JWKS',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        'commerce-market-catalog': withoutSecretName(
          withoutCatalogGatewayClient(bundle['commerce-market-catalog']),
          'ONTOS_GATEWAY_PUBLIC_JWKS',
        ),
      }),
    name: 'catalog without the mandatory inbound gateway verifier',
    passes: false,
  },
  {
    diagnostic: 'projects',
    input: (bundle) => JSON.stringify(Object.fromEntries(Object.entries(bundle).filter(([id]) => id !== 'projects'))),
    name: 'missing projects owner',
    passes: false,
  },
  { input: (bundle) => JSON.stringify({ ...bundle, projects: {} }), name: 'empty projects owner', passes: false },
  { input: (bundle) => JSON.stringify({ ...bundle, projects: null }), name: 'null projects owner', passes: false },
  { input: (bundle) => JSON.stringify({ ...bundle, projects: [] }), name: 'array projects owner', passes: false },
  {
    diagnostic: PROJECTS_BINDING,
    input: (bundle) =>
      JSON.stringify({ ...bundle, projects: withoutSecretName(bundle.projects, 'SPICEDB_PRESHARED_KEY') }),
    name: 'missing projects binding',
    passes: false,
  },
  {
    diagnostic: PROJECTS_BINDING,
    input: (bundle) => JSON.stringify({ ...bundle, projects: { ...bundle.projects, SPICEDB_PRESHARED_KEY: ' \n ' } }),
    name: 'blank projects binding',
    passes: false,
  },
  {
    diagnostic: PROJECTS_BINDING,
    input: (bundle) => JSON.stringify({ ...bundle, projects: { ...bundle.projects, SPICEDB_PRESHARED_KEY: 42 } }),
    name: 'non-string projects binding',
    passes: false,
  },
  {
    diagnostic: 'shell-super-app.ONTOS_GATEWAY_PRIVATE_JWK',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        'shell-super-app': withoutSecretName(bundle['shell-super-app'], 'ONTOS_GATEWAY_PRIVATE_JWK'),
      }),
    name: 'missing Shell private key',
    passes: false,
  },
  {
    diagnostic: 'projects.ONTOS_GATEWAY_PUBLIC_JWKS',
    input: (bundle) =>
      JSON.stringify({
        ...bundle,
        projects: {
          ...withoutSecretName(bundle.projects, 'ONTOS_GATEWAY_PUBLIC_JWKS'),
          ONTOS_GATEWAY_PRIVATE_JWK: SYNTHETIC_SECRET,
        },
      }),
    name: 'foreign owner key cannot replace projects public key',
    passes: false,
  },
  { input: () => `{"${SYNTHETIC_SECRET}":`, name: 'malformed secret JSON', passes: false },
  { input: () => '[]', name: 'array secret JSON', passes: false },
  { input: () => 'null', name: 'null secret JSON', passes: false },
  {
    input: encodeBundle,
    name: 'missing planned projects',
    passes: false,
    select: (units) => units.filter(({ id }) => id !== 'projects'),
  },
  { input: encodeBundle, name: 'empty planned inventory', passes: false, select: () => [] },
  {
    input: encodeBundle,
    name: 'duplicate planned unit',
    passes: false,
    select: (units) => [...units, { id: 'projects' }],
  },
];
for (const example of secretInventoryExamples) {
  it.effect(`the actual early secret gate checks ${example.name}`, () =>
    Effect.scoped(
      Effect.gen(function* checksReleaseSecretInventory() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-release-secret-gate-' });
        const summary = `${root}/summary.md`;
        const output = `${root}/output.log`;
        const bundleFile = `${root}/bundle.json`;
        const released = Schema.decodeUnknownSync(Schema.fromJsonString(ApplicationReleaseIntentSchema))(
          readFileSync(new URL('../../topology/application-release-intent.json', import.meta.url), 'utf-8'),
        );
        const ids = new Set(['shell-super-app', ...released.modules.map(({ appId }) => appId)]);
        const units = (yield* readEdgeUnits).filter(({ id }) => ids.has(id));
        // Synthetic values only. The fixture and gate both use the native name contract.
        const secret = Redacted.make(SYNTHETIC_SECRET);
        const plan = workerSecretPlan(
          units,
          { shellHostname: 'stage.example.test', stageZone: TEST_STAGE_ZONE },
          {
            betterAuthSecret: secret,
            commerceCustomerContextGatewayApiKey: secret,
            commerceMarketCatalogGatewayApiKey: secret,
            crmPartyIntakeApiKey: secret,
            gatewayPrivateJwk: secret,
            gatewayPublicJwks: secret,
            pricingGatewayApiKey: secret,
            spicedbPresharedKey: secret,
          },
        );
        const bundle: SyntheticReleaseBundle = Object.fromEntries(
          units.map((unit) => [
            unit.id,
            Object.fromEntries(Object.keys(plan.get(unit.workerName) ?? {}).map((key) => [key, SYNTHETIC_SECRET])),
          ]),
        );
        const planned = units.map(({ id }) => ({ id }));
        const step = readJobs().release.steps.find(({ name }) => name === RELEASE_SECRET_CHECK);
        const program = step?.run?.match(/<<'NODE'\n(?<program>[\s\S]+)\nNODE/u)?.groups?.program;
        expect(program).toBeDefined();
        yield* fs.writeFileString(bundleFile, example.input(bundle));
        const status = yield* runCommand({
          args: [
            '-euo',
            'pipefail',
            '-c',
            'status=0\nnode --input-type=module - >"$1" 2>&1 || status=$?\nprintf "%s" "$status"',
            'release-secret-inventory-test',
            output,
          ],
          command: 'bash',
          cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
          env: {
            ALL_RELEASE_SECRETS_FILE: Redacted.make(bundleFile),
            GITHUB_STEP_SUMMARY: Redacted.make(summary),
            STAGE_SHELL_URL: Redacted.make(TEST_STAGE_URL),
            STAGE_ZONE: Redacted.make(TEST_STAGE_ZONE),
            UNITS_JSON: Redacted.make(JSON.stringify(example.select?.(planned) ?? planned)),
          },
          stdin: Redacted.make(program ?? ''),
        });
        expect(status).toBe(example.passes ? '0' : '1');
        const rendered = yield* fs.readFileString(summary);
        expect(yield* fs.readFileString(output)).not.toContain(SYNTHETIC_SECRET);
        expect(rendered).not.toContain(SYNTHETIC_SECRET);
        if (example.diagnostic !== undefined) {
          expect(rendered).toContain(example.diagnostic);
        }
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

it('streams the uploads in the background beside the database preparation and joins them before the candidate', () => {
  const { steps } = readJobs().release;
  const upload = steps.find(({ name }) => name === STREAM_START);
  expect(upload?.if).toBe(fullPublicationCondition);
  expect(upload?.env?.ALL_RELEASE_SECRETS_FILE).toBe(preparedFileReference);
  expect(upload?.run).toContain('scripts/ci/release-stream.mts stream');
  expect(upload?.run).toContain('--parallelism 8');
  // The stream starts right after barrier B1 and the Worker limit guard, before the first database change of either path.
  expect(indexOf(steps, WORKER_GUARD)).toBe(indexOf(steps, RELEASE_TESTS_BARRIER) + 1);
  expect(indexOf(steps, STREAM_START)).toBe(indexOf(steps, WORKER_GUARD) + 1);
  expect(indexOf(steps, STREAM_START)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(upload?.run).toContain('--start-file "$STREAM_DIRECTORY/start"');
  // The background status file is the only path from the stream's outcome to the job's.
  expect(upload?.run).toContain(String.raw`printf '%s\n' "$status" >"$STREAM_DIRECTORY/exit-code"`);
  expect(upload?.run).toContain(') </dev/null >/dev/null 2>&1 &');
  expect(upload?.id).toBe('uploads');
  expect(upload?.run).toContain('--stop-file "$STREAM_DIRECTORY/stop"');
  // A failed step before the join stops the stream, and the join still waits for the uploads already running.
  const stop = steps.find(({ name }) => name === STOP_UPLOADS);
  // A cancelled run stops the stream too, or its unpacked units would hold the stage lock until the deadline.
  expect(stop?.if).toBe("(failure() || cancelled()) && steps.uploads.outcome == 'success'");
  // Every step before publication runs while the stream may still upload, so its failure stops the stream.
  for (const prepared of [DATABASE_RECORD, HOST_FETCH, STOREFRONT_FETCH, HOST_MATERIALIZE, HOST_RELEASE]) {
    expect(indexOf(steps, prepared)).toBeGreaterThan(indexOf(steps, STREAM_START));
    expect(indexOf(steps, prepared)).toBeLessThan(indexOf(steps, STOP_UPLOADS));
  }
  expect(stop?.run).toBe('touch "$STREAM_DIRECTORY/stop"');
  const join = steps.find(({ name }) => name === UPLOAD_JOIN);
  expect(join?.if).toBe("always() && steps.uploads.outcome == 'success'");
  expect(indexOf(steps, STOP_UPLOADS)).toBe(indexOf(steps, UPLOAD_JOIN) - 1);
  expect(join?.run).toContain('release-stream.mts join --directory "$STREAM_DIRECTORY"');
  expect(indexOf(steps, STREAM_START)).toBeLessThan(indexOf(steps, SERVICE_GRANTS));
  expect(indexOf(steps, SERVICE_GRANTS)).toBeLessThan(indexOf(steps, UPLOAD_JOIN));
  expect(indexOf(steps, UPLOAD_JOIN)).toBeLessThan(indexOf(steps, CANDIDATE));
  expect(indexOf(steps, CANDIDATE)).toBeLessThan(indexOf(steps, PUBLICATION));
});

it('plans from input digests in the protected environment without a deployment and rechecks them in the release', () => {
  const jobs = readJobs();
  const { plan, release } = jobs;
  expect(plan.environment).toEqual({ deployment: false, name: 'stage-edge' });
  expect(plan.permissions).toEqual({ actions: 'read', contents: 'read' });
  const planner = plan.steps.find(({ id }) => id === 'plan');
  expect(planner?.run).toContain(['mise exec -- node scripts/ci/deploy-plan.mts "$', '{args[@]}"'].join(''));
  expect(planner?.env?.RELEASE_FINGERPRINT_KEY).toBe(secretReference('RELEASE_FINGERPRINT_KEY'));
  expect(planner?.env?.STAGE_DEMO_FORCE_FULL).toBe(['${{', 'vars.STAGE_DEMO_FORCE_FULL', '}}'].join(' '));
  for (const output of [
    'units',
    'build_matrix',
    'build_count',
    'host_mode',
    'host_digest',
    'storefront_mode',
    'storefront_digest',
    'db_inputs_digest',
    'db_mode',
    'force_full',
  ]) {
    expect(plan.outputs?.[output]).toBe(['${{', `steps.plan.outputs.${output}`, '}}'].join(' '));
  }
  // The digest's build environment is the same in the plan, the builds and the release.
  for (const key of ['DEPLOY_TARGET', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT', 'ULTRAMODERN_DISABLE_BUILD_TS_CHECKER']) {
    expect(planner?.env?.[key]).toBeDefined();
    expect(jobs.build.env?.[key]).toBe(planner?.env?.[key]);
    expect(release.env?.[key]).toBe(planner?.env?.[key]);
  }
  expect(release.needs).toEqual(['plan']);
  const recompute = release.steps.find(({ name }) => name === RECOMPUTE_PLAN);
  expect(recompute?.if).toBe(fullPublicationCondition);
  expect(recompute?.run).toContain('scripts/ci/deploy-plan.mts verify --plan "$PLAN_FILE"');
  expect(recompute?.run).toContain('scripts/ci/release-ledger.mts init --plan "$PLAN_FILE"');
  expect(indexOf(release.steps, RECOMPUTE_PLAN)).toBeLessThan(
    indexOf(release.steps, 'Connect the runner to the private Zerops database network'),
  );
});

it("tags and proves every uploaded backend version with the planner's secret fingerprint key", () => {
  const { plan, release } = readJobs();
  const planner = plan.steps.find(({ id }) => id === 'plan');
  // Each upload records the HMAC of its owner secrets on its backend Worker version, and reusing a release (a
  // failed-job rerun or a retained unit) requires that fingerprint, so the release job holds the plan's key.
  expect(release.env?.RELEASE_FINGERPRINT_KEY).toBe(secretReference('RELEASE_FINGERPRINT_KEY'));
  expect(release.env?.RELEASE_FINGERPRINT_KEY).toBe(planner?.env?.RELEASE_FINGERPRINT_KEY);
});

it('hands the environment-scoped Cloudflare account to the builds, which run without the environment', () => {
  const { build, plan, release } = readJobs();
  const planner = plan.steps.find(({ id }) => id === 'plan');
  // Read in the env-less build job, vars.CLOUDFLARE_ACCOUNT_ID is empty and every unit digest differs from the plan's.
  expect(planner?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(workflowExpression('vars.CLOUDFLARE_ACCOUNT_ID'));
  expect(release.env?.CLOUDFLARE_ACCOUNT_ID).toBe(planner?.env?.CLOUDFLARE_ACCOUNT_ID);
  expect(planner?.run).toContain(
    String.raw`printf 'cloudflare_account_id=%s\n' "$CLOUDFLARE_ACCOUNT_ID" >>"$GITHUB_OUTPUT"`,
  );
  expect(plan.outputs?.cloudflare_account_id).toBe(workflowExpression('steps.plan.outputs.cloudflare_account_id'));
  expect(build.environment).toBeUndefined();
  expect(build.env?.CLOUDFLARE_ACCOUNT_ID).toBe(workflowExpression('needs.plan.outputs.cloudflare_account_id'));
});

it('builds only the changed units, trusts the lockfile there and names every output by its digest', () => {
  const { build, 'build-outbox-host': host, 'build-storefront': storefront, verify } = readJobs();
  expect(build.if).toBe("needs.plan.outputs.build_count != '0'");
  expect(build.strategy?.['max-parallel']).toBe(16);
  expect(build.strategy?.matrix.unit).toBe(['${{', 'fromJSON(needs.plan.outputs.build_matrix)', '}}'].join(' '));
  expect(build.env?.ONTOS_UNIT_INPUT_DIGEST).toBe(['${{', 'matrix.unit.digest', '}}'].join(' '));
  expect(build.environment).toBeUndefined();
  expect(host.if).toBe("needs.plan.outputs.host_mode == 'build'");
  expect(storefront.if).toBe("needs.plan.outputs.storefront_mode == 'build'");
  for (const job of [build, storefront, verify]) {
    const install = job.steps.find(({ uses }) => uses === INSTALL_APP);
    expect(install?.with?.['install-args']).toBe('--trust-lockfile');
  }
  const uploads = [build, host, storefront].map(
    (job) => job.steps.find(({ uses }) => uses?.startsWith(UPLOAD_ARTIFACT) === true)?.with,
  );
  expect(uploads.map((upload) => upload?.name)).toEqual([
    `edge-unit-${workflowExpression('matrix.unit.id')}-${workflowExpression('matrix.unit.digest')}`,
    `outbox-host-${workflowExpression('needs.plan.outputs.host_digest')}`,
    `akros-storefront-${workflowExpression('needs.plan.outputs.storefront_digest')}`,
  ]);
  for (const upload of uploads) {
    expect(upload?.overwrite).toBe(true);
    expect(upload?.['retention-days']).toBe(30);
  }
  expect(host.steps.find(({ name }) => name === 'Build the host in Alpine')?.run).toContain(
    'alpine:3.23 sh app/scripts/ci/build-outbox-host.sh',
  );
  const tests = readJobs()['release-script-tests'].steps.find(({ uses }) => uses === INSTALL_APP);
  // This run's one full supply-chain policy install, which also saves the branch's pnpm store.
  expect(tests?.with).toEqual({ 'save-store': 'true' });
});

it('waits for the release script tests before the first stage change', () => {
  const { steps } = readJobs().release;
  const barrier = steps.find(({ name }) => name === RELEASE_TESTS_BARRIER);
  expect(barrier?.if).toBe(fullPublicationCondition);
  expect(barrier?.run).toContain("release-stream.mts await --job 'Test the release scripts'");
  expect(barrier?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, DATABASE_PATH)).toBeLessThan(indexOf(steps, RELEASE_TESTS_BARRIER));
  for (const mutation of [
    STREAM_START,
    INITIAL_BOOTSTRAP,
    MIGRATE,
    CONTINUE_PUBLICATION,
    IMMUTABLE_UPLOAD,
    SERVICE_GRANTS,
  ]) {
    expect(indexOf(steps, RELEASE_TESTS_BARRIER)).toBeLessThan(indexOf(steps, mutation));
  }
});

it('skips the sealed chain only on the live database light path and records the prepared state after the grants', () => {
  const { steps } = readJobs().release;
  const decision = steps.find(({ name }) => name === DATABASE_PATH);
  expect(decision?.id).toBe('database-path');
  expect(decision?.if).toBe(freshMigrationCondition);
  expect(decision?.run).toContain('--plan --inputs-digest "$DB_INPUTS_DIGEST" --database-record "$record"');
  // A forced run, a non-auto plan or a schema retry always takes the full chain.
  expect(decision?.run).toContain('if [[ "$DB_MODE" != auto || -n "$RESUME_MIGRATED_REVISION" ]]; then');
  expect(decision?.run).toContain('args+=(--force-full)');
  expect(decision?.run).toContain('release-stream.mts database-path');
  expect(indexOf(steps, READINESS)).toBeLessThan(indexOf(steps, DATABASE_PATH));
  const record = steps.find(({ name }) => name === DATABASE_RECORD);
  expect(record?.if).toBe(freshMigrationCondition);
  expect(record?.run).toContain('scripts/postgres/database-state-fingerprint.mts');
  // The decision and the record observe the same identities, Commerce portal pair included.
  expect(record?.env).toEqual({
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: secretReference('DATABASE_ADMIN_URL'),
    COMMERCE_PORTAL_AUTH_DATABASE_URL: secretReference('DATABASE_URL'),
  });
  expect(decision?.env?.COMMERCE_PORTAL_AUTH_DATABASE_URL).toBe(record?.env?.COMMERCE_PORTAL_AUTH_DATABASE_URL);
  expect(decision?.env?.COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL).toBe(
    record?.env?.COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL,
  );
  expect(indexOf(steps, SERVICE_GRANTS)).toBeLessThan(indexOf(steps, DATABASE_RECORD));
});

it('keeps the identity bootstrap and the owner verification on the database light path', () => {
  const { steps } = readJobs().release;
  // The light path skips only the sealed migration child: the identity bootstrap (mutable trust mapping) runs on
  // both paths and the owner verification the child would end with runs before the state is recorded.
  expect(steps.find(({ name }) => name === INITIAL_BOOTSTRAP)?.if).toBe(freshMigrationCondition);
  expect(steps.find(({ name }) => name === MIGRATE)?.if).toBe(fullDatabaseCondition);
  expect(steps.find(({ name }) => name === POST_MIGRATION_BOOTSTRAP)?.if).toBe(ownerVerifyCondition);
  expect(indexOf(steps, INITIAL_BOOTSTRAP)).toBeLessThan(indexOf(steps, POST_MIGRATION_BOOTSTRAP));
  expect(indexOf(steps, POST_MIGRATION_BOOTSTRAP)).toBeLessThan(indexOf(steps, DATABASE_RECORD));
});

it('prepares everything the outbox host deploy needs before publication', () => {
  const { steps } = readJobs().release;
  // Everything that does not need the publication happens before it: fetching the host artifact (barrier B2 when
  // this run builds it), its configuration file and the release it names. Only apply and push come after.
  for (const prepared of [HOST_FETCH, HOST_MATERIALIZE, HOST_RELEASE]) {
    const step = steps.find(({ name }) => name === prepared);
    expect(step?.if).toBeUndefined();
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(indexOf(steps, prepared)).toBeLessThan(indexOf(steps, CANDIDATE));
  }
  const fetch = steps.find(({ name }) => name === HOST_FETCH);
  expect(fetch?.run).toContain('release-stream.mts fetch --plan "$PLAN_FILE" --artifact outbox-host');
  expect(fetch?.run).toContain('--output "$RUNNER_TEMP/outbox-host"');
  const release = steps.find(({ name }) => name === HOST_RELEASE);
  expect(release?.id).toBe('host-release');
  expect(release?.run).toBe(
    'mise exec -- pnpm exec node scripts/ci/release-stream.mts host-release --plan "$PLAN_FILE" >>"$GITHUB_OUTPUT"',
  );
});

it('always redeploys the outbox host after the configuration apply, with no live probe that could skip it', () => {
  const { steps } = readJobs().release;
  // Zerops resolves native secret references outside the materialized configuration, so no live digest proves the
  // running configuration current: nothing may make the host deploy conditional.
  expect(steps.some(({ run }) => run?.includes('--probe') === true)).toBe(false);
  expect(steps.some(({ run }) => run?.includes('host-decision') === true)).toBe(false);
  expect(steps.some(({ if: condition }) => condition?.includes('outputs.deploy') === true)).toBe(false);
  const start = steps.find(({ name }) => name === HOST_DEPLOY_START);
  expect(start?.if).toBeUndefined();
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeLessThan(indexOf(steps, HOST_DEPLOY_START));
  const record = steps.find(({ name }) => name === 'Record the outbox host in the release ledger');
  expect(record?.if).toBe(
    workflowExpression("!inputs.outbox_only && steps.host-release.outputs.source-revision != ''"),
  );
  expect(record?.env).toEqual({
    HOST_DIGEST: workflowExpression('steps.host-release.outputs.digest'),
    HOST_SOURCE_REVISION: workflowExpression('steps.host-release.outputs.source-revision'),
  });
});

it('deploys the prebuilt outbox host beside the Shell tail after publication and requires positive admission', () => {
  const { steps } = readJobs().release;
  expect(steps.some(({ name }) => name === 'Install Zerops CLI')).toBe(false);
  expect(steps.some(({ run }) => run?.includes('sleep 60') === true)).toBe(false);
  const start = steps.find(({ name }) => name === HOST_DEPLOY_START);
  expect(start?.env?.ZCLI_PATH).toBe(['${{', 'steps.composition-vpn.outputs.cli-path', '}}'].join(' '));
  // The artifact the push deploys is the one fetched before publication.
  expect(start?.run).not.toContain('release-stream.mts fetch');
  expect(start?.env?.OUTBOX_HOST_ARTIFACT).toBe(
    `${workflowExpression(RUNNER_TEMP_CONTEXT)}/outbox-host/outbox-host.tar.zst`,
  );
  expect(start?.run).toContain('app/scripts/push-zerops-units.sh');
  expect(start?.id).toBe('host-start');
  expect(start?.env?.OUTBOX_HOST_DIGEST).toBe(workflowExpression('steps.host-release.outputs.digest'));
  // Joined even after a failed tail step, so the host deploy is never cut off halfway.
  expect(steps.find(({ name }) => name === HOST_DEPLOY_JOIN)?.if).toBe(
    "always() && steps.host-start.outcome == 'success'",
  );
  const admission = steps.find(({ name }) => name === HOST_ADMISSION);
  expect(admission?.if).toBeUndefined();
  expect(admission?.run).toContain('scripts/ci/await-outbox-admission.mts');
  expect(admission?.run).toContain('--revision "$revision" --host-digest "$HOST_DIGEST" --timeout 180');
  // The Shell ingress, rebrand and storefront run in the foreground while the host deploys; both branches join
  // before the customer fixture, which needs the host admitted.
  const order = [
    PUBLICATION,
    RECOVERY_CONFIG_APPLY,
    HOST_DEPLOY_START,
    SHELL_INGRESS,
    'Rebrand the rental demo through the native Shell Action',
    STOREFRONT_DEPLOY,
    HOST_DEPLOY_JOIN,
    HOST_ADMISSION,
    'Prepare the native demo customer fixture',
    'Clear the runner-owned Zerops VPN',
    'Smoke the Shell login and OAuth metadata',
  ].map((name) => indexOf(steps, name));
  expect(order.every((position) => position >= 0)).toBe(true);
  expect(order).toEqual(EffectArray.sort(order, Order.Number));
});

it('writes the release ledger at its checkpoints even when a later step fails', () => {
  const { steps } = readJobs().release;
  const record = steps.find(({ name }) => name === LEDGER_UNITS);
  expect(record?.id).toBe('ledger-units');
  expect(record?.if).toBe("always() && !inputs.outbox_only && steps.release-secrets.outputs.directory != ''");
  const uploads = steps.filter(({ with: options }) => options?.name === 'stage-release-ledger');
  expect(uploads.map(({ name }) => name)).toEqual([
    'Upload the release ledger checkpoint',
    'Upload the final release ledger',
  ]);
  for (const upload of uploads) {
    expect(upload.if).toBe("always() && steps.ledger-units.outcome == 'success'");
    expect(upload.with?.overwrite).toBe(true);
    expect(upload.with?.['retention-days']).toBe(90);
  }
  expect(indexOf(steps, UPLOAD_JOIN)).toBeLessThan(indexOf(steps, LEDGER_UNITS));
  // The always-run artifact and ledger checkpoints wait beside the host deploy, not before publication.
  for (const checkpoint of [
    'Archive the candidate and receipts',
    'Upload the per-unit upload logs',
    LEDGER_UNITS,
    'Upload the release ledger checkpoint',
  ]) {
    expect(steps.find(({ name }) => name === checkpoint)?.if?.startsWith('always() && ')).toBe(true);
    expect(indexOf(steps, checkpoint)).toBeGreaterThan(indexOf(steps, HOST_DEPLOY_START));
    expect(indexOf(steps, checkpoint)).toBeLessThan(indexOf(steps, SHELL_INGRESS));
  }
  expect(indexOf(steps, 'Record the outbox host in the release ledger')).toBeLessThan(
    indexOf(steps, 'Upload the final release ledger'),
  );
});

const APP_DIRECTORY = new URL('../..', import.meta.url).pathname.replace(/\/$/u, '');
const workflowServices = OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer));
const sha256 = (seed: string) => createHash('sha256').update(seed).digest('hex');
/** A release step's own script, run from app/ with only these environment additions. */
const runReleaseStep = (name: string, env: Readonly<Record<string, string>>) => {
  const step = readJobs().release.steps.find((candidate) => candidate.name === name);
  expect(step?.['working-directory']).toBe('app');
  return runCommand({
    args: ['-euo', 'pipefail', '-c', step?.run ?? 'exit 1'],
    command: 'bash',
    cwd: APP_DIRECTORY,
    env: Object.fromEntries(Object.entries(env).map(([key, value]) => [key, Redacted.make(value)])),
  });
};

it.effect('the actual ledger checkpoint records the uploaded receipts and the prepared database', () =>
  Effect.scoped(
    Effect.gen(function* recordsWorkflowLedger() {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-ledger-checkpoint-' });
      const ledgerFile = path.join(temp, 'stage-release-ledger', 'stage-release-ledger.json');
      const receipts = path.join(temp, 'release-receipts');
      const stream = path.join(temp, 'release-stream');
      for (const directory of [path.dirname(ledgerFile), receipts, stream]) {
        mkdirSync(directory, { recursive: true });
      }
      const now = yield* DateTime.nowAsDate;
      writeFileSync(
        ledgerFile,
        serializeLedger(
          emptyLedger({ digestVersion: 'ontos-deploy-plan-v1', now, runId: '41', sourceRevision: 'a'.repeat(40) }),
        ),
      );
      const digest = sha256('alpha');
      const receipt = {
        artifacts: {},
        assetsVersionId: 'assets-alpha',
        backend: { versionId: 'backend-alpha', workerName: 'ontos-alpha' },
        plan: {
          appId: 'alpha',
          assetsOrigin: 'https://assets-alpha.example.test/',
          assetsScriptName: 'ontos-assets-alpha',
          backendScriptName: 'ontos-alpha',
          buildMarker: sha256('marker'),
          sourceRevision: 'a'.repeat(40),
        },
      };
      writeFileSync(path.join(receipts, 'alpha.json'), JSON.stringify(receipt));
      writeFileSync(
        path.join(stream, 'units.json'),
        JSON.stringify([
          { artifactName: `edge-unit-alpha-${digest}`, digest, id: 'alpha', mode: 'build', status: 'uploaded' },
        ]),
      );
      const database = { identityFp: sha256('identity'), inputsDigest: sha256('inputs'), stateHash: sha256('state') };
      writeFileSync(path.join(temp, 'database-record.json'), JSON.stringify(database));
      yield* runReleaseStep(LEDGER_UNITS, {
        GITHUB_RUN_ID: '42',
        LEDGER_DIRECTORY: path.dirname(ledgerFile),
        PLAN_FILE: path.join(temp, 'deploy-plan', 'deploy-plan.json'),
        RECEIPTS: receipts,
        RUNNER_TEMP: temp,
        STREAM_DIRECTORY: stream,
      });
      const ledger = parseLedger(yield* fs.readFileString(ledgerFile));
      expect(ledger.units[digest]).toMatchObject({ runId: '42' });
      expect(ledger.database).toMatchObject({ ...database, runId: '42' });
    }),
  ).pipe(Effect.provide(workflowServices)),
);

// `gh api <route>` answers this run's jobs from the fixture file, lists one artifact of any name and downloads an
// empty zip for it.
const GH_JOBS_SHIM = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const route = process.argv[3];
appendFileSync(process.env.SHIM_LOG_FILE, route + '\\n');
if (route.includes('/jobs?filter=latest')) {
  const jobs = JSON.parse(readFileSync(process.env.SHIM_JOBS_FILE, 'utf8'));
  process.stdout.write(JSON.stringify({ jobs, total_count: jobs.length }));
} else if (route.includes('/artifacts?name=')) {
  const name = decodeURIComponent(route.match(/name=([^&]+)/)[1]);
  process.stdout.write(JSON.stringify({ artifacts: [{ expired: false, id: 7, name }], total_count: 1 }));
} else if (/artifacts\\/\\d+\\/zip$/.test(route)) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  process.stdout.write(end);
} else {
  process.exit(1);
}
`;

it('publishes no replacement composition before the outbox host and storefront builds succeeded', () => {
  const jobs = readJobs();
  const { steps } = jobs.release;
  expect(steps.some(({ name }) => name === 'Wait for the outbox host and storefront builds')).toBe(false);
  // The fetch steps find the build jobs by the names the workflow gives them.
  expect(jobs['build-outbox-host'].name).toBe(HOST_BUILD_JOB);
  expect(jobs['build-storefront'].name).toBe(STOREFRONT_BUILD_JOB);
  const host = steps.find(({ name }) => name === HOST_FETCH);
  const storefront = steps.find(({ name }) => name === STOREFRONT_FETCH);
  expect(host?.if).toBeUndefined();
  expect(storefront?.if).toBe(fullPublicationCondition);
  expect(storefront?.run).toContain('release-stream.mts fetch --plan "$PLAN_FILE" --artifact akros-storefront');
  for (const fetch of [HOST_FETCH, STOREFRONT_FETCH]) {
    expect(steps.find(({ name }) => name === fetch)?.['continue-on-error']).toBeUndefined();
    expect(indexOf(steps, fetch)).toBeLessThan(indexOf(steps, CANDIDATE));
  }
  expect(indexOf(steps, CANDIDATE)).toBeLessThan(indexOf(steps, PUBLICATION));
});

const buildJob = (name: string, conclusion: string) => ({ conclusion, name, status: 'completed' });
for (const example of [
  { fetch: HOST_FETCH, jobs: [buildJob(HOST_BUILD_JOB, 'failure')], mode: 'build', ok: false },
  { fetch: HOST_FETCH, jobs: [buildJob(HOST_BUILD_JOB, 'success')], mode: 'build', ok: true },
  { fetch: STOREFRONT_FETCH, jobs: [buildJob(STOREFRONT_BUILD_JOB, 'cancelled')], mode: 'build', ok: false },
  { fetch: STOREFRONT_FETCH, jobs: [buildJob(STOREFRONT_BUILD_JOB, 'success')], mode: 'build', ok: true },
  { fetch: HOST_FETCH, jobs: [buildJob(HOST_BUILD_JOB, 'failure')], mode: 'kept', ok: true },
]) {
  it.effect(
    `the actual ${example.fetch === HOST_FETCH ? 'host' : 'storefront'} fetch ${example.ok ? 'passes' : 'stops'} a ${example.mode} artifact after a ${example.jobs.map(({ conclusion }) => conclusion).join(', ')} build`,
    () =>
      Effect.scoped(
        Effect.gen(function* awaitsWorkflowBuilds() {
          const fs = yield* FileSystem.FileSystem;
          const inherited = yield* Config.String('PATH');
          const temp = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-build-barrier-' });
          mkdirSync(path.join(temp, 'bin'));
          writeFileSync(path.join(temp, 'bin', 'gh'), GH_JOBS_SHIM);
          chmodSync(path.join(temp, 'bin', 'gh'), 0o755);
          writeFileSync(path.join(temp, 'jobs.json'), JSON.stringify(example.jobs));
          const built = example.mode === 'build';
          const kept = { id: 9, name: 'kept-artifact', sourceRevision: 'a'.repeat(40) };
          const planFile = path.join(temp, 'deploy-plan.json');
          writeFileSync(
            planFile,
            JSON.stringify({
              host: { artifact: built ? null : kept, digest: sha256('host'), mode: built ? 'build' : 'retain' },
              storefront: {
                artifact: built ? null : kept,
                digest: sha256('storefront'),
                mode: built ? 'build' : 'reuse',
              },
              units: [],
            }),
          );
          const exit = yield* Effect.exit(
            runReleaseStep(example.fetch, {
              GITHUB_REPOSITORY: 'example/ontos',
              GITHUB_RUN_ID: '42',
              PATH: `${path.join(temp, 'bin')}:${inherited}`,
              PLAN_FILE: planFile,
              RUNNER_TEMP: temp,
              SHIM_JOBS_FILE: path.join(temp, 'jobs.json'),
              SHIM_LOG_FILE: path.join(temp, 'gh.log'),
            }),
          );
          expect(Exit.isSuccess(exit)).toBe(example.ok);
          const routes = readFileSync(path.join(temp, 'gh.log'), 'utf-8');
          // A failed build is never downloaded; a kept artifact needs no build job of this run.
          expect(routes.includes('/zip')).toBe(example.ok);
          expect(routes.includes('/jobs?')).toBe(built);
        }),
      ).pipe(Effect.provide(workflowServices)),
  );
}

it('plans, rechecks, builds and deploys the storefront with the same build literals', () => {
  const {
    env,
    jobs: { 'build-storefront': build, plan, release },
  } = readWorkflow();
  const resolve = (value: string | undefined) =>
    value?.replace(/^\$\{\{ env\.(?<key>[A-Z_]+) \}\}$/u, (_match, key: string) => env[key] ?? 'unset');
  const literals = [
    plan.steps.find(({ id }) => id === 'plan')?.env,
    release.steps.find(({ name }) => name === RECOMPUTE_PLAN)?.env,
    build.steps.find(({ name }) => name === 'Build the storefront Worker')?.env,
    release.steps.find(({ name }) => name === STOREFRONT_DEPLOY)?.env,
  ].map((stepEnv) => Object.fromEntries(STOREFRONT_ENV_KEYS.map((key) => [key, resolve(stepEnv?.[key])])));
  // Every literal is set, the explicitly empty image hosts included, so the plan may reuse a storefront build.
  for (const key of STOREFRONT_ENV_KEYS) {
    expect(literals[0]?.[key]).toBeTypeOf('string');
    expect(literals[0]?.[key]).not.toBe('unset');
  }
  expect(literals[0]?.STOREFRONT_IMAGE_HOSTS).toBe('');
  for (const stepLiterals of literals) {
    expect(stepLiterals).toEqual(literals[0]);
  }
});

it('builds each unit reference graph before the native Cloudflare build on a fresh runner', () => {
  const { steps } = readJobs().build;
  const build = steps.find(({ name }) => name === UNIT_BUILD_STEP);
  expect(build?.run).toBe('bash app/scripts/ci/build-edge-unit.sh');
  expect(build?.if).toBeUndefined();
  expect(build?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, UNIT_BUILD_STEP)).toBeGreaterThan(indexOf(steps, INSTALL_APP_STEP));
  // Project-mode checks in the bundler consume declarations but do not build references.
  const script = readFileSync(new URL('../ci/build-edge-unit.sh', import.meta.url), 'utf-8');
  const references = script.indexOf('ultramodern typecheck --build "$UNIT_PATH/tsconfig.json"');
  expect(references).toBeGreaterThan(0);
  expect(script.indexOf('run cloudflare:build')).toBeGreaterThan(references);
  // The build stops before building when its checkout or environment yields another digest than the plan's.
  const digest = script.indexOf('--expect-digest "$ONTOS_UNIT_INPUT_DIGEST"');
  expect(digest).toBeGreaterThan(0);
  expect(digest).toBeLessThan(references);
  expect(script).toContain('--secret-fingerprint "$ONTOS_UNIT_SECRET_FINGERPRINT"');
  // Each unit restores and saves its own TS-Go reference build.
  const install = steps.find(({ name }) => name === INSTALL_APP_STEP);
  expect(install?.with?.['restore-typescript-build']).toBe('true');
  expect(install?.with?.['typescript-build-unit']).toBe(workflowExpression('matrix.unit.id'));
  const save = steps.find(({ name }) => name === "Save the unit's TS-Go typecheck build");
  expect(save?.with?.key).toBe(workflowExpression('steps.install.outputs.typescript-build-key'));
  expect(indexOf(steps, "Save the unit's TS-Go typecheck build")).toBeGreaterThan(indexOf(steps, UNIT_BUILD_STEP));
});

it('runs every owner migration through the native lifecycle on the private network before upload or publication', () => {
  const { steps } = readJobs().release;
  const migrate = steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.run).toContain('mise exec -- pnpm exec node scripts/stage-demo-migrate.mts');
  expect(migrate?.run).toContain('args+=(--resume-migrated-revision "$RESUME_MIGRATED_REVISION")');
  expect(migrate?.env?.RESUME_MIGRATED_REVISION).toBe(
    ['${{', 'steps.migration-readiness.outputs.resume-migrated-revision', '}}'].join(' '),
  );
  expect(migrate?.['working-directory']).toBe('app');
  expect(migrate?.['timeout-minutes']).toBeGreaterThan(0);
  // Fresh releases migrate unless the live database light path holds; the guarded continuation publishes an
  // already completed migration.
  expect(migrate?.if).toBe(fullDatabaseCondition);
  expect(migrate?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, 'Write the initial cutover receipt')).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, 'Write the initial cutover receipt')).toBeLessThan(indexOf(steps, MIGRATE));
  expect(indexOf(steps, MIGRATE)).toBeGreaterThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(indexOf(steps, POST_MIGRATION_BOOTSTRAP)).toBeGreaterThan(indexOf(steps, MIGRATE));
  const connect = steps.findIndex(({ id }) => id === 'composition-vpn');
  expect(connect).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, READINESS)).toBeGreaterThan(connect);
  expect(indexOf(steps, READINESS)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(steps.find(({ name }) => name === POST_MIGRATION_BOOTSTRAP)?.run).toBe('mise exec -- pnpm db:verify');
  expect(indexOf(steps, MIGRATE)).toBeGreaterThan(connect);
  for (const later of [IMMUTABLE_UPLOAD, PUBLICATION, SHELL_INGRESS, 'Deploy the AKROS storefront']) {
    expect(indexOf(steps, later)).toBeGreaterThan(indexOf(steps, MIGRATE));
  }
});

it('uploads before the sealed migrations finished on no path but the database light path', () => {
  const { steps } = readJobs().release;
  const stream = steps.find(({ name }) => name === STREAM_START);
  // Only the light path, which runs no migration, allows the uploads when the stream starts.
  expect(stream?.env?.DATABASE_MODE).toBe(workflowExpression('steps.database-path.outputs.mode'));
  expect(stream?.run).toContain(
    ['if [[ "$DATABASE_MODE" == light ]]; then', '  touch "$STREAM_DIRECTORY/start"', 'fi'].join('\n'),
  );
  expect(stream?.run?.match(/STREAM_DIRECTORY\/start"/gu)).toHaveLength(2);
  // The full chain and a continuation allow them only once their last database step succeeded.
  const allow = steps.find(({ name }) => name === IMMUTABLE_UPLOAD);
  expect(allow?.if).toBe(fullPublicationCondition);
  expect(allow?.run).toBe('touch "$STREAM_DIRECTORY/start"');
  expect(allow?.['continue-on-error']).toBeUndefined();
  for (const earlier of [INITIAL_BOOTSTRAP, MIGRATE, CONTINUE_PUBLICATION, POST_MIGRATION_BOOTSTRAP]) {
    expect(indexOf(steps, earlier)).toBeLessThan(indexOf(steps, IMMUTABLE_UPLOAD));
  }
  expect(indexOf(steps, IMMUTABLE_UPLOAD)).toBeLessThan(indexOf(steps, SERVICE_GRANTS));
  expect(steps.filter(({ run }) => run?.includes('STREAM_DIRECTORY/start') === true).map(({ name }) => name)).toEqual([
    STREAM_START,
    IMMUTABLE_UPLOAD,
  ]);
});

it('keeps exact-published-revision outbox retries out of the schema migration and identity bootstrap lifecycle', () => {
  const { steps } = readJobs().release;
  const outboxRetry = 'Require the exact published revision for an outbox-only retry';
  const verifyRevision = steps.find(({ name }) => name === outboxRetry);
  expect(verifyRevision?.if).toBe('inputs.outbox_only');
  expect(verifyRevision?.['continue-on-error']).toBeUndefined();
  expect(verifyRevision?.run).toContain('"$published" != "$GITHUB_SHA"');
  expect(indexOf(steps, outboxRetry)).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, HOST_DEPLOY_JOIN)).toBeGreaterThan(indexOf(steps, outboxRetry));
  for (const name of [INITIAL_BOOTSTRAP, MIGRATE, POST_MIGRATION_BOOTSTRAP]) {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step?.if).toBe(
      { [INITIAL_BOOTSTRAP]: freshMigrationCondition, [MIGRATE]: fullDatabaseCondition }[name] ?? ownerVerifyCondition,
    );
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, outboxRetry));
  }
});

it('retains full native publication after the separately guarded completed-migration continuation', () => {
  const { steps } = readJobs().release;
  const continuationName = CONTINUE_PUBLICATION;
  const continuation = steps.find(({ name }) => name === continuationName);
  expect(continuation?.if).toBe('inputs.continue_migrated_publication && !inputs.outbox_only');
  expect(continuation?.['continue-on-error']).toBeUndefined();
  expect(continuation?.run).toBe('mise exec -- pnpm exec node scripts/stage-demo-migrate.mts --continue-publication');
  // The sealed chain ends with db:verify, so only a continuation or the light path verifies here.
  expect(steps.find((step) => step.name === POST_MIGRATION_BOOTSTRAP)?.if).toBe(ownerVerifyCondition);
  expect(steps.find((step) => step.name === PUBLICATION)?.if).toBe(fullPublicationCondition);
  for (const name of [POST_MIGRATION_BOOTSTRAP, PUBLICATION]) {
    expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, continuationName));
  }
});

it('migrates the Commerce portal realm with the runtime and administrator database pair', () => {
  const migrate = readJobs().release.steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.env).toEqual({
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: secretReference('DATABASE_ADMIN_URL'),
    COMMERCE_PORTAL_AUTH_DATABASE_URL: secretReference('DATABASE_URL'),
    RESUME_MIGRATED_REVISION: ['${{', 'steps.migration-readiness.outputs.resume-migrated-revision', '}}'].join(' '),
  });
  const verify = readJobs().release.steps.find(({ name }) => name === POST_MIGRATION_BOOTSTRAP);
  expect(verify?.env).toEqual({
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: secretReference('DATABASE_ADMIN_URL'),
    COMMERCE_PORTAL_AUTH_DATABASE_URL: secretReference('DATABASE_URL'),
  });
});

it('checks canonical recovery configuration before database mutation and provisions it before host deployment', () => {
  const { steps } = readJobs().release;
  const check = steps.find(({ name }) => name === RECOVERY_CONFIG_CHECK);
  const provision = steps.find(({ name }) => name === RECOVERY_CONFIG_APPLY);
  expect(check?.run?.split('\n').filter(Boolean)).toEqual([
    ...loadPreparedSecrets,
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts check',
  ]);
  expect(check?.env).toEqual({
    ALL_RELEASE_SECRETS_FILE: preparedFileReference,
    ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: ['${{', 'vars.ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID', '}}'].join(' '),
  });
  expect(provision?.env).toEqual(check?.env);
  const provisionLines = provision?.run?.split('\n').filter(Boolean) ?? [];
  // The host always redeploys after the apply, so a created or removed host secret always reaches it.
  expect(provisionLines).toEqual([
    ...loadPreparedSecrets,
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts apply',
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts verify',
  ]);
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, READINESS));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeGreaterThan(indexOf(steps, PUBLICATION));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeLessThan(indexOf(steps, HOST_DEPLOY_JOIN));
  for (const step of [check, provision]) {
    expect(step?.if).toBeUndefined();
    expect(step?.['continue-on-error']).toBeUndefined();
  }
});

it('runs this workflow test with the release script tests that gate the release job', () => {
  const tests = readJobs()['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true);
  for (const name of [
    'stage-demo-deploy-workflow',
    'deploy-plan',
    'release-stream',
    'materialize-zerops-environment',
    'rebrand-rental-demo',
    'prepare-stage-release-secrets',
    'stage-demo-migrate',
    'stage-deploy-diagnostics',
    'application-composition-authority-publication',
    'application-composition-release-lifecycle',
    'bootstrap-runtime-role',
    'database-login-roles',
    'enrollment-recovery-host-config',
    'typecheck-project-references',
    'reconcile-stage-service-grants',
    'verification-context',
    'mcp-proof-transport',
  ]) {
    expect(tests?.run).toContain(`scripts/tests/${name}.test.mts`);
  }
});

it.effect(
  'the actual workflow emits only an exact closed empty migrated retry target without authorizing publication',
  () =>
    Effect.scoped(
      Effect.gen(function* routesVerifiedSchemaRetry() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-schema-retry-gate-' });
        const step = readJobs().release.steps.find(({ name }) => name === READINESS);
        expect(step?.id).toBe('migration-readiness');
        const program = step?.run?.match(/<<'NODE'\n(?<program>[\s\S]+)\nNODE/u)?.groups?.program;
        expect(program).toBeDefined();
        const revision = 'a'.repeat(64);
        const observation = {
          advisoryOnly: true,
          authority: { durableWorkAdmission: 'closed', phase: 'migrated', revision },
          blockers: { deliveries: 0, durable: 0, messages: 0 },
          reason: 'replacement-publication-required',
          status: 'blocked',
        };
        const cases = [
          { document: observation, exitCode: 1, passes: true },
          { document: observation, exitCode: 130, passes: false },
          {
            document: { ...observation, authority: { ...observation.authority, durableWorkAdmission: 'open' } },
            exitCode: 1,
            passes: false,
          },
          {
            document: { ...observation, authority: { ...observation.authority, revision: 'untrusted\nrevision' } },
            exitCode: 1,
            passes: false,
          },
          {
            document: { ...observation, blockers: { ...observation.blockers, durable: 1 } },
            exitCode: 1,
            passes: false,
          },
        ];
        for (const [index, example] of cases.entries()) {
          const input = `${directory}/readiness-${index}.json`;
          const output = `${directory}/output-${index}`;
          yield* fs.writeFileString(input, `${JSON.stringify(example.document)}\n`);
          const outcome = yield* runCommand({
            args: ['--input-type=module', '-', input, String(example.exitCode)],
            command: 'node',
            cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
            env: { GITHUB_OUTPUT: Redacted.make(output) },
            stdin: Redacted.make(program ?? ''),
          }).pipe(Effect.exit);
          expect(Exit.isSuccess(outcome)).toBe(example.passes);
          expect(yield* fs.exists(output)).toBe(example.passes);
          if (example.passes) {
            expect(yield* fs.readFileString(output)).toBe(`resume-migrated-revision=${revision}\n`);
          }
        }
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

for (const example of [
  { exitCode: 0, passes: true, reason: 'drained', status: 'ready' },
  { exitCode: 1, passes: false, reason: 'drained', status: 'ready' },
  { exitCode: 1, passes: true, reason: 'pending-work', status: 'blocked' },
  { exitCode: 137, passes: false, reason: 'pending-work', status: 'blocked' },
  { exitCode: 1, passes: true, reason: 'authority-sealed', status: 'blocked' },
  { exitCode: 1, passes: true, reason: 'authority-missing', status: 'unknown' },
  { exitCode: 130, passes: false, reason: 'authority-missing', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'authority-expired', status: 'blocked' },
  { exitCode: 1, passes: false, reason: 'replacement-publication-required', status: 'blocked' },
  { exitCode: 1, passes: false, reason: 'diagnostic-timeout', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'diagnostic-unavailable', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'untrusted-reason', status: 'untrusted-status' },
]) {
  it.effect(
    `the actual workflow readiness gate handles ${example.status}/${example.reason}/exit-${example.exitCode}`,
    () =>
      Effect.scoped(
        Effect.gen(function* runWorkflowReadinessGate() {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-readiness-gate-' });
          const input = `${directory}/readiness.json`;
          const summary = `${directory}/summary.md`;
          yield* fs.writeFileString(
            input,
            `${JSON.stringify({ advisoryOnly: true, reason: example.reason, status: example.status })}\n`,
          );
          const step = readJobs().release.steps.find(({ name }) => name === READINESS);
          const program = step?.run?.match(/<<'NODE'\n(?<program>[\s\S]+)\nNODE/u)?.groups?.program;
          expect(program).toBeDefined();
          const outcome = yield* runCommand({
            args: ['--input-type=module', '-', input, String(example.exitCode)],
            command: 'node',
            cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
            env: { GITHUB_STEP_SUMMARY: Redacted.make(summary) },
            stdin: Redacted.make(program ?? ''),
          }).pipe(Effect.exit);
          expect(Exit.isSuccess(outcome)).toBe(example.passes);
          if (example.status === 'untrusted-status') {
            const rendered = yield* fs.readFileString(summary);
            expect(rendered).toContain('diagnostic-unavailable');
            expect(rendered).not.toContain('untrusted-');
            expect(rendered).not.toContain('migration authorized');
          } else {
            // The real CLI owns its complete summary; a valid record must not be rendered twice.
            expect(yield* fs.exists(summary)).toBe(false);
          }
        }),
      ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

it('publishes rebuilt contracts before replacing running demo processes, but starts new artifact endpoints first', () => {
  const script = readFileSync(new URL('../demo/rebuild-one.sh', import.meta.url), 'utf-8');
  const newUnits = script.indexOf('RUNNING_UNITS=()');
  const publish = script.indexOf('start composition');
  const ready = script.indexOf('wait_http "http://127.0.0.1:$COMPOSITION_PORT/active"');
  const replace = script.indexOf('for id in ${RUNNING_UNITS[@]+');
  expect(newUnits).toBeGreaterThan(0);
  expect(publish).toBeGreaterThan(newUnits);
  expect(ready).toBeGreaterThan(publish);
  expect(replace).toBeGreaterThan(ready);
  expect(script.slice(newUnits, publish)).toContain('start_unit "$id"');
  expect(script.slice(replace)).toContain('stop_pid "$id"\n  start_unit "$id"');
});

const sharedSourceFixture = Effect.gen(function* sharedSourceFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-shared-digest-' });
  for (const owner of ['core-runtime', 'shared-contracts']) {
    yield* fs.makeDirectory(`${root}/packages/${owner}/src`, { recursive: true });
    yield* fs.writeFileString(`${root}/packages/${owner}/package.json`, '{}');
    yield* fs.writeFileString(`${root}/packages/${owner}/src/index.ts`, ORIGINAL_SHARED_SOURCE);
  }
  return root;
});

it.effect('hashes shared build sources by exact content and path, without Git or output mtimes', () =>
  Effect.scoped(
    Effect.gen(function* checksSharedBuildDigest() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sharedSourceFixture;
      const original = yield* sharedBuildSourceDigest(root);
      expect(original).toMatch(/^[a-f0-9]{64}$/u);
      yield* fs.writeFileString(`${root}/packages/core-runtime/src/index.ts`, ORIGINAL_SHARED_SOURCE);
      expect(yield* sharedBuildSourceDigest(root)).toBe(original);
      yield* fs.makeDirectory(`${root}/packages/core-runtime/dist`);
      yield* fs.writeFileString(`${root}/packages/core-runtime/dist/ignored.js`, 'output is not source');
      expect(yield* sharedBuildSourceDigest(root)).toBe(original);
      yield* fs.writeFileString(`${root}/packages/shared-contracts/src/index.ts`, 'export const value = 2;');
      expect(yield* sharedBuildSourceDigest(root)).not.toBe(original);
      yield* fs.writeFileString(`${root}/packages/shared-contracts/src/index.ts`, ORIGINAL_SHARED_SOURCE);
      yield* fs.rename(`${root}/packages/core-runtime/src/index.ts`, `${root}/packages/core-runtime/src/renamed.ts`);
      expect(yield* sharedBuildSourceDigest(root)).not.toBe(original);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it('rejects missing or stale shared-source stamps before honoring DEMO_SKIP_BUILD', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const selection = script.slice(script.indexOf('needs_build()'), script.indexOf('# The package'));
  const digestCheck = selection.indexOf('cat "$dir/dist/.ontos-shared-source-digest"');
  const skip = selection.indexOf(['[ "$', '{DEMO_SKIP_BUILD:-0}" = 1 ]'].join(''));
  expect(digestCheck).toBeGreaterThan(0);
  expect(skip).toBeGreaterThan(digestCheck);
  expect(selection.slice(digestCheck, skip)).toContain('|| return 0');
  const nativeBuild = script.indexOf('exec sh -c "$script"');
  const stamp = script.indexOf('>"$(dir_of "$id")/dist/.ontos-shared-source-digest"');
  expect(stamp).toBeGreaterThan(nativeBuild);
  expect(script.slice(nativeBuild, stamp)).toContain('= "$SHARED_SOURCE_DIGEST" ] &&');
});

it('expands a requested owner refresh to every stale served shared-source consumer before taking locks', () => {
  const script = readFileSync(new URL('../demo/rebuild-one.sh', import.meta.url), 'utf-8');
  const staleConsumers = script.indexOf(['for id in shell-super-app "$', '{SERVED[@]}"'].join(''));
  const locks = script.indexOf('for id in $(printf');
  expect(staleConsumers).toBeGreaterThan(0);
  expect(locks).toBeGreaterThan(staleConsumers);
  expect(script.slice(staleConsumers, locks)).toContain('.ontos-shared-source-digest');
  expect(script.slice(staleConsumers, locks)).toContain('set -- "$@" "$id"');
  const build = script.indexOf('exec sh -c "$script"');
  const stamp = script.indexOf('>"$dist/.ontos-shared-source-digest"');
  expect(stamp).toBeGreaterThan(build);
  expect(script.slice(build, stamp)).toContain('refusing to stamp or restart mixed artifacts');
});

it.effect('a real MCP schema source change forces the native Bash build selector despite DEMO_SKIP_BUILD=1', () =>
  Effect.scoped(
    Effect.gen(function* executesSkipBuildRegression() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sharedSourceFixture;
      yield* fs.makeDirectory(`${root}/unit/dist`, { recursive: true });
      yield* fs.writeFileString(`${root}/unit/dist/contract.json`, '{}');
      const script = readFileSync(localBootstrapScript, 'utf-8');
      const selector = script.slice(script.indexOf('needs_build()'), script.indexOf('# The package'));
      const command = [
        'set -eu',
        'SHARED_SOURCE_DIGEST="$1"',
        'STAMP_DIR=stamps',
        'DEMO_SKIP_BUILD=1',
        'DEMO_REBUILD=0',
        'dir_of() { printf "%s" "$1"; }',
        'contract_of() { printf "%s/dist/contract.json" "$1"; }',
        selector,
        'if needs_build unit; then printf rebuild; else printf reuse; fi',
      ].join('\n');
      const select = (digest: string) =>
        runCommand({
          args: ['-c', command, 'demo-build-selector-test', digest],
          command: 'bash',
          cwd: root,
        });
      const original = yield* sharedBuildSourceDigest(root);
      expect(yield* select(original)).toBe('rebuild');
      yield* fs.writeFileString(`${root}/unit/dist/.ontos-shared-source-digest`, `${original}\n`);
      expect(yield* select(original)).toBe('reuse');
      yield* fs.writeFileString(
        `${root}/packages/core-runtime/src/index.ts`,
        'export const mcp = { recordLinks: true, agentAdministrationPage: true };',
      );
      const changed = yield* sharedBuildSourceDigest(root);
      expect(changed).not.toBe(original);
      expect(yield* select(changed)).toBe('rebuild');
    }),
  ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it('restarts Commerce for the direct demo newsletter without Privacy provisioning or copied catalog IDs', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const defaults = /^DEFAULT_VERTICALS="(?<owners>[^"]+)"/mu.exec(script)?.groups?.owners?.split(' ');
  expect(defaults).toContain('privacy');
  const portal = script.indexOf('step commerce-portal');
  const callbackReload = script.indexOf('ONTOS_PRIVACY_GATEWAY_API_KEY', portal);
  const shellRestart = script.indexOf('restart_server shell-super-app apps/shell-super-app', callbackReload);
  const commerceRestart = script.indexOf('restart_server commerce-customer-context', shellRestart);
  expect(portal).toBeGreaterThan(0);
  expect(callbackReload).toBeGreaterThan(portal);
  expect(shellRestart).toBeGreaterThan(callbackReload);
  expect(commerceRestart).toBeGreaterThan(shellRestart);
  expect(script).not.toContain('restart_server privacy verticals/privacy');
  expect(script).not.toContain('step privacy-marketing');
  expect(script).not.toContain('scripts/demo/privacy-marketing.mts');
  expect(script).not.toContain('reload_env_keys COMMERCE_MARKETING_PURPOSE_ID');
  expect(script).not.toContain('COMMERCE_MARKETING_NOTICE_VERSION_ID');
  expect(script.slice(commerceRestart)).toContain(
    'wait_http "http://127.0.0.1:$(port_of commerce-customer-context)/.well-known/ontos-module-manifest.json"',
  );
});

it.effect(
  'reloads only generated owner refs and callback credentials in real Bash without retaining removed values',
  () =>
    Effect.scoped(
      Effect.gen(function* reloadGeneratedConfiguration() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-privacy-config-' });
        yield* fs.writeFileString(
          `${root}/.env`,
          [
            'COMMERCE_MARKETING_PURPOSE_ID=current-owner-purpose',
            'ONTOS_PRIVACY_GATEWAY_API_KEY=current-callback',
            'UNRELATED_CONFIGURATION=file-value',
          ].join('\n'),
        );
        const script = readFileSync(localBootstrapScript, 'utf-8');
        const functions = script.slice(script.indexOf('load_env()'), script.indexOf('# Native release identity'));
        const command = [
          'set -euo pipefail',
          'APP="$1"',
          functions,
          'export COMMERCE_MARKETING_PURPOSE_ID=previous-purpose ONTOS_PRIVACY_GATEWAY_API_KEY=previous-callback',
          'export COMMERCE_MARKETING_NOTICE_ID=removed-notice UNRELATED_CONFIGURATION=operator-value',
          'load_env',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = previous-purpose ]',
          'reload_env_keys COMMERCE_MARKETING_PURPOSE_ID ONTOS_PRIVACY_GATEWAY_API_KEY COMMERCE_MARKETING_NOTICE_ID',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = current-owner-purpose ]',
          '[ "$ONTOS_PRIVACY_GATEWAY_API_KEY" = current-callback ]',
          ['[ -z "$', '{COMMERCE_MARKETING_NOTICE_ID+x}" ]'].join(''),
          '[ "$UNRELATED_CONFIGURATION" = operator-value ]',
          'reload_env_keys COMMERCE_MARKETING_PURPOSE_ID ONTOS_PRIVACY_GATEWAY_API_KEY',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = current-owner-purpose ]',
          '[ "$ONTOS_PRIVACY_GATEWAY_API_KEY" = current-callback ]',
          'printf verified',
        ].join('\n');
        expect(
          yield* runCommand({ args: ['-c', command, 'privacy-config-test', root], command: 'bash', cwd: root }),
        ).toBe('verified');
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it('keeps the real MCP propose/reject proof outside every customer demo tenant', () => {
  const proof = readJobs().verify.steps.find(({ run }) => run?.includes('prove-mcp-oauth.mts') === true);
  expect(proof?.run).toContain('--variant=1 --verification');
  expect(proof?.run).not.toContain('--variant=all');
  expect(proof?.run).not.toContain('--keep');
});

it('runs the existing newsletter browser proof after Chromium even if timing fails, but not on outbox-only retries', () => {
  const { verify } = readJobs();
  const { steps } = verify;
  const proofName = 'Prove the native newsletter grant and withdrawal';
  const proof = steps.find(({ name }) => name === proofName);
  const timingName = 'Time /cs, OAuth metadata and the storefront home';
  const timing = steps.find(({ name }) => name === timingName);
  const fixture = readJobs().release.steps.find(({ name }) => name === 'Prepare the native demo customer fixture');
  expect(fixture?.if).toBe(fullPublicationCondition);
  expect(proof?.if).toBe('(success() || failure()) && !inputs.outbox_only');
  expect(proof?.['continue-on-error']).toBeUndefined();
  expect(proof?.['working-directory']).toBe('app');
  expect(proof?.env).toEqual({
    AKROS_EVIDENCE_DIR: ['${{', RUNNER_TEMP_CONTEXT, '}}/newsletter-consent'].join(' '),
    AKROS_TEST_BASE_URL: ['${{', 'env.STAGE_STOREFRONT_URL', '}}'].join(' '),
  });
  const mcp = steps.find(({ name }) => name === 'Prove MCP over OAuth end to end');
  expect(proof?.run?.split('\n')[0]).toBe(mcp?.run?.split('\n')[0]);
  expect(proof?.run).toContain('export E2E_PLAYWRIGHT_MODULE');
  expect(proof?.run).toContain('mise exec -- node akros-storefront/tests/browser/newsletter-consent.mjs');
  expect(indexOf(steps, proofName)).toBeGreaterThan(
    indexOf(steps, 'Install headless Chromium for the OAuth consent screens'),
  );
  expect(indexOf(steps, proofName)).toBeGreaterThan(indexOf(steps, timingName));
  expect(timing?.run).toBe('mise exec -- node scripts/ops/stage-demo-verify.mjs');
  expect(timing?.['continue-on-error']).toBeUndefined();
  expect(timing?.env).toBeUndefined();
  expect(verify['timeout-minutes']).toBe(20);
});

it('uploads only runner-temp newsletter screenshots even when the browser proof fails', () => {
  const { steps } = readJobs().verify;
  const uploadName = 'Upload the newsletter screenshots';
  const upload = steps.find(({ name }) => name === uploadName);
  expect(upload?.if).toBe('always() && !inputs.outbox_only');
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@/u);
  expect(upload?.with).toEqual({
    'if-no-files-found': 'ignore',
    name: 'newsletter-consent',
    path: ['${{', RUNNER_TEMP_CONTEXT, '}}/newsletter-consent/*.png'].join(' '),
    'retention-days': 14,
  });
  expect(indexOf(steps, uploadName)).toBeGreaterThan(
    indexOf(steps, 'Prove the native newsletter grant and withdrawal'),
  );
});

it('reconciles service grants and the isolated verification context after migrations and before publication', () => {
  const { steps } = readJobs().release;
  const name = SERVICE_GRANTS;
  const reconcile = steps.find((step) => step.name === name);
  expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, MIGRATE));
  // The uploads stream beside the grants; nothing publishes before both finished.
  expect(indexOf(steps, name)).toBeLessThan(indexOf(steps, UPLOAD_JOIN));
  expect(indexOf(steps, name)).toBeLessThan(indexOf(steps, PUBLICATION));
  expect(reconcile?.if).toBeUndefined();
  expect(reconcile?.['continue-on-error']).toBeUndefined();
  expect(reconcile?.env?.ZEROPS_TOKEN).toBe(secretReference('ZEROPS_TOKEN'));
  expect(reconcile?.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN).toBe(secretReference('CLOUDFLARE_API_TOKEN'));
  expect(reconcile?.env?.BETTER_AUTH_URL).toBe(['${{', 'env.STAGE_SHELL_URL', '}}'].join(' '));
  // One --apply reads, writes only what is missing and reads back.
  expect(reconcile?.run?.match(/--zerops --(?:check|apply|verify)/gu)).toEqual(['--zerops --apply']);
  const script = readFileSync(new URL('../demo/reconcile-stage-service-grants.mts', import.meta.url), 'utf-8');
  const apply = script.indexOf("if (mode === 'apply') {");
  const native = script.indexOf('yield* reconcileStageServicePrincipals(stageServicePrincipals(), provider)', apply);
  const verification = script.indexOf('yield* ensureStageVerification(configuration)', apply);
  expect(native).toBeGreaterThan(apply);
  expect(verification).toBeGreaterThan(native);
  expect(script.indexOf('yield* reconcileStagePermissionSchema(rpc, mode)')).toBeLessThan(apply);
  expect(script).toContain("SPICEDB_ENDPOINT: 'spicedb:50051'");
  expect(script).toContain('...verificationGrants');
  const bootstrap = readFileSync(new URL('../demo/ensure-stage-verification.mts', import.meta.url), 'utf-8');
  expect(bootstrap).toContain('apps/shell-super-app/scripts/bootstrap-stage-accounts.mts');
  expect(bootstrap).toContain('mode: 0o600');
  expect(bootstrap).toContain('makeTempDirectoryScoped');
  expect(bootstrap).not.toContain('bootstrap-context.mts');
});

it('never extracts a secret into the step environment and masks its value before any command', () => {
  const reconcile = readJobs().release.steps.find(({ name }) => name === SERVICE_GRANTS);
  expect(reconcile?.env?.BETTER_AUTH_SECRET).toBeUndefined();
  expect(reconcile?.env?.ALL_RELEASE_SECRETS_FILE).toBe(preparedFileReference);
  expect(Object.values(reconcile?.env ?? {}).some((value) => value.includes('fromJSON'))).toBe(false);
  expect(reconcile?.run).toContain('echo "::add-mask::$BETTER_AUTH_SECRET"');
  expect(reconcile?.run).toContain('export BETTER_AUTH_SECRET');
  expect(reconcile?.run?.indexOf('::add-mask::')).toBeLessThan(reconcile?.run?.indexOf('mise exec') ?? 0);
});

it('publishes the cold-start composition before the sales reset discovers live Action ownership', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const ready = script.indexOf('wait_http "http://127.0.0.1:$COMPOSITION_PORT/active"');
  const sales = script.indexOf('step demo-reset-sales pnpm_ demo:reset:sales');
  const verify = script.indexOf('step db-verify pnpm_ db:verify');
  const worker = script.indexOf('start outbox-worker-host');
  expect(ready).toBeGreaterThan(0);
  expect(sales).toBeGreaterThan(ready);
  expect(verify).toBeGreaterThan(sales);
  expect(worker).toBeGreaterThan(sales);
  expect(script.lastIndexOf('step demo-reset-sales')).toBe(sales);
  expect(script.slice(ready, sales)).toContain(['[ "$', '{DEMO_RESET:-1}" != 0 ]'].join(''));
});

const PRUNE_STEP = 'Delete every unreferenced immutable Worker';
const PRUNE_JOB = 'prune-workers';
const PRUNER = 'scripts/ci/prune-immutable-workers.mts';

it('guards the account Worker limit after the release script tests and before any upload', () => {
  const { steps } = readJobs().release;
  const guard = steps.find(({ name }) => name === WORKER_GUARD);
  expect(guard?.if).toBe(fullPublicationCondition);
  expect(guard?.['continue-on-error']).toBeUndefined();
  expect(guard?.['working-directory']).toBe('app');
  // It reads the main deploy runs it must not race.
  expect(guard?.env?.GH_TOKEN).toBe(workflowExpression('github.token'));
  expect(guard?.run).toBe(
    `mise exec -- pnpm exec node ${PRUNER} guard --plan "$PLAN_FILE" --ledger-file "$LEDGER_DIRECTORY/stage-release-ledger.json"`,
  );
  expect(indexOf(steps, RELEASE_TESTS_BARRIER)).toBeLessThan(indexOf(steps, WORKER_GUARD));
  expect(indexOf(steps, 'Recompute the deploy plan at the clean checkout')).toBeLessThan(indexOf(steps, WORKER_GUARD));
  expect(indexOf(steps, WORKER_GUARD)).toBeLessThan(indexOf(steps, STREAM_START));
});

it('prunes unreferenced Workers only after a successful release, off the critical path and never rolling stage back', () => {
  const jobs = readJobs();
  const prune = jobs[PRUNE_JOB];
  expect(prune.needs).toEqual(['release']);
  const condition = prune.if?.replaceAll(/\s+/gu, ' ');
  expect(condition).toBe(
    "always() && !cancelled() && ((github.event_name == 'workflow_dispatch' && inputs.prune_workers_only) || (needs.release.result == 'success' && !inputs.outbox_only))",
  );
  // The environment of the release script tests: its secrets, without a deployment record.
  expect(prune.environment).toEqual(jobs['release-script-tests'].environment);
  expect(prune.permissions).toEqual({ actions: 'read', contents: 'read' });
  expect(prune.env?.CLOUDFLARE_API_TOKEN).toBe(secretReference('CLOUDFLARE_API_TOKEN'));
  expect(prune.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL).toBe(
    workflowExpression('vars.ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL'),
  );
  // Nothing in the release or its verification waits for the prune.
  expect(jobs.verify.needs).toEqual(['release']);
  expect(Object.values(jobs).some((job) => 'needs' in job && job.needs?.includes(PRUNE_JOB) === true)).toBe(false);
  const command = prune.steps.find(({ name }) => name === PRUNE_STEP);
  expect(command?.['continue-on-error']).toBeUndefined();
  expect(command?.run).toContain('args=(prune --apply --trusted-ledgers)');
  expect(command?.run).toContain('--ledger-file "$RUNNER_TEMP/stage-release-ledger/stage-release-ledger.json"');
  expect(command?.run).toContain(
    '--candidate-file "$RUNNER_TEMP/stage-demo-release/composition-candidate/active-application-composition-candidate.json"',
  );
  expect(command?.run).toContain(`mise exec -- pnpm exec node ${PRUNER} "\${args[@]}"`);
  // It downloads exactly what the release archives: its final ledger and its candidate.
  const archived = new Set(
    jobs.release.steps.flatMap(({ uses, with: inputs }) =>
      uses?.startsWith('actions/upload-artifact@') === true && inputs?.name !== undefined ? [inputs.name] : [],
    ),
  );
  const downloads = prune.steps.filter(({ uses }) => uses?.startsWith('actions/download-artifact@') === true);
  expect(downloads).toHaveLength(2);
  for (const download of downloads) {
    expect(archived.has(download.with?.name ?? '')).toBe(true);
    expect(download.if).toBe("env.PRUNE_ONLY != 'true'");
    expect(indexOf(prune.steps, download.name)).toBeLessThan(indexOf(prune.steps, PRUNE_STEP));
  }
});

it('runs only the prune on a prune_workers_only dispatch', () => {
  const InputsSchema = Schema.Struct({
    on: Schema.Struct({
      workflow_dispatch: Schema.Struct({
        inputs: Schema.Struct({
          prune_workers_only: Schema.Struct({ default: Schema.Boolean, type: Schema.String }),
        }),
      }),
    }),
  });
  const { on } = Schema.decodeUnknownSync(InputsSchema)(parse(readFileSync(STAGE_DEMO_WORKFLOW, 'utf-8')));
  expect(on.workflow_dispatch.inputs.prune_workers_only).toMatchObject({ default: false, type: 'boolean' });
  const jobs = readJobs();
  for (const entry of [jobs.plan.if, jobs['release-script-tests'].if]) {
    expect(entry).toContain(
      "github.event_name == 'workflow_dispatch' && !inputs.outbox_only && !inputs.prune_workers_only && inputs.profile_recovery_mode == 'none'",
    );
  }
  // The release otherwise only runs on its plan or an outbox-only retry, and the builds only on the plan.
  expect(jobs.release.if).toContain(
    "inputs.outbox_only && inputs.profile_recovery_mode == 'none' && !inputs.prune_workers_only",
  );
  expect(jobs.release.needs).toEqual(['plan']);
  expect(jobs[PRUNE_JOB].env?.PRUNE_ONLY).toBe(
    workflowExpression("github.event_name == 'workflow_dispatch' && inputs.prune_workers_only"),
  );
  expect(jobs[PRUNE_JOB].steps.find(({ name }) => name === PRUNE_STEP)?.run).toContain('--time-budget-seconds 5400');
});

type ExpressionValue = boolean | string | null;

const truthy = (value: ExpressionValue) => value !== null && value !== false && value !== '';

/** The expression split at every `operator` outside parentheses and string literals. */
const splitTopLevel = (source: string, operator: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted && char === '(') {
      depth += 1;
    } else if (!quoted && char === ')') {
      depth -= 1;
    } else if (!quoted && depth === 0 && source.startsWith(operator, index)) {
      parts.push(source.slice(start, index));
      start = index + operator.length;
    }
    index = Math.max(index + 1, start);
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim());
};

/** Whether the whole expression is one parenthesized expression. */
const parenthesized = (source: string) => {
  let depth = 0;
  let quoted = false;
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted && char === '(') {
      depth += 1;
    } else if (!quoted && char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index === source.length - 1 && source.startsWith('(');
      }
    }
    index += 1;
  }
  return false;
};

const STATUS_FUNCTIONS = ['always()', 'cancelled()', 'failure()', 'success()'];

/**
 * Evaluates the subset of GitHub Actions expressions the job conditions use: `!`, `&&`, `||`, `==`, `!=`, parentheses,
 * string literals, context paths and the status functions. `success()` is whether every needed job succeeded.
 */
const evaluateCondition = (
  source: string,
  lookup: (reference: string) => ExpressionValue,
  needsSucceeded: boolean,
): ExpressionValue => {
  const expression = source.trim();
  const evaluate = (part: string) => evaluateCondition(part, lookup, needsSucceeded);
  const alternatives = splitTopLevel(expression, '||');
  if (alternatives.length > 1) {
    return alternatives.some((part) => truthy(evaluate(part)));
  }
  const conjuncts = splitTopLevel(expression, '&&');
  if (conjuncts.length > 1) {
    return conjuncts.every((part) => truthy(evaluate(part)));
  }
  if (parenthesized(expression)) {
    return evaluate(expression.slice(1, -1));
  }
  for (const operator of ['==', '!=']) {
    const [left, right, ...rest] = splitTopLevel(expression, operator);
    if (right !== undefined && rest.length === 0) {
      return (evaluate(left ?? '') === evaluate(right)) === (operator === '==');
    }
  }
  if (expression.startsWith('!')) {
    return !truthy(evaluate(expression.slice(1)));
  }
  if (expression.startsWith("'")) {
    return expression.slice(1, -1);
  }
  if (STATUS_FUNCTIONS.includes(expression)) {
    return expression === 'always()' || (expression === 'success()' && needsSucceeded);
  }
  return expression === 'true' || (expression !== 'false' && lookup(expression));
};

/** The outputs of a succeeded job: the plan builds every kind of unit. */
const JOB_OUTPUTS = new Map([
  [
    'plan',
    new Map([
      ['build_count', '1'],
      ['host_mode', 'build'],
      ['storefront_mode', 'build'],
    ]),
  ],
]);

/** The jobs a workflow event runs, every run job succeeding, as GitHub schedules them (needs before dependents). */
const scheduledJobs = (event: {
  readonly inputs: Readonly<Record<string, ExpressionValue>>;
  readonly name: string;
}) => {
  const RawJobsSchema = Schema.Struct({
    jobs: Schema.Record(
      Schema.String,
      Schema.Struct({ if: Schema.optionalKey(Schema.String), needs: Schema.optionalKey(Schema.Array(Schema.String)) }),
    ),
  });
  const { jobs } = Schema.decodeUnknownSync(RawJobsSchema)(parse(readFileSync(STAGE_DEMO_WORKFLOW, 'utf-8')));
  const results = new Map<string, 'skipped' | 'success'>();
  // Skipped jobs have no outputs; of the repository variables only the deploy switch is on.
  const lookup = (reference: string): ExpressionValue => {
    const [context, name = '', field, output = ''] = reference.split('.');
    if (context === 'github') {
      return name === 'event_name' ? event.name : null;
    }
    if (context === 'inputs') {
      return event.inputs[name] ?? null;
    }
    if (context === 'vars') {
      return name === 'STAGE_DEMO_CI_DEPLOY' ? 'true' : null;
    }
    if (context === 'needs' && field === 'result') {
      return results.get(name) ?? null;
    }
    return results.get(name) === 'success' ? (JOB_OUTPUTS.get(name)?.get(output) ?? null) : null;
  };
  const settle = (id: string): 'skipped' | 'success' => {
    const settled = results.get(id);
    if (settled !== undefined) {
      return settled;
    }
    const job = jobs[id];
    const needsSucceeded = (job?.needs ?? []).every((need) => settle(need) === 'success');
    const condition = (job?.if ?? 'success()').replace(/^\$\{\{(?<body>[\s\S]*)\}\}$/u, '$<body>');
    // Without a status function a condition also requires every needed job to succeed.
    const statusChecked = STATUS_FUNCTIONS.some((status) => condition.includes(status));
    const runs = (statusChecked || needsSucceeded) && evaluateCondition(condition, lookup, needsSucceeded) === true;
    const result = runs ? 'success' : 'skipped';
    results.set(id, result);
    return result;
  };
  return Object.keys(jobs).filter((id) => settle(id) === 'success');
};

const DISPATCH_DEFAULTS = {
  continue_migrated_publication: false,
  deploy: false,
  force_full: false,
  outbox_only: false,
  profile_recovery_mode: 'none',
  prune_workers_only: false,
} as const;
const dispatch = (inputs: Partial<Record<keyof typeof DISPATCH_DEFAULTS, ExpressionValue>>) => ({
  inputs: { ...DISPATCH_DEFAULTS, ...inputs },
  name: 'workflow_dispatch',
});

it('runs no job but the prune on a prune_workers_only dispatch, whatever other mode it also asks for', () => {
  for (const conflict of [
    {},
    { deploy: true },
    { force_full: true },
    { outbox_only: true },
    { continue_migrated_publication: true },
    { profile_recovery_mode: 'check' },
    { profile_recovery_mode: 'reconcile' },
  ]) {
    expect(scheduledJobs(dispatch({ ...conflict, prune_workers_only: true }))).toEqual([PRUNE_JOB]);
  }
  // Its first step refuses every conflicting mode, before anything is installed or read.
  const [isolation] = readJobs()[PRUNE_JOB].steps;
  expect(isolation?.name).toBe('Require an isolated prune request');
  expect(isolation?.if).toBe("env.PRUNE_ONLY == 'true'");
  for (const input of [
    'deploy',
    'force_full',
    'outbox_only',
    'continue_migrated_publication',
    'profile_recovery_mode',
  ]) {
    expect(Object.values(isolation?.env ?? {})).toContain(workflowExpression(`inputs.${input}`));
  }
  expect(isolation?.run).toContain('"$RECOVERY_MODE" != none');
});

it('prunes after every release that published, and never beside an outbox retry or a recovery', () => {
  const deployed = ['plan', 'build', 'build-outbox-host', 'release-script-tests', 'build-storefront', 'release'];
  expect(scheduledJobs({ inputs: {}, name: 'push' })).toEqual([...deployed, PRUNE_JOB, 'verify']);
  expect(scheduledJobs(dispatch({ deploy: true }))).toEqual([...deployed, PRUNE_JOB, 'verify']);
  expect(scheduledJobs(dispatch({ outbox_only: true }))).toEqual(['release', 'verify']);
  expect(scheduledJobs(dispatch({ profile_recovery_mode: 'reconcile' }))).toEqual(['profile-recovery']);
});

it('tests the pruner and the provider failure parser with the release scripts', () => {
  const tests = readJobs()['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true);
  expect(tests?.run).toContain('scripts/tests/prune-immutable-workers.test.mts');
  expect(tests?.run).toContain('scripts/tests/ops-shell.test.mts');
});
