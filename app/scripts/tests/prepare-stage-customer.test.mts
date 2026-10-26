import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/unstable/process';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const script = new URL('../demo/prepare-stage-customer.mts', import.meta.url).pathname;
const privateInput = 'operator-input-that-must-not-be-printed';

it.effect('refuses a non-stage invocation before parsing the database identity or starting registration', () =>
  Effect.scoped(
    Effect.gen(function* refusesNonStagePreparation() {
      const child = yield* ChildProcess.make(process.execPath, [script], {
        cwd: new URL('../..', import.meta.url).pathname,
        env: {
          APP_ENV_PATH: '/dev/null',
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: privateInput,
          DOTENV_CONFIG_PATH: '/dev/null',
          TMPDIR: '/Volumes/DevWork/agent-scratch',
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production',
        },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const result = yield* Effect.all(
        {
          code: child.exitCode,
          stderr: child.stderr.pipe(Stream.decodeText, Stream.runCollect),
          stdout: child.stdout.pipe(Stream.decodeText, Stream.runCollect),
        },
        { concurrency: 'unbounded' },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr.join('')).toContain('stage_environment_required');
      expect(result.stderr.join('')).not.toContain(privateInput);
      expect(result.stdout.join('')).not.toContain(privateInput);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('reports an invalid stage operator identity without printing its input or attempting enrollment', () =>
  Effect.scoped(
    Effect.gen(function* refusesInvalidOperatorIdentity() {
      const child = yield* ChildProcess.make(process.execPath, [script], {
        cwd: new URL('../..', import.meta.url).pathname,
        env: {
          APP_ENV_PATH: '/dev/null',
          COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: privateInput,
          DOTENV_CONFIG_PATH: '/dev/null',
          TMPDIR: '/Volumes/DevWork/agent-scratch',
          ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
        },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      });
      const result = yield* Effect.all(
        {
          code: child.exitCode,
          stderr: child.stderr.pipe(Stream.decodeText, Stream.runCollect),
          stdout: child.stdout.pipe(Stream.decodeText, Stream.runCollect),
        },
        { concurrency: 'unbounded' },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr.join('')).toContain('operator_database_configuration_invalid');
      expect(result.stderr.join('')).not.toContain(privateInput);
      expect(result.stdout.join('')).not.toContain(privateInput);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const Step = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
});
const Workflow = Schema.Struct({ jobs: Schema.Struct({ release: Schema.Struct({ steps: Schema.Array(Step) }) }) });

it.effect('prepares the single native fixture only after publication, host readiness and the storefront rollout', () =>
  Effect.gen(function* verifiesFixturePublicationBoundary() {
    const fs = yield* FileSystem.FileSystem;
    const workflow = Schema.decodeUnknownSync(Workflow)(
      parse(
        yield* fs.readFileString(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url).pathname),
      ),
    );
    const { steps } = workflow.jobs.release;
    const index = (name: string) => {
      const found = steps.findIndex((step) => step.name === name);
      expect(found).toBeGreaterThanOrEqual(0);
      return found;
    };
    const fixtureIndex = index('Prepare the native demo customer fixture');
    const fixture = steps[fixtureIndex];
    expect(fixtureIndex).toBeGreaterThan(index('Publish the Application Composition'));
    expect(fixtureIndex).toBeGreaterThan(index('Require the new host to admit the published composition'));
    expect(fixtureIndex).toBeGreaterThan(index('Deploy the AKROS storefront'));
    expect(fixtureIndex).toBeLessThan(index('Smoke the Shell login and OAuth metadata'));
    expect(fixture?.if).toBe(['${{', '!inputs.outbox_only', '}}'].join(' '));
    expect(fixture?.env?.ULTRAMODERN_DEPLOYMENT_ENVIRONMENT).toBe('stage');
    expect(fixture?.env?.COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL).toBe(
      ['${{', 'secrets.DATABASE_ADMIN_URL', '}}'].join(' '),
    );
    expect(fixture?.run).toBe('mise exec -- pnpm exec node scripts/demo/prepare-stage-customer.mts');
  }).pipe(Effect.provide(NodeServices.layer)),
);
