/// <reference types="node" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Console, Effect, Exit, Option, Schema, Stdio } from 'effect';
import type { Scope } from 'effect';
import { NodeServices } from '@effect/platform-node';

import { loadOptionalCommercePortalAuthDatabaseConfig } from '../verticals/commerce-customer-context/scripts/portal-auth-database-config.mts';

/**
 * The Commerce portal authentication realm owns its own Drizzle configuration, migration journal
 * and runtime role. It is optional: a workspace that supplied no `COMMERCE_PORTAL_AUTH_DATABASE_*`
 * pair has no `commerce_auth` schema to generate, check or migrate, and every root aggregator must
 * stay green there. This runner is what the root `db:generate`, `db:check` and `db:migrate` chains
 * call so the realm is included exactly the way `scripts/run-zerops-migrator.mjs` includes it on a
 * deployment: the optional configuration is validated once, up front, and each ordered step runs
 * only when the owner opted in.
 */
const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const verticalDirectory = path.join(appDirectory, 'verticals', 'commerce-customer-context');
const PORTAL_AUTH_DRIZZLE_CONFIG = 'drizzle.portal-auth.config.ts';

const { spawn } = process.getBuiltinModule('node:child_process');

const STEPS = ['check', 'generate', 'migrate'] as const;
const StepSchema = Schema.Literals(STEPS);
type Step = typeof StepSchema.Type;

class CommercePortalAuthDatabaseStepError extends Schema.TaggedError<CommercePortalAuthDatabaseStepError>()(
  'CommercePortalAuthDatabaseStepError',
  { reason: Schema.String },
) {}

const stepFailure = (reason: string, cause?: unknown): CommercePortalAuthDatabaseStepError =>
  Object.defineProperty(new CommercePortalAuthDatabaseStepError({ reason }), 'cause', {
    configurable: true,
    value: cause,
  });

const run = Effect.fn('runOptionalCommercePortalAuthDb.run')(function* runEffect(
  command: string,
  commandArguments: readonly string[],
  workingDirectory: string,
): Effect.fn.Return<void, CommercePortalAuthDatabaseStepError, Scope.Scope> {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      catch: (cause) => stepFailure(`${command} failed to start`, cause),
      try: () => spawn(command, [...commandArguments], { cwd: workingDirectory, stdio: 'inherit' }),
    }),
    (spawned) =>
      Effect.sync(() => {
        if (spawned.exitCode === null && !spawned.killed) {
          spawned.kill('SIGTERM');
        }
      }),
  );

  yield* Effect.callback<boolean, CommercePortalAuthDatabaseStepError>((resume) => {
    const onError = (cause: Error) => {
      resume(Effect.fail(stepFailure(`${command} failed while running`, cause)));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const outcome = signal ?? `code ${String(code)}`;
      resume(code === 0 ? Effect.succeed(true) : Effect.fail(stepFailure(`${command} exited with ${outcome}`)));
    };

    child.once('error', onError);
    child.once('exit', onExit);
    return Effect.sync(() => {
      child.off('error', onError);
      child.off('exit', onExit);
    });
  });
});

const drizzleKit = (...commandArguments: readonly string[]) =>
  run(path.join(verticalDirectory, 'node_modules', '.bin', 'drizzle-kit'), commandArguments, verticalDirectory);

const ownerScript = (relativePath: string) =>
  run(process.execPath, [path.join(verticalDirectory, relativePath)], appDirectory);

/** Ordered exactly as the deployment migrator runs them: migrate, grant, then verify. */
const runStep = (step: Step): Effect.Effect<void, CommercePortalAuthDatabaseStepError, Scope.Scope> =>
  Effect.gen(function* runStepEffect() {
    if (step === 'check') {
      return yield* drizzleKit('check', '--config', PORTAL_AUTH_DRIZZLE_CONFIG);
    }
    if (step === 'generate') {
      return yield* drizzleKit('generate', '--config', PORTAL_AUTH_DRIZZLE_CONFIG);
    }
    yield* drizzleKit('migrate', '--config', PORTAL_AUTH_DRIZZLE_CONFIG);
    yield* ownerScript(path.join('scripts', 'bootstrap-portal-auth-runtime-role.mts'));
    return yield* ownerScript(path.join('scripts', 'verify-portal-auth-db-schema.mts'));
  });

const main = Effect.scoped(
  Effect.gen(function* runOptionalCommercePortalAuthDatabaseStep() {
    const stdio = yield* Stdio.Stdio;
    const [requestedStep] = yield* stdio.args;
    const step = yield* Schema.decodeUnknownEffect(StepSchema)(requestedStep).pipe(
      Effect.mapError(() =>
        stepFailure(`Expected one of ${STEPS.join(', ')}; received ${requestedStep ?? '<nothing>'}`),
      ),
    );
    const configuration = yield* loadOptionalCommercePortalAuthDatabaseConfig().pipe(
      Effect.mapError((failure) => stepFailure(failure.reason)),
    );
    if (Option.isNone(configuration)) {
      return yield* Console.log(
        `Commerce portal authentication realm is not configured; skipping db:portal-auth:${step}`,
      );
    }
    return yield* runStep(step);
  }).pipe(Effect.tapError((failure) => Console.error(failure.reason))),
);

const exit = await Effect.runPromiseExit(main.pipe(Effect.provide(NodeServices.layer)));
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
