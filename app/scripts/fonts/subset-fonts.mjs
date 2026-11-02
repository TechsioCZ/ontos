#!/usr/bin/env node
/**
 * Build the AKROS storefront Inter subsets (core + extended).
 *
 *   node app/scripts/fonts/subset-fonts.mjs
 *
 * Run it by hand whenever the source font or the covered character set changes,
 * then commit the generated files:
 *
 *   app/akros-storefront/src/fonts/InterVariable-core.woff2
 *   app/akros-storefront/src/fonts/InterVariable-ext.woff2
 *   app/akros-storefront/src/fonts/inter-extended.generated.css
 *   app/akros-storefront/src/fonts/inter-ranges.generated.ts
 *   app/akros-storefront/src/fonts/inter-subsets.generated.json
 *
 * The build never runs this; it only consumes the committed files.
 *
 * Tooling: uv (https://docs.astral.sh/uv/) runs the pinned fonttools and
 * uharfbuzz releases in an ephemeral environment, so nothing is added to the
 * workspace manifest. HarfBuzz is only used to detect kerning pairs, so no
 * kerned pair can end up split across the two files.
 */
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

export class FontSubsetError extends Schema.TaggedError()('FontSubsetError', {
  message: Schema.String,
}) {}

export const subsetFonts = Effect.gen(function* subsetFontsEffect() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pythonScript = yield* path.fromFileUrl(new URL('subset-fonts.py', import.meta.url));
  if (!(yield* fs.exists(pythonScript))) {
    return yield* Effect.fail(new FontSubsetError({ message: `missing ${pythonScript}` }));
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const uvFailure = () =>
    new FontSubsetError({
      message: [
        'This script needs `uv` to run fonttools in a pinned throwaway environment.',
        'Install it (brew install uv, or https://docs.astral.sh/uv/getting-started/installation/)',
        'and run this script again. Nothing is added to the workspace dependencies.',
      ].join('\n'),
    });
  const probe = yield* spawner
    .exitCode(
      ChildProcess.make('uv', ['--version'], {
        stderr: 'ignore',
        stdin: 'ignore',
        stdout: 'ignore',
      }),
    )
    .pipe(Effect.mapError(uvFailure));
  if (probe !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(uvFailure());
  }

  const result = yield* spawner.exitCode(
    ChildProcess.make(
      'uv',
      [
        'run',
        '--no-project',
        '--with',
        'fonttools[woff]==4.59.2',
        '--with',
        'uharfbuzz==0.51.1',
        'python',
        pythonScript,
      ],
      { stderr: 'inherit', stdin: 'inherit', stdout: 'inherit' },
    ),
  );
  if (result !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(new FontSubsetError({ message: `Font subsetting failed with exit code ${result}` }));
  }
  return yield* Effect.void;
});

if (import.meta.main) {
  NodeRuntime.runMain(subsetFonts.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
}
