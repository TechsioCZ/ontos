import { Context, Effect, Layer, Redacted, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';
import type { ChildProcess as ChildProcessModel } from 'effect/unstable/process';

import { OpsCommandError } from './ops-command-error.mts';

/**
 * The process seam of the stage operations scripts. Every external CLI they drive (`zcli`, `gh`,
 * Wrangler) goes through {@link OpsShell}, so tests record the exact commands without spawning
 * anything. Secret material never appears in arguments: it travels as redacted standard input or
 * redacted child environment, and only the command line is ever rendered.
 */
export type SecretValues = Readonly<Record<string, Redacted.Redacted>>;

export interface OpsCommand {
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd?: string;
  /** Added to the inherited environment; values are secret and never rendered. */
  readonly env?: SecretValues;
  /** Written to the child's standard input; the payload is secret and never rendered. */
  readonly stdin?: Redacted.Redacted;
}

export interface OpsShellService {
  /** Runs the command to completion and returns its standard output; a non-zero exit fails. */
  readonly run: (command: OpsCommand) => Effect.Effect<string, OpsCommandError>;
}

export const OpsShell = Context.Service<OpsShellService>('@app/scripts/ops/ops-shell/OpsShell');

/** The command line without its secret inputs, for logs and failures. */
export const renderCommand = ({ args, command }: OpsCommand): string => [command, ...args].join(' ');

/** Runs one command through the {@link OpsShell} in context. */
export const runCommand = (command: OpsCommand) =>
  Effect.gen(function* runCommandEffect() {
    const shell = yield* OpsShell;
    return yield* shell.run(command);
  });

const encoder = new TextEncoder();

/** The subset of spawn options the operations set. */
interface SpawnSettings {
  cwd?: string;
  env?: Record<string, string>;
  extendEnv?: boolean;
  stderr: 'inherit';
  stdin: ChildProcessModel.CommandInput;
}

const spawnOptions = (command: OpsCommand): ChildProcessModel.CommandOptions => {
  const options: SpawnSettings = {
    stderr: 'inherit',
    stdin: command.stdin === undefined ? 'ignore' : Stream.make(encoder.encode(Redacted.value(command.stdin))),
  };
  if (command.cwd !== undefined) {
    options.cwd = command.cwd;
  }
  if (command.env !== undefined) {
    options.env = Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, Redacted.value(value)]));
    options.extendEnv = true;
  }
  return options;
};

const makeOpsShell = Effect.gen(function* makeOpsShell() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: OpsCommand) =>
    Effect.scoped(
      Effect.gen(function* runSpawnedCommand() {
        const handle = yield* spawner.spawn(ChildProcess.make(command.command, command.args, spawnOptions(command)));
        const [stdout, exitCode] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: 2 },
        );
        if (exitCode !== 0) {
          return yield* new OpsCommandError({
            command: renderCommand(command),
            message: `${renderCommand(command)} exited with ${String(exitCode)}`,
          });
        }
        return stdout;
      }),
    ).pipe(
      Effect.catchTag('PlatformError', (cause) =>
        Effect.fail(
          new OpsCommandError({
            cause,
            command: renderCommand(command),
            message: `${renderCommand(command)} could not run`,
          }),
        ),
      ),
    );
  return { run } satisfies OpsShellService;
});

export const OpsShellLive = Layer.effect(OpsShell, makeOpsShell);
