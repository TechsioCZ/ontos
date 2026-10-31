import { NodeServices } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

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
