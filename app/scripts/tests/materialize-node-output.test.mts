import path from 'node:path';

import { verifyNodeReleaseEnvelopeStaging } from '@modern-js/app-tools-extensions/release-envelope/framework-output';
import { NodeServices } from '@effect/platform-node';
import { Config, Effect, FileSystem, PlatformError } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { NodeOutputMaterializationError, stageNodeOutput } from '../materialize-node-output.mjs';
import { makeSealedNodeBuildFixture } from './support/node-runtime-envelope-fixture.mts';

const PACKAGE_JSON = 'package.json';
const APP = 'promotion';
const PACKAGE = '@app/promotion';
const PACKAGE_DIR = 'verticals/promotion';
const ENTRY = 'console.log("built output");\n';
const OUTPUT_PACKAGE = {
  dependencies: { effect: '4.0.7' },
  name: '@app/promotion-prod',
  type: 'commonjs',
};
const fixture = Effect.gen(function* builtOutputFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-node-output-' });
  const packageRoot = path.join(root, PACKAGE_DIR);
  const output = path.join(packageRoot, '.output');
  const runtime = path.join(root, '.zerops/runtime', APP);
  yield* fs.makeDirectory(output, { recursive: true });
  yield* fs.writeFileString(
    path.join(packageRoot, PACKAGE_JSON),
    JSON.stringify({ modernjs: { appId: APP }, name: PACKAGE }),
  );
  yield* fs.writeFileString(path.join(output, PACKAGE_JSON), JSON.stringify(OUTPUT_PACKAGE));
  yield* fs.writeFileString(path.join(output, 'index.js'), ENTRY);
  return {
    options: { appId: APP, packageDir: PACKAGE_DIR, packageName: PACKAGE, workspaceRoot: root },
    output,
    packageRoot,
    root,
    runtime,
  };
});

it.effect('stages the actual Node output shape and retains dependencies while supplying the public default serve', () =>
  Effect.gen(function* stageNormalOutput() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture;
    yield* fs.makeDirectory(built.runtime, { recursive: true });
    yield* fs.writeFileString(path.join(built.runtime, 'stale.js'), 'stale');
    const result = yield* stageNodeOutput(built.options);
    expect(result).toBe('.zerops/runtime/promotion');
    expect(yield* fs.readFileString(path.join(built.runtime, 'index.js'))).toBe(ENTRY);
    expect(yield* fs.readFileString(path.join(built.output, PACKAGE_JSON))).toBe(JSON.stringify(OUTPUT_PACKAGE));
    expect(JSON.parse(yield* fs.readFileString(path.join(built.runtime, PACKAGE_JSON)))).toEqual({
      ...OUTPUT_PACKAGE,
      scripts: { serve: 'node index.js' },
    });
    expect(yield* fs.exists(path.join(built.runtime, 'stale.js'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('preserves an existing declared runtime serve command and unchanged output bytes', () =>
  Effect.gen(function* retainDeclaredServe() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture;
    yield* fs.writeFileString(
      path.join(built.output, PACKAGE_JSON),
      JSON.stringify({
        ...OUTPUT_PACKAGE,
        scripts: { health: 'node health.js', serve: 'node --enable-source-maps index.js' },
      }),
    );
    yield* stageNodeOutput(built.options);
    expect(JSON.parse(yield* fs.readFileString(path.join(built.runtime, PACKAGE_JSON)))).toEqual({
      ...OUTPUT_PACKAGE,
      scripts: { health: 'node health.js', serve: 'node --enable-source-maps index.js' },
    });
    expect(yield* fs.readFileString(path.join(built.runtime, 'index.js'))).toBe(ENTRY);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const mismatch of ['package', 'app']) {
  it.effect(`rejects mismatched source ${mismatch} before replacing an existing runtime`, () =>
    Effect.gen(function* rejectMismatchedSource() {
      const fs = yield* FileSystem.FileSystem;
      const built = yield* fixture;
      yield* fs.makeDirectory(built.runtime, { recursive: true });
      const sentinel = path.join(built.runtime, 'sentinel');
      yield* fs.writeFileString(sentinel, 'retain');
      const options =
        mismatch === 'package' ? { ...built.options, packageName: '@app/other' } : { ...built.options, appId: 'other' };
      expect(yield* stageNodeOutput(options).pipe(Effect.flip)).toBeInstanceOf(NodeOutputMaterializationError);
      expect(yield* fs.readFileString(sentinel)).toBe('retain');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

for (const invalid of ['missing-index', 'malformed-package', 'empty-serve']) {
  it.effect(`rejects ${invalid} before staging runtime metadata`, () =>
    Effect.gen(function* rejectMalformedOutput() {
      const fs = yield* FileSystem.FileSystem;
      const built = yield* fixture;
      if (invalid === 'missing-index') {
        yield* fs.remove(path.join(built.output, 'index.js'));
      }
      if (invalid === 'malformed-package') {
        yield* fs.writeFileString(path.join(built.output, PACKAGE_JSON), '{');
      }
      if (invalid === 'empty-serve') {
        yield* fs.writeFileString(
          path.join(built.output, PACKAGE_JSON),
          JSON.stringify({ ...OUTPUT_PACKAGE, scripts: { serve: '' } }),
        );
      }
      yield* stageNodeOutput(built.options).pipe(Effect.flip);
      expect(yield* fs.exists(built.runtime)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('rejects missing normal build output', () =>
  Effect.gen(function* requireBuiltOutput() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture;
    yield* fs.remove(built.output, { recursive: true });
    expect(yield* stageNodeOutput(built.options).pipe(Effect.flip)).toBeInstanceOf(NodeOutputMaterializationError);
    expect(yield* fs.exists(built.runtime)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('rejects an escaping package directory without touching the external package', () =>
  Effect.gen(function* rejectEscapingPackage() {
    const built = yield* fixture;
    expect(yield* stageNodeOutput({ ...built.options, packageDir: '../other' }).pipe(Effect.flip)).toBeInstanceOf(
      NodeOutputMaterializationError,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const boundaries: readonly ('package' | 'output' | 'entry' | 'runtime' | 'source-metadata')[] = [
  'package',
  'output',
  'entry',
  'runtime',
  'source-metadata',
];
for (const boundary of boundaries) {
  it.effect(`rejects a symlink at the ${boundary} boundary and preserves its target`, () =>
    Effect.gen(function* rejectSymbolicBoundary() {
      const fs = yield* FileSystem.FileSystem;
      const built = yield* fixture;
      const outside = yield* fs.makeTempDirectoryScoped();
      const sentinel = path.join(outside, 'sentinel');
      yield* fs.writeFileString(sentinel, 'outside');
      const targets = {
        entry: path.join(built.output, 'index.js'),
        output: built.output,
        package: built.packageRoot,
        runtime: path.dirname(built.runtime),
        'source-metadata': path.join(built.packageRoot, PACKAGE_JSON),
      };
      const target = targets[boundary];
      yield* fs.remove(target, { force: true, recursive: true });
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.symlink(outside, target);
      expect(yield* stageNodeOutput(built.options).pipe(Effect.flip)).toBeInstanceOf(NodeOutputMaterializationError);
      expect(yield* fs.readFileString(sentinel)).toBe('outside');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('propagates an unreadable runtime ancestor and preserves the existing runtime', () =>
  Effect.gen(function* refuseUnreadableAncestor() {
    const fs = yield* FileSystem.FileSystem;
    const built = yield* fixture;
    yield* fs.makeDirectory(built.runtime, { recursive: true });
    const sentinel = path.join(built.runtime, 'sentinel');
    yield* fs.writeFileString(sentinel, 'retain');
    const refusal = PlatformError.systemError({
      _tag: 'PermissionDenied',
      method: 'lstat',
      module: 'FileSystem',
      pathOrDescriptor: path.dirname(built.runtime),
    });
    const files = FileSystem.make({
      ...fs,
      lstat: (target) => (target === path.dirname(built.runtime) ? Effect.fail(refusal) : fs.lstat(target)),
    });
    const result = yield* stageNodeOutput(built.options).pipe(
      Effect.provideService(FileSystem.FileSystem, files),
      Effect.flip,
    );
    expect(result).toBe(refusal);
    expect(yield* fs.readFileString(sentinel)).toBe('retain');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const FINALIZER_FAILURE = 'finalizer-failure';
for (const behavior of ['success', FINALIZER_FAILURE, 'rebuild-failure']) {
  it.live(`the actual gateway stages and sequences public finalization/rebuild: ${behavior}`, () =>
    Effect.gen(function* runActualGateway() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const built = yield* fixture;
      const sealed = yield* makeSealedNodeBuildFixture({ ...built.options, entry: ENTRY });
      const bin = path.join(built.root, 'bin');
      const finalizerArgs = path.join(built.root, 'finalizer-args');
      const rebuildArgs = path.join(built.root, 'rebuild-args');
      yield* fs.makeDirectory(bin);
      for (const command of ['pnpm', 'npm']) {
        const executable = path.join(bin, command);
        const output = command === 'pnpm' ? '$STAGING_FINALIZER_ARGS' : '$STAGING_REBUILD_ARGS';
        const status = command === 'pnpm' ? '$STAGING_FINALIZER_STATUS' : '$STAGING_REBUILD_STATUS';
        yield* fs.writeFileString(
          executable,
          `#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "${output}"\nexit "${status}"\n`,
        );
        yield* fs.chmod(executable, 0o700);
      }
      const inheritedPath = yield* Config.String('PATH');
      const gateway = path.resolve(import.meta.dirname, '../materialize-ontos-zerops-runtime.mjs');
      const code = yield* spawner.exitCode(
        ChildProcess.make(
          process.execPath,
          [gateway, '--app', APP, '--package', PACKAGE, '--package-dir', PACKAGE_DIR],
          {
            env: {
              PATH: `${bin}:${inheritedPath}`,
              STAGING_FINALIZER_ARGS: finalizerArgs,
              STAGING_FINALIZER_STATUS: behavior === FINALIZER_FAILURE ? '17' : '0',
              STAGING_REBUILD_ARGS: rebuildArgs,
              STAGING_REBUILD_STATUS: behavior === 'rebuild-failure' ? '18' : '0',
              ULTRAMODERN_SOURCE_REVISION: sealed.sourceRevision,
              ULTRAMODERN_WORKSPACE_ROOT: built.root,
            },
            stderr: 'inherit',
            stdout: 'inherit',
          },
        ),
      );
      expect(code === 0).toBe(behavior === 'success');
      expect((yield* fs.readFileString(finalizerArgs)).trim().split('\n')).toEqual([
        built.root,
        'exec',
        'ultramodern-create',
        'ultramodern',
        'zerops-materialize',
        '--app',
        APP,
        '--package',
        PACKAGE,
        '--package-dir',
        PACKAGE_DIR,
        '--finalize-only',
        '--runtime-dir',
        '.zerops/runtime/promotion',
      ]);
      if (behavior === FINALIZER_FAILURE) {
        expect(yield* fs.exists(rebuildArgs)).toBe(false);
      } else {
        expect((yield* fs.readFileString(rebuildArgs)).trim().split('\n')).toEqual([built.runtime, 'rebuild']);
      }
      expect(yield* fs.readFileString(path.join(built.runtime, 'index.js'))).toBe(ENTRY);
      if (behavior === 'success') {
        yield* Effect.tryPromise(() => verifyNodeReleaseEnvelopeStaging({ outputDirectory: built.runtime }));
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
