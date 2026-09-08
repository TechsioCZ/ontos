import { NodeServices } from '@effect/platform-node';
import { Effect, Schema, Stream } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const lifecycleUrl = new URL('../quality-cli-lifecycle.mts', import.meta.url)
  .href;
const runChild = Effect.fn('runLifecycleChild')(function* runLifecycleChild(
  source: string
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ['--input-type=module', '-e', source])
  );
  const [stdout, stderr, code] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: 'unbounded' }
  );
  return { code, stderr, stdout };
});

const verifyImports = Effect.gen(function* verifyInertImports() {
  const imports = [
    'quality-audit.mts',
    'quality-audit-gate.mts',
    'quality-cli-lifecycle.mts',
  ]
    .map((file) => {
      const url = new URL(`../${file}`, import.meta.url).href;
      return `import ${encodeJson(url)};`;
    })
    .join('\n');
  expect(yield* runChild(imports)).toEqual({ code: 0, stderr: '', stdout: '' });
});

it.live('CLI modules are inert when imported', () =>
  verifyImports.pipe(Effect.provide(NodeServices.layer))
);
const verifyFinalization = Effect.fn('verifyFinalization')(
  function* verifyCliFinalization(fails: boolean) {
    const result = yield* runChild(`
      import { Console, Data, Effect } from 'effect';
      import { runQualityCli } from ${encodeJson(lifecycleUrl)};
      class CliFailure extends Data.TaggedError('CliFailure') {}
      runQualityCli(Effect.gen(function* scopedCommand() {
        yield* Effect.acquireRelease(Console.log('acquired'), () => Console.log('released'));
        yield* ${fails ? "Effect.fail(new CliFailure({ message: 'expected failure' }))" : 'Effect.void'};
      }));
    `);
    expect(result.code).toBe(fails ? 1 : 0);
    expect(result.stdout).toBe('acquired\nreleased\n');
    expect(result.stderr).toBe(fails ? 'CliFailure: expected failure\n' : '');
  }
);

it.live('CLI success finalizes scope and exits zero', () =>
  verifyFinalization(false).pipe(Effect.provide(NodeServices.layer))
);
it.live('CLI failure finalizes scope, logs once and exits one', () =>
  verifyFinalization(true).pipe(Effect.provide(NodeServices.layer))
);
