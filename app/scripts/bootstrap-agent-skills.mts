#!/usr/bin/env node
import { NodeServices } from '@effect/platform-node';
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Exit,
  Option,
  Path,
  Schema,
  Stdio,
  Predicate,
} from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

class AgentSkillsBootstrapError extends Schema.TaggedError<AgentSkillsBootstrapError>()(
  'AgentSkillsBootstrapError',
  { reason: Schema.String },
) {}

const failure = (reason: string): AgentSkillsBootstrapError =>
  new AgentSkillsBootstrapError({ reason });

const program = Effect.gen(function* bootstrapAgentSkills() {
  const path = yield* Path.Path;
  const stdio = yield* Stdio.Stdio;
  const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const workspaceRoot = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
    Config.withDefault(path.resolve(import.meta.dirname, '..')),
    Effect.mapError(() => failure('ULTRAMODERN_WORKSPACE_ROOT is invalid')),
  );
  const createBin = yield* Config.string('ULTRAMODERN_CREATE_BIN').pipe(
    Config.option,
    Effect.map(Option.filter((value) => value.length > 0)),
    Effect.mapError(() => failure('ULTRAMODERN_CREATE_BIN is invalid')),
  );
  const forwardedArgs = yield* stdio.args;
  const checkOnly = forwardedArgs.includes('--check');
  const skillArgs = checkOnly
    ? ['skills', 'check', ...forwardedArgs.filter((arg) => arg !== '--check')]
    : ['skills', 'install', ...forwardedArgs];
  const ultramodernArgs = ['ultramodern', ...skillArgs];
  const launch = Option.match(createBin, {
    onNone: () => ({
      args: ultramodernArgs,
      executable: 'modern-js-create',
      shell: path.sep === '\\',
      target: 'modern-js-create from PATH',
    }),
    onSome: (bin) => ({
      args: [bin, ...ultramodernArgs],
      executable: process.execPath,
      shell: false,
      target: `${process.execPath} with ULTRAMODERN_CREATE_BIN=${bin}`,
    }),
  });

  return yield* processSpawner
    .exitCode(
      ChildProcess.make(launch.executable, launch.args, {
        env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
        extendEnv: true,
        shell: launch.shell,
        stderr: 'inherit',
        stdin: 'inherit',
        stdout: 'inherit',
      }),
    )
    .pipe(
      Effect.matchEffect({
        onFailure: (error) => {
          if (error.reason.method === 'exitCode') {
            return Effect.succeed(1);
          }
          const launchCause = error.reason.cause;
          const causeMessage = Predicate.isError(launchCause)
            ? launchCause.message.replace(/^spawn /u, 'spawnSync ')
            : error.message;
          return Effect.fail(
            failure(
              `Failed to launch ${launch.target} for UltraModern command "${ultramodernArgs
                .slice(1)
                .join(' ')}": ${causeMessage}`,
            ),
          );
        },
        onSuccess: (status) => Effect.succeed(Number(status)),
      }),
    );
});

const exit = await Effect.runPromiseExit(
  program.pipe(
    Effect.tapError((error) => Console.error(error.reason)),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
    Effect.provide(NodeServices.layer),
    Effect.scoped,
  ),
);
process.exitCode = Exit.match(exit, {
  onFailure: () => 1,
  onSuccess: (status) => status,
});
