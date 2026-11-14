import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Config, Console, Effect, FileSystem, Option, Predicate, Result, Schema, Sink, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { systemError } from 'effect/PlatformError';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { TestConsole } from 'effect/testing';

import { subsetFonts } from '../fonts/subset-fonts.mjs';

const pythonScript = path.resolve(import.meta.dirname, '../fonts/subset-fonts.py');
const fontErrorTag = 'FontSubsettingError';
const spawnerModule = 'ChildProcessSpawner';
const spawnMessage = 'spawn uv ENOENT';
const missingUv = [
  'This script needs `uv` to run fonttools in a pinned throwaway environment.',
  'Install it (brew install uv, or https://docs.astral.sh/uv/getting-started/installation/)',
  'and run this script again. Nothing is added to the workspace dependencies.',
].join('\n');
const spawnFailure = systemError({
  _tag: 'NotFound',
  cause: new Error(spawnMessage),
  method: 'spawn',
  module: spawnerModule,
  pathOrDescriptor: 'uv',
});
const signalFailure = systemError({
  _tag: 'Unknown',
  cause: new Error("Process interrupted due to receipt of signal: 'SIGTERM'"),
  method: 'exitCode',
  module: spawnerModule,
});

const runFixture = (options: {
  childCode?: number;
  childSignal?: boolean;
  childSpawnFails?: boolean;
  missingScript?: boolean;
  probeCode?: number;
  probeSignal?: boolean;
  probeSpawnFails?: boolean;
}) =>
  Effect.gen(function* runFontFixture() {
    const console = yield* TestConsole.make;
    const commands: ChildProcess.StandardCommand[] = [];
    const released: string[] = [];
    const fileSystem = FileSystem.makeNoop({
      exists: (file) =>
        Effect.sync(() => {
          expect(file).toBe(pythonScript);
          return options.missingScript !== true;
        }),
    });
    const spawner = ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return Effect.die('unexpected piped font command');
      }
      commands.push(command);
      const probe = commands.length === 1;
      if ((probe ? options.probeSpawnFails : options.childSpawnFails) === true) {
        return Effect.fail(spawnFailure);
      }
      const exitCode =
        (probe ? options.probeSignal : options.childSignal) === true
          ? Effect.fail(signalFailure)
          : Effect.succeed(ChildProcessSpawner.ExitCode((probe ? options.probeCode : options.childCode) ?? 0));
      return Effect.acquireRelease(
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            all: Stream.empty,
            exitCode,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            pid: ChildProcessSpawner.ProcessId(1),
            stderr: Stream.empty,
            stdin: Sink.drain,
            stdout: Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        ),
        () => Effect.sync(released.push.bind(released, probe ? 'probe' : 'child')),
      );
    });
    const result = yield* subsetFonts.pipe(
      Effect.scoped,
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Console.Console, console),
      Effect.result,
    );
    return { commands, messages: yield* console.errorLines, released, result };
  });

it.effect('runs the same pinned tools and script with inherited generation stdio', () =>
  Effect.gen(function* successfulSubsetting() {
    const fixture = yield* runFixture({});
    expect(Result.getOrThrow(fixture.result)).toBe(0);
    expect(fixture.messages).toEqual([]);
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands[0]?.command).toBe('uv');
    expect(fixture.commands[0]?.args).toEqual(['--version']);
    expect(fixture.commands[0]?.options.stdout).not.toBe('inherit');
    expect(fixture.commands[0]?.options.stderr).not.toBe('inherit');
    expect(fixture.commands[1]?.command).toBe('uv');
    expect(fixture.commands[1]?.args).toEqual([
      'run',
      '--no-project',
      '--with',
      'fonttools[woff]==4.59.2',
      '--with',
      'uharfbuzz==0.51.1',
      'python',
      pythonScript,
    ]);
    expect(fixture.commands[1]?.options).toEqual({
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    });
    expect(fixture.released).toEqual(['probe', 'child']);
  }),
);

it.effect('rejects a missing Python helper before probing tools', () =>
  Effect.gen(function* missingHelper() {
    const fixture = yield* runFixture({ missingScript: true });
    const failure = Result.getOrThrow(Result.flip(fixture.result));
    expect(Predicate.isTagged(failure, fontErrorTag)).toBe(true);
    expect(failure).toMatchObject({ message: `missing ${pythonScript}` });
    expect(fixture.commands).toEqual([]);
    expect(fixture.messages).toEqual([`missing ${pythonScript}`]);
  }),
);

it.effect('prints the original installation instructions when uv cannot start', () =>
  Effect.gen(function* missingTool() {
    const fixture = yield* runFixture({ probeSpawnFails: true });
    expect(Predicate.isTagged(Result.getOrThrow(Result.flip(fixture.result)), fontErrorTag)).toBe(true);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.messages).toEqual([missingUv]);
  }),
);

it.effect('rejects an unsuccessful or signalled version probe without running generation', () =>
  Effect.gen(function* unsuccessfulProbe() {
    for (const options of [{ probeCode: 2 }, { probeSignal: true }]) {
      const fixture = yield* runFixture(options);
      expect(Predicate.isTagged(Result.getOrThrow(Result.flip(fixture.result)), fontErrorTag)).toBe(true);
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.messages).toEqual([missingUv]);
      expect(fixture.released).toEqual(['probe']);
    }
  }),
);

it.effect('preserves a nonzero generation exit code without extra output', () =>
  Effect.gen(function* failedGeneration() {
    const fixture = yield* runFixture({ childCode: 7 });
    expect(Result.getOrThrow(fixture.result)).toBe(7);
    expect(fixture.messages).toEqual([]);
    expect(fixture.released).toEqual(['probe', 'child']);
  }),
);

it.effect('prints the original native message if generation cannot start', () =>
  Effect.gen(function* failedGenerationSpawn() {
    const fixture = yield* runFixture({ childSpawnFails: true });
    const failure = Result.getOrThrow(Result.flip(fixture.result));
    expect(Predicate.isTagged(failure, fontErrorTag)).toBe(true);
    expect(failure).toMatchObject({ message: spawnMessage });
    expect(fixture.messages).toEqual([spawnMessage]);
    expect(fixture.released).toEqual(['probe']);
  }),
);

it.effect('maps a signal to the original null-status fallback and finalizes the child', () =>
  Effect.gen(function* signalledGeneration() {
    const fixture = yield* runFixture({ childSignal: true });
    expect(Result.getOrThrow(fixture.result)).toBe(1);
    expect(fixture.messages).toEqual([]);
    expect(fixture.released).toEqual(['probe', 'child']);
  }),
);

const runChild = Effect.fn('runFontCliChild')(function* runFontCliChild(command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const [stdout, stderr, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: 'unbounded' },
  );
  return { code, stderr, stdout };
});

const runCliFixture = (outcome: number | 'signal') =>
  Effect.gen(function* runSyntheticFontCli() {
    const fs = yield* FileSystem.FileSystem;
    const ownedRoot = yield* Config.option(Config.String('OWNED_TEMP_DIR'));
    const root = yield* fs.makeTempDirectoryScoped({ directory: Option.getOrUndefined(ownedRoot) });
    const uv = path.join(root, 'uv');
    // This executable never invokes uv, Python, fonttools, or any font asset.
    yield* fs.writeFileString(
      uv,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then',
        String.raw`  printf 'probe stdout\n'`,
        String.raw`  printf 'probe stderr\n' >&2`,
        '  exit 0',
        'fi',
        String.raw`printf 'synthetic generation stdout\n'`,
        String.raw`printf 'synthetic generation stderr\n' >&2`,
        outcome === 'signal' ? '/bin/kill -TERM $$' : `exit ${outcome}`,
      ].join('\n'),
    );
    yield* fs.chmod(uv, 0o700);
    return yield* runChild(
      ChildProcess.make(process.execPath, [path.resolve(import.meta.dirname, '../fonts/subset-fonts.mjs')], {
        env: { PATH: root },
        extendEnv: true,
      }),
    );
  });

it.live('keeps the module inert when imported outside its executable edge', () =>
  Effect.gen(function* inertImport() {
    const url = new URL('../fonts/subset-fonts.mjs', import.meta.url).href;
    const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.String));
    const result = yield* runChild(
      ChildProcess.make(process.execPath, ['--input-type=module', '--eval', `await import(${encodeJson(url)});`], {
        env: { PATH: '' },
        extendEnv: true,
      }),
    );
    expect(result).toEqual({ code: 0, stderr: '', stdout: '' });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('preserves CLI stdout, stderr, success and nonzero exits with a synthetic uv executable', () =>
  Effect.gen(function* syntheticCliExits() {
    for (const code of [0, 7]) {
      const result = yield* runCliFixture(code);
      expect(result).toEqual({
        code,
        stderr: 'synthetic generation stderr\n',
        stdout: 'synthetic generation stdout\n',
      });
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live('preserves the CLI signal fallback without an extra error report', () =>
  Effect.gen(function* syntheticCliSignal() {
    expect(yield* runCliFixture('signal')).toEqual({
      code: 1,
      stderr: 'synthetic generation stderr\n',
      stdout: 'synthetic generation stdout\n',
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
