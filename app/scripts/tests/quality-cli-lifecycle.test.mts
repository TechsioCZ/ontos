import assert from 'node:assert/strict';
import test from 'node:test';

import { NodeServices } from '@effect/platform-node';
import { Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process';

import { makeEffectTestCallback } from '../../packages/core-runtime/src/testing/effect-runtime.ts';

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
  assert.deepEqual(yield* runChild(imports), {
    code: 0,
    stderr: '',
    stdout: '',
  });
});

void test(
  'CLI modules are inert when imported',
  makeEffectTestCallback(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(verifyImports).pipe(
          Layer.provide(NodeServices.layer)
        )
      )
    )
  )
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
    assert.equal(result.code, fails ? 1 : 0);
    assert.equal(result.stdout, 'acquired\nreleased\n');
    assert.equal(result.stderr, fails ? 'CliFailure: expected failure\n' : '');
  }
);

void test(
  'CLI success finalizes scope and exits zero',
  makeEffectTestCallback(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(verifyFinalization(false)).pipe(
          Layer.provide(NodeServices.layer)
        )
      )
    )
  )
);
void test(
  'CLI failure finalizes scope, logs once and exits one',
  makeEffectTestCallback(
    Effect.scoped(
      Layer.build(
        Layer.effectDiscard(verifyFinalization(true)).pipe(
          Layer.provide(NodeServices.layer)
        )
      )
    )
  )
);
