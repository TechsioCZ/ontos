/// <reference types="node" />

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cause, Config, Effect, Exit } from 'effect';

const appDirectory = fileURLToPath(new URL('../', import.meta.url));
const { spawn } = process.getBuiltinModule('node:child_process');
const migratorPort = Config.int('MIGRATOR_PORT').pipe(Config.withDefault(8080));

class MigratorError extends Error {
  /**
   * @param {string} message - Description of the failed migrator operation.
   * @param {unknown} [cause] - Underlying platform failure, when available.
   */
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'MigratorError';
  }
}

/** @param {ReturnType<typeof spawn>} child - Child process owned by the Effect scope. */
const stopChild = (child) =>
  Effect.sync(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
    }
  });

const run = Effect.fn('run')(
  /**
   * @param {string} command - Executable to start.
   * @param {readonly string[]} commandArguments - Arguments passed to the executable.
   * @param {string} cwd - Working directory for the child process.
   * @yields {unknown} Effect instructions interpreted by `Effect.fn`.
   */
  function* runEffect(command, commandArguments, cwd = appDirectory) {
    const child = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => new MigratorError(`${command} failed to start`, cause),
        try: () => spawn(command, commandArguments, { cwd, stdio: 'inherit' }),
      }),
      stopChild,
    );

    yield* Effect.callback((resume) => {
      const onError = (cause) => {
        resume(Effect.fail(new MigratorError(`${command} failed while running`, cause)));
      };
      /**
       * @param {number | null} code - Numeric process exit code.
       * @param {NodeJS.Signals | null} signal - Signal that terminated the process.
       */
      const onExit = (code, signal) => {
        if (code === 0) {
          resume(Effect.void);
          return;
        }
        const outcome = signal ?? `code ${String(code)}`;
        resume(Effect.fail(new MigratorError(`${command} exited with ${outcome}`)));
      };

      child.once('error', onError);
      child.once('exit', onExit);
      return Effect.sync(() => {
        child.off('error', onError);
        child.off('exit', onExit);
      });
    });
  },
);

/** @param {string} relativePath - Application-relative script path. */
const runAppScript = (relativePath) =>
  run(process.execPath, [path.join(appDirectory, relativePath)]);
/**
 * @param {string} relativeDirectory - Application-relative package directory.
 * @param {string} config - Drizzle configuration filename.
 */
const migrate = (relativeDirectory, config) => {
  const workingDirectory = path.join(appDirectory, relativeDirectory);
  return run(
    path.join(workingDirectory, 'node_modules', '.bin', 'drizzle-kit'),
    ['migrate', '--config', config],
    workingDirectory,
  );
};

/** @param {ReturnType<typeof createServer>} server - Readiness server owned by the Effect scope. */
const closeServer = (server) =>
  Effect.callback((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return;
    }
    server.close(() => resume(Effect.void));
  });

const serveReadiness = Effect.fn('serveReadiness')(
  /**
   * @param {number} port - Port used by the readiness server.
   * @yields {unknown} Effect instructions interpreted by `Effect.fn`.
   */
  function* serveReadinessEffect(port) {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((request, response) => {
          if (request.url === '/ready') {
            response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            response.end('ready\n');
            return;
          }
          response.writeHead(404).end();
        }),
      ),
      closeServer,
    );

    yield* Effect.callback((resume) => {
      const onError = (cause) =>
        resume(Effect.fail(new MigratorError('The migration readiness server failed', cause)));
      const onListening = () => {
        console.log(`Migration verification complete; readiness listening on port ${String(port)}`);
      };
      const onSignal = () => resume(Effect.void);

      server.once('error', onError);
      server.once('listening', onListening);
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      server.listen(port, '0.0.0.0');

      return Effect.sync(() => {
        server.off('error', onError);
        server.off('listening', onListening);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      });
    });
  },
);

const main = Effect.scoped(
  Effect.gen(function* migratorEffect() {
    yield* runAppScript('scripts/postgres/bootstrap-spicedb-database.mts');
    yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts');
    yield* migrate('packages/core-runtime', 'drizzle.config.ts');
    yield* migrate('apps/shell-super-app', 'drizzle.auth.config.ts');
    yield* runAppScript('verticals/party-registry/scripts/prepare-contacts-migration.mts');
    yield* migrate('verticals/party-registry', 'drizzle.contacts.config.ts');
    yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts');
    yield* runAppScript('scripts/verify-application-db-schema.mts');
    yield* serveReadiness(yield* migratorPort);
  }).pipe(Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause)))),
);

const exit = await Effect.runPromiseExit(main);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
