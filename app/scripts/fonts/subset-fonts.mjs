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
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Exit, FileSystem, Predicate, Schema } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

class FontSubsettingError extends Schema.TaggedError()('FontSubsettingError', { message: Schema.String }) {}

const pythonScript = path.join(import.meta.dirname, 'subset-fonts.py');
const missingUv = [
  'This script needs `uv` to run fonttools in a pinned throwaway environment.',
  'Install it (brew install uv, or https://docs.astral.sh/uv/getting-started/installation/)',
  'and run this script again. Nothing is added to the workspace dependencies.',
].join('\n');

export const subsetFonts = Effect.gen(function* subsetFontsProgram() {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  if (!(yield* fs.exists(pythonScript))) {
    return yield* Effect.fail(new FontSubsettingError({ message: `missing ${pythonScript}` }));
  }

  const probeCode = yield* spawner
    .exitCode(ChildProcess.make('uv', ['--version']))
    .pipe(Effect.mapError(() => new FontSubsettingError({ message: missingUv })));
  if (probeCode !== 0) {
    return yield* Effect.fail(new FontSubsettingError({ message: missingUv }));
  }

  const child = yield* spawner
    .spawn(
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
          path.resolve(pythonScript),
        ],
        { stderr: 'inherit', stdin: 'inherit', stdout: 'inherit' },
      ),
    )
    .pipe(
      Effect.mapError(
        (failure) =>
          new FontSubsettingError({
            message: Predicate.isError(failure.reason.cause) ? failure.reason.cause.message : failure.message,
          }),
      ),
    );
  // A signal gives spawnSync a null status; retain its existing fallback exit code.
  return yield* child.exitCode.pipe(Effect.orElseSucceed(() => 1));
}).pipe(Effect.tapError((failure) => Console.error(failure.message)));

if (import.meta.main) {
  const exit = await Effect.runPromiseExit(subsetFonts.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
  process.exitCode = Exit.match(exit, { onFailure: () => 1, onSuccess: (code) => code });
}
