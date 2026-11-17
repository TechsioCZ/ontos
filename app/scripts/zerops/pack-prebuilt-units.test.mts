import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';

const SCRIPT = path.join(import.meta.dirname, 'pack-prebuilt-units.sh');
/** Two units that bundle the same framework code, as every unit does, and a file only one of them has. */
const SHARED = 'export const framework = "the same bundled framework code in every unit";\n'.repeat(4000);
const UNITS = {
  'apps/shell-super-app/dist/.zerops-build-digest': 'a'.repeat(64),
  'apps/shell-super-app/dist/api/index.js': SHARED,
  'apps/shell-super-app/dist/zerops-entry.mjs': 'shell entry',
  'verticals/crm/dist/.zerops-build-digest': 'b'.repeat(64),
  'verticals/crm/dist/api/index.js': `${SHARED}// crm\n`,
  'verticals/crm/dist/static/js/async/a.0123456789.js': 'crm client chunk',
  'verticals/crm/dist/zerops-entry.mjs': 'crm entry',
} satisfies Readonly<Record<string, string>>;

/** Writes the units, packs them with the real script, real tar and real zstd, and returns the outcome. */
const pack = (units: Readonly<Record<string, string>>) =>
  Effect.gen(function* packFixture() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const source = path.join(directory, 'dists');
    const archive = path.join(directory, 'units.tar.zst');
    yield* fs.makeDirectory(source);
    for (const [file, body] of Object.entries(units)) {
      yield* fs.makeDirectory(path.dirname(path.join(source, file)), { recursive: true });
      yield* fs.writeFileString(path.join(source, file), body);
    }
    const result = yield* collectToolingProcess(ChildProcess.make('sh', [SCRIPT, source, archive]));
    return { archive, directory, fs, result };
  });
/** Decodes an archive exactly as the Zerops app build does: `zstd -dc … | tar -x`, no window flag. */
const unpackLikeZerops = (archive: string, target: string) =>
  collectToolingProcess(ChildProcess.make('sh', ['-c', 'zstd -dc "$0" | tar -xf - -C "$1"', archive, target]));
const listFiles = (fs: FileSystem.FileSystem, root: string) =>
  fs.readDirectory(root, { recursive: true }).pipe(
    Effect.flatMap((entries) =>
      Effect.all(
        entries.map((entry) =>
          fs.stat(path.join(root, entry)).pipe(Effect.map((info) => (info.type === 'File' ? [entry] : []))),
        ),
        { concurrency: 1 },
      ),
    ),
    Effect.map((files) => files.flat().toSorted()),
  );

it.effect('packs every unit file and nothing else, and the Zerops plain decode gives back the same bytes', () =>
  Effect.gen(function* roundTrip() {
    const { archive, directory, fs, result } = yield* pack(UNITS);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('checked with a plain zstd -dc');
    const target = path.join(directory, 'unpacked');
    yield* fs.makeDirectory(target);
    const unpacked = yield* unpackLikeZerops(archive, target);
    expect(unpacked.status, unpacked.stderr).toBe(0);
    expect(yield* listFiles(fs, target)).toEqual(Object.keys(UNITS).toSorted());
    for (const [file, body] of Object.entries(UNITS)) {
      expect(yield* fs.readFileString(path.join(target, file))).toBe(body);
    }
    // The long window finds the second unit's copy: the archive is far smaller than one copy alone.
    expect((yield* fs.stat(archive)).size).toBeLessThan(BigInt(SHARED.length / 50));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const members = (archive: string) =>
  collectToolingProcess(ChildProcess.make('sh', ['-c', 'zstd -dc "$0" | tar -tf -', archive])).pipe(
    Effect.map(({ stdout }) => stdout.trim().split('\n')),
  );

it.effect('orders members by their path below dist/, then by unit, the same way on every run', () =>
  Effect.gen(function* fixedOrder() {
    const first = yield* pack(UNITS);
    const second = yield* pack(UNITS);
    expect(first.result.status, first.result.stderr).toBe(0);
    const order = yield* members(first.archive);
    expect(yield* members(second.archive)).toEqual(order);
    expect(order).toEqual([
      'apps/shell-super-app/dist/.zerops-build-digest',
      'verticals/crm/dist/.zerops-build-digest',
      'apps/shell-super-app/dist/api/index.js',
      'verticals/crm/dist/api/index.js',
      'verticals/crm/dist/static/js/async/a.0123456789.js',
      'apps/shell-super-app/dist/zerops-entry.mjs',
      'verticals/crm/dist/zerops-entry.mjs',
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect('refuses an empty directory and anything that is not a unit output', () =>
  Effect.gen(function* refusals() {
    const empty = yield* pack({});
    expect(empty.result.status).toBe(1);
    expect(empty.result.stderr).toContain('no unit outputs under');
    const stray = yield* pack({ ...UNITS, 'verticals/crm/src/index.ts': 'source' });
    expect(stray.result.status).toBe(1);
    expect(stray.result.stderr).toContain('not a unit output: verticals/crm/src/index.ts');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it('the delivery packs the unit builds with this script before the push', () => {
  const workflow = readFileSync(new URL('../../../.github/actions/deliver-stage/action.yml', import.meta.url), 'utf-8');
  expect(workflow).toContain(
    'sh app/scripts/zerops/pack-prebuilt-units.sh "$RUNNER_TEMP/dists" app/.zerops-prebuilt.tar.zst',
  );
  // zerops.yaml decodes with no window flag, which is what the script checks against.
  const zerops = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
  expect(zerops).toContain('zstd -dc app/.zerops-prebuilt.tar.zst | tar -x -C app');
  expect(readFileSync(SCRIPT, 'utf-8')).toContain('zstd -q -12 --long=27 -T0');
});
