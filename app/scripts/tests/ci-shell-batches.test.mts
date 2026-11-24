import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseCiMatrices } from '../ci/ci-matrices.mts';

const shell = './apps/shell-super-app';
const matrices = Result.getOrThrow(
  parseCiMatrices(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
    readFileSync(new URL('../ci-matrices.demo.json', import.meta.url), 'utf-8'),
  ),
);
const owners = matrices.integration.filter(({ suite }) => suite === 'integration');

it('keeps complete, small Shell batches and separates the former straggler files', () => {
  const shellTasks = owners.flatMap(({ tasks }) => tasks ?? []).filter((task) => task.startsWith(`${shell}#`));
  const count = Number(shellTasks[0]?.split('/').at(-1));
  expect(Number.isSafeInteger(count)).toBe(true);
  expect(count).toBeGreaterThan(0);
  expect(shellTasks.toSorted()).toEqual(
    Array.from({ length: count }, (_, index) => `${shell}#${index + 1}/${count}`).toSorted(),
  );

  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-shell-batches-'));
  try {
    const listing = path.join(directory, 'files.json');
    const list = (shard?: string) => {
      execFileSync(
        fileURLToPath(new URL('../../node_modules/.bin/rstest', import.meta.url)),
        [
          'list',
          '--project',
          'integration',
          '--filesOnly',
          '--json',
          listing,
          ...(shard === undefined ? [] : ['--shard', shard]),
        ],
        { cwd: fileURLToPath(new URL('../../apps/shell-super-app/', import.meta.url)), stdio: 'pipe' },
      );
      return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.Struct({ file: Schema.String }))))(
        readFileSync(listing, 'utf-8'),
      ).map(({ file }) => file);
    };
    const files = list();
    expect(files.length).toBeGreaterThan(0);
    const batches = shellTasks.map((task) => list(task.slice(`${shell}#`.length)));
    expect(batches.flat().toSorted()).toEqual(files.toSorted());
    // PR1561's two-file bound fits main's 32 files. Demo's 24 duration-packed tasks cover 54 runnable files.
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(3);
    }
    const batchOf = (filename: string) =>
      batches.findIndex((batch) => batch.some((file) => path.basename(file) === filename));
    const accessAdmin = batchOf('access-admin-shell-http.test.ts');
    const privacyDispatch = batchOf('privacy-dispatch-gateway-native.test.ts');
    expect(accessAdmin).toBeGreaterThanOrEqual(0);
    expect(privacyDispatch).toBeGreaterThanOrEqual(0);
    expect(accessAdmin).not.toBe(privacyDispatch);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

it('keeps exclusive market and pricing work on different owner runners', () => {
  const market = owners.filter(({ tasks }) => tasks?.includes('./verticals/commerce-market-catalog#1/4') === true);
  const pricing = owners.filter(({ tasks }) => tasks?.includes('whole:pricing') === true);
  expect(market).toHaveLength(1);
  expect(pricing).toHaveLength(1);
  expect(market[0]?.name).not.toBe(pricing[0]?.name);
});
