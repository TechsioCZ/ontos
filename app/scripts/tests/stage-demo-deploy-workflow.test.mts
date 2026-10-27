import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { ApplicationReleaseIntentSchema } from '../application-release-intent.mts';
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
      name: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    }),
  ),
  'working-directory': Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  env: Schema.Record(Schema.String, Schema.String),
  jobs: Schema.Struct({
    build: Schema.Struct({ needs: Schema.Array(Schema.String), steps: Schema.Array(StepSchema) }),
    'build-storefront': Schema.Struct({ needs: Schema.Array(Schema.String) }),
    'profile-recovery': Schema.Struct({ if: Schema.String, steps: Schema.Array(StepSchema) }),
    release: Schema.Struct({ steps: Schema.Array(StepSchema) }),
    'release-script-tests': Schema.Struct({
      environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
      steps: Schema.Array(StepSchema),
    }),
    verify: Schema.Struct({ steps: Schema.Array(StepSchema), 'timeout-minutes': Schema.Number }),
  }),
});
const readWorkflow = () =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url), 'utf-8')),
  );
const readJobs = () => readWorkflow().jobs;

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
const loadPreparedSecrets = [
  'ALL_RELEASE_SECRETS="$(cat -- "$ALL_RELEASE_SECRETS_FILE")"',
  'export ALL_RELEASE_SECRETS',
];
const RELEASE_SECRET_CHECK = 'Validate the complete immutable release secret inventory';
const SERVICE_GRANTS = 'Reconcile storefront, Commerce and Privacy service grants';
const IMMUTABLE_UPLOAD = 'Upload every immutable release Worker';
const PUBLICATION = 'Publish the Application Composition';
const fullPublicationCondition = ['${{', '!inputs.outbox_only', '}}'].join(' ');
const freshMigrationCondition = ['${{', '!inputs.outbox_only && !inputs.continue_migrated_publication', '}}'].join(' ');
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

it('checks the protected release secret inventory before builds without creating a deployment or retaining a bundle', () => {
  const jobs = readJobs();
  const checks = jobs['release-script-tests'];
  expect(checks.environment).toEqual({ deployment: false, name: 'stage-edge' });
  expect(jobs.build.needs).toContain('release-script-tests');
  expect(jobs['build-storefront'].needs).toContain('release-script-tests');
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
  expect(checks.steps.some(({ uses }) => uses?.startsWith('actions/upload-artifact@') === true)).toBe(false);
});

// Deliberately bounded to the conditions used by the producer and its file consumers.
// An unfamiliar condition fails this test model instead of being treated as unreachable.
const secretStepRuns = (condition: string | undefined, outboxOnly: boolean, precedingSuccess: boolean) => {
  const expression = condition?.replace('${{', '').replace('}}', '').trim() ?? 'success()';
  if (expression === '!inputs.outbox_only') {
    return precedingSuccess && !outboxOnly;
  }
  if (expression === 'always()') {
    return true;
  }
  expect(expression).toBe('success()');
  return precedingSuccess;
};
const secretFileSafetyViolations = (steps: readonly (typeof StepSchema.Type)[]) => {
  const violations: string[] = [];
  const producer = steps.find(({ name }) => name === PREPARE_SECRETS);
  const producerIndex = indexOf(steps, PREPARE_SECRETS);
  for (const outboxOnly of [false, true]) {
    for (const producerSucceeds of [false, true]) {
      const producerRuns = producer !== undefined && secretStepRuns(producer.if, outboxOnly, true);
      const fileAvailable = producerRuns && producerSucceeds;
      const precedingSuccess = !producerRuns || producerSucceeds || producer?.['continue-on-error'] === true;
      for (const consumer of steps.filter(({ env }) => env?.ALL_RELEASE_SECRETS_FILE !== undefined)) {
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
  const consumers = steps.filter(({ env }) => env?.ALL_RELEASE_SECRETS_FILE !== undefined);
  expect(consumers.map(({ name }) => name)).toEqual([
    RELEASE_SECRET_CHECK,
    RECOVERY_CONFIG_CHECK,
    SERVICE_GRANTS,
    IMMUTABLE_UPLOAD,
    'Activate the Shell ingress',
    RECOVERY_CONFIG_APPLY,
  ]);
  for (const step of consumers) {
    expect(step.env?.ALL_RELEASE_SECRETS_FILE).toBe(preparedFileReference);
    expect(step.env?.ALL_RELEASE_SECRETS).toBeUndefined();
    expect(step.run).toContain('ALL_RELEASE_SECRETS_FILE');
    expect(indexOf(steps, step.name)).toBeGreaterThan(indexOf(steps, PREPARE_SECRETS));
  }
  expect(steps.filter(({ env }) => env?.ALL_RELEASE_SECRETS !== undefined)).toEqual([prepare]);
  expect(cleanup?.if).toBe(SECRET_CLEANUP_CONDITION);
  expect(indexOf(steps, CLEANUP_SECRETS)).toBe(steps.length - 1);
  for (const step of steps.filter(({ uses }) => uses?.startsWith('actions/upload-artifact@') === true)) {
    expect(step.with?.path).not.toContain('stage-release-secrets');
    expect(step.with?.path).not.toContain('steps.release-secrets.outputs');
    expect(step.with?.path).not.toBe(['${{', RUNNER_TEMP_CONTEXT, '}}'].join(' '));
  }
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
  expect(indexOf(steps, RELEASE_SECRET_CHECK)).toBeGreaterThan(indexOf(steps, 'Install the app workspace'));
  for (const later of [
    'Connect the runner to the private Zerops database network',
    RECOVERY_CONFIG_CHECK,
    READINESS,
    INITIAL_BOOTSTRAP,
    MIGRATE,
    'Continue publication of the completed owner migration',
    SERVICE_GRANTS,
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

for (const encoded of ['{}', '{"projects":null}', `{"${SYNTHETIC_SECRET}":`]) {
  it.effect(`the actual uploader records a name-only error before a missing owner can silently exit: ${encoded}`, () =>
    Effect.scoped(
      Effect.gen(function* checksUploadConfigurationFailure() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-upload-secret-failure-' });
        const upload = readJobs().release.steps.find(({ name }) => name === IMMUTABLE_UPLOAD);
        const setup = upload?.run?.split('export -f upload')[0];
        expect(setup).toBeDefined();
        const bundleFile = `${root}/bundle.json`;
        yield* fs.writeFileString(bundleFile, encoded);
        const status = yield* runCommand({
          args: [
            '-euo',
            'pipefail',
            '-c',
            `${setup}\nstatus=0\nupload projects verticals/projects >"$RUNNER_TEMP/output.log" 2>&1 || status=$?\nprintf "%s" "$status"`,
          ],
          command: 'bash',
          env: {
            ALL_RELEASE_SECRETS_FILE: Redacted.make(bundleFile),
            RECEIPTS: Redacted.make(`${root}/receipts`),
            RUNNER_TEMP: Redacted.make(root),
          },
        });
        expect(status).toBe('1');
        const log = yield* fs.readFileString(`${root}/upload-logs/projects.log`);
        expect(log).toContain('projects has no valid owner secret object; upload not started');
        expect(log).not.toContain(SYNTHETIC_SECRET);
        expect(yield* fs.readFileString(`${root}/output.log`)).toBe(log);
        expect(yield* fs.exists(`${root}/receipts/projects.json`)).toBe(false);
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

it('builds each unit reference graph before the native Cloudflare build on a fresh runner', () => {
  const { steps } = readJobs().build;
  const producerName = 'Build the unit typecheck reference graph';
  const producer = steps.find(({ name }) => name === producerName);
  expect(producer?.run).toBe(
    'mise exec -- pnpm exec ultramodern-create ultramodern typecheck --build "$UNIT_PATH/tsconfig.json"',
  );
  expect(producer?.['working-directory']).toBe('app');
  expect(producer?.if).toBeUndefined();
  expect(producer?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, producerName)).toBeGreaterThan(indexOf(steps, 'Install the app workspace'));
  expect(indexOf(steps, 'Build and verify the unit for Cloudflare')).toBeGreaterThan(indexOf(steps, producerName));
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
  // Fresh releases migrate; the guarded continuation publishes an already completed migration.
  expect(migrate?.if).toBe(freshMigrationCondition);
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
  for (const later of [IMMUTABLE_UPLOAD, PUBLICATION, 'Activate the Shell ingress', 'Deploy the AKROS storefront']) {
    expect(indexOf(steps, later)).toBeGreaterThan(indexOf(steps, MIGRATE));
  }
});

it('keeps exact-published-revision outbox retries out of the schema migration and identity bootstrap lifecycle', () => {
  const { steps } = readJobs().release;
  const outboxRetry = 'Require the exact published revision for an outbox-only retry';
  const verifyRevision = steps.find(({ name }) => name === outboxRetry);
  expect(verifyRevision?.if).toBe('inputs.outbox_only');
  expect(verifyRevision?.['continue-on-error']).toBeUndefined();
  expect(verifyRevision?.run).toContain('"$published" != "$GITHUB_SHA"');
  expect(indexOf(steps, outboxRetry)).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, 'Push the outbox worker host')).toBeGreaterThan(indexOf(steps, outboxRetry));
  for (const name of [INITIAL_BOOTSTRAP, MIGRATE, POST_MIGRATION_BOOTSTRAP]) {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step?.if).toBe(name === POST_MIGRATION_BOOTSTRAP ? fullPublicationCondition : freshMigrationCondition);
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, outboxRetry));
  }
});

it('retains full native publication after the separately guarded completed-migration continuation', () => {
  const { steps } = readJobs().release;
  const continuationName = 'Continue publication of the completed owner migration';
  const continuation = steps.find(({ name }) => name === continuationName);
  expect(continuation?.if).toBe('inputs.continue_migrated_publication && !inputs.outbox_only');
  expect(continuation?.['continue-on-error']).toBeUndefined();
  expect(continuation?.run).toBe('mise exec -- pnpm exec node scripts/stage-demo-migrate.mts --continue-publication');
  for (const name of [POST_MIGRATION_BOOTSTRAP, PUBLICATION]) {
    expect(steps.find((step) => step.name === name)?.if).toBe(fullPublicationCondition);
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
    ZEROPS_MIGRATOR_SERVICE_ID: ['${{', 'vars.ZEROPS_MIGRATOR_SERVICE_ID', '}}'].join(' '),
    ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: ['${{', 'vars.ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID', '}}'].join(' '),
  });
  expect(provision?.env).toEqual(check?.env);
  expect(provision?.run?.split('\n').filter(Boolean)).toEqual([
    ...loadPreparedSecrets,
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts apply',
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts verify',
  ]);
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, READINESS));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeGreaterThan(indexOf(steps, PUBLICATION));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeLessThan(indexOf(steps, 'Push the outbox worker host'));
  for (const step of [check, provision]) {
    expect(step?.if).toBeUndefined();
    expect(step?.['continue-on-error']).toBeUndefined();
  }
});

it('runs this workflow test with the release script tests that gate the release job', () => {
  const tests = readJobs()['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true);
  for (const name of [
    'stage-demo-deploy-workflow',
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
  expect(indexOf(steps, name)).toBeLessThan(indexOf(steps, IMMUTABLE_UPLOAD));
  expect(reconcile?.if).toBeUndefined();
  expect(reconcile?.['continue-on-error']).toBeUndefined();
  expect(reconcile?.env?.ZEROPS_TOKEN).toBe(secretReference('ZEROPS_TOKEN'));
  expect(reconcile?.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN).toBe(secretReference('CLOUDFLARE_API_TOKEN'));
  expect(reconcile?.env?.BETTER_AUTH_URL).toBe(['${{', 'env.STAGE_SHELL_URL', '}}'].join(' '));
  expect(reconcile?.run?.match(/--zerops --(?:check|apply|verify)/gu)).toEqual([
    '--zerops --check',
    '--zerops --apply',
    '--zerops --verify',
  ]);
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
