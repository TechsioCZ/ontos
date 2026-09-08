#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import {
  Config,
  Console,
  Effect,
  Exit,
  Option,
  Path,
  Predicate,
  Schema,
  Stdio,
} from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';

import { ultramodernLaunch } from './shared/ultramodern-launch.mts';

class BackendFederationProofLaunchError extends Schema.TaggedError<BackendFederationProofLaunchError>()(
  'BackendFederationProofLaunchError',
  { cause: Schema.Defect(), message: Schema.String }
) {}

const program = Effect.gen(function* backendFederationProofProgram() {
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const createBin = yield* Config.string('ULTRAMODERN_CREATE_BIN').pipe(
    Config.option,
    Effect.map(Option.filter((value) => value.length > 0))
  );
  const forwardedArgs = yield* stdio.args;
  const workspaceRoot = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
    Config.withDefault(path.resolve(import.meta.dirname, '..'))
  );
  const ultramodernArgs = [
    'ultramodern',
    'backend-federation-proof',
    ...forwardedArgs,
  ];
  const launch = ultramodernLaunch(
    createBin,
    ultramodernArgs,
    workspaceRoot,
    path.sep
  );
  return yield* processSpawner.exitCode(launch.command).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        if (cause.reason.method === 'exitCode') {
          return Effect.succeed(1);
        }
        const launchCause = cause.reason.cause;
        const causeMessage = Predicate.isError(launchCause)
          ? launchCause.message
          : cause.message;
        return Effect.fail(
          new BackendFederationProofLaunchError({
            cause,
            message: `Failed to launch ${launch.target} for UltraModern command "${ultramodernArgs
              .slice(1)
              .join(' ')}": ${causeMessage}`,
          })
        );
      },
      onSuccess: (status) => Effect.succeed(Number(status)),
    })
  );
});

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.tapError((error) => Console.error(error.message)),
    Effect.provide(NodeServices.layer),
    Effect.scoped
  )
);

process.exitCode = Exit.match(exit, {
  onFailure: () => 1,
  onSuccess: (status) => status,
});
