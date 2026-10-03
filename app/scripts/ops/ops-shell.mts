import { stripVTControlCharacters } from 'node:util';

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
  /** Capture stderr for a safe provider error pair instead of inheriting diagnostics. */
  readonly captureProviderFailure?: boolean;
  readonly command: string;
  readonly cwd?: string;
  /** Added to the inherited environment; values are secret and never rendered. */
  readonly env?: SecretValues;
  /** Set false when inherited environment values must not influence the command. */
  readonly extendEnv?: boolean;
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
  stderr: 'inherit' | 'pipe';
  stdin: ChildProcessModel.CommandInput;
}

const spawnOptions = (command: OpsCommand): ChildProcessModel.CommandOptions => {
  const options: SpawnSettings = {
    stderr: command.captureProviderFailure === true ? 'pipe' : 'inherit',
    stdin: command.stdin === undefined ? 'ignore' : Stream.make(encoder.encode(Redacted.value(command.stdin))),
  };
  if (command.cwd !== undefined) {
    options.cwd = command.cwd;
  }
  if (command.env !== undefined) {
    options.env = Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, Redacted.value(value)]));
    options.extendEnv = command.extendEnv ?? true;
  }
  return options;
};

interface ProviderFailure {
  providerCode: number;
  providerPath: string;
}

interface CommandFailureDetails {
  cause?: ProviderFailure;
  command: string;
  message: string;
}

/** Keeps only one unambiguous provider error pair; captured output is never exposed. */
const parseProviderFailure = (stderr: string): ProviderFailure | undefined => {
  const output = stripVTControlCharacters(stderr);
  const requests = [...output.matchAll(/A request to the Cloudflare API\b/gu)];
  const codes = [...output.matchAll(/\[code:/gu)];
  const [request] = requests;
  const [code] = codes;
  if (requests.length !== 1 || codes.length !== 1 || request === undefined || code === undefined) {
    return undefined;
  }
  const pathMatch = /^A request to the Cloudflare API \((?<providerPath>[^)\r\n]*)\) failed\./u.exec(
    output.slice(request.index),
  );
  const providerPath = pathMatch?.groups?.providerPath;
  const codeMatch = /^\[code: (?<providerCode>0|[1-9]\d*)\]/u.exec(output.slice(code.index));
  if (
    providerPath === undefined ||
    !/^\/accounts\/[a-f\d]{32}\/workers\/workers\/[a-z\d][a-z\d-]{0,62}$/u.test(providerPath) ||
    codeMatch === null ||
    code.index < request.index + (pathMatch?.[0].length ?? 0)
  ) {
    return undefined;
  }
  const providerCode = Number(codeMatch.groups?.providerCode);
  return Number.isSafeInteger(providerCode) ? { providerCode, providerPath } : undefined;
};

const makeOpsShell = Effect.gen(function* makeOpsShell() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: OpsCommand) =>
    Effect.scoped(
      Effect.gen(function* runSpawnedCommand() {
        const handle = yield* spawner.spawn(ChildProcess.make(command.command, command.args, spawnOptions(command)));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            command.captureProviderFailure === true
              ? handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
              : Effect.succeed(null),
            handle.exitCode,
          ],
          { concurrency: 3 },
        );
        if (exitCode !== 0) {
          const cause = stderr === null ? undefined : parseProviderFailure(stderr);
          const failure: CommandFailureDetails = {
            command: renderCommand(command),
            message: `${renderCommand(command)} exited with ${String(exitCode)}`,
          };
          if (cause !== undefined) {
            failure.cause = cause;
          }
          return yield* new OpsCommandError(failure);
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
