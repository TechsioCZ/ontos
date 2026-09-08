import { Config, Console, Effect, Exit, Option, Path, Stdio } from 'effect';
import type { PlatformError } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

interface CommandOptions<E> {
  readonly command: string;
  readonly directoryFailure: string;
  readonly failure: (reason: string) => E;
  readonly launchErrorDetail?: (error: PlatformError.PlatformError) => string;
  readonly moduleUrl: string;
  readonly nodeExecutable?: string;
}

export const resolveUltramodernInvocation = <E,>(options: CommandOptions<E>) =>
  Effect.gen(function* resolveUltramodernInvocationEffect() {
    const path = yield* Path.Path;
    const stdio = yield* Stdio.Stdio;
    const moduleDirectory = yield* path
      .fromFileUrl(new URL('.', options.moduleUrl))
      .pipe(Effect.mapError(() => options.failure(options.directoryFailure)));
    const workspaceRoot = yield* Config.string('ULTRAMODERN_WORKSPACE_ROOT').pipe(
      Config.withDefault(path.resolve(moduleDirectory, '..')),
      Effect.mapError(() => options.failure('ULTRAMODERN_WORKSPACE_ROOT is invalid')),
    );
    const createBin = yield* Config.string('ULTRAMODERN_CREATE_BIN').pipe(
      Config.option,
      Effect.map(Option.filter((value) => value.length > 0)),
      Effect.mapError(() => options.failure('ULTRAMODERN_CREATE_BIN is invalid')),
    );
    const forwardedArgs = yield* stdio.args;
    const args = ['ultramodern', options.command, ...forwardedArgs];
    const nodeExecutable = options.nodeExecutable ?? process.execPath;
    const launch = Option.match(createBin, {
      onNone: () => ({
        args,
        executable: 'ultramodern-create',
        target: 'ultramodern-create from PATH',
      }),
      onSome: (bin) => ({
        args: [bin, ...args],
        executable: nodeExecutable,
        target: `${nodeExecutable} with ULTRAMODERN_CREATE_BIN=${bin}`,
      }),
    });
    return {
      command: ChildProcess.make(launch.executable, launch.args, {
        env: { ULTRAMODERN_WORKSPACE_ROOT: workspaceRoot },
        extendEnv: true,
        shell: Option.isNone(createBin) && path.sep === '\\',
        stderr: 'inherit',
        stdin: 'inherit',
        stdout: 'inherit',
      }),
      forwardedArgs,
      launchFailure: (error: PlatformError.PlatformError) => {
        const detail = options.launchErrorDetail?.(error) ?? `: ${String(error)}`;
        return options.failure(
          `Failed to launch ${launch.target} for UltraModern command "${args.slice(1).join(' ')}"${detail}`,
        );
      },
      workspaceRoot,
    };
  });

export const launchUltramodern = <E,>(
  invocation: Effect.Success<ReturnType<typeof resolveUltramodernInvocation<E>>>,
) =>
  Effect.gen(function* launchUltramodernEffect() {
    const processSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return Number(
      yield* processSpawner
        .exitCode(invocation.command)
        .pipe(Effect.mapError(invocation.launchFailure)),
    );
  });

export const runUltramodernScript = <E extends { readonly reason: string }>(
  options: CommandOptions<E>,
) =>
  resolveUltramodernInvocation(options).pipe(
    Effect.flatMap(launchUltramodern),
    Effect.tapError(({ reason }) => Console.error(reason)),
  );

export const ultramodernExitCode = Exit.match<number, unknown, number, number>({
  onFailure: () => 1,
  onSuccess: (status) => status,
});
