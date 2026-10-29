import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

const workspace = path.resolve(import.meta.dirname, '../..');
const shell = 'apps/shell-super-app';
const script = path.join(workspace, 'scripts/generate-shell-ui-candidates.mts');
const candidates = `${shell}/generated/ui-candidates`;
const ALPHA_VIEW = 'verticals/alpha/src/view.tsx';
const AVAILABILITY_VIEW = 'verticals/availability/src/view.tsx';
const ALPHA_PROJECTION = 'alpha.txt';
const CHECK = '--check';
const VERTICAL = '--vertical';
const ALL = '--all';
const GOLDEN = '--verify-css';

const outputOf = (result: ReturnType<typeof run>) => result.stdout + result.stderr;
const write = (root: string, file: string, contents: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), contents);
};
const run = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, '--workspace', root, ...args], { encoding: 'utf-8' });
const succeeds = (root: string, ...args: string[]) => {
  const result = run(root, ...args);
  expect(result.status, result.stdout + result.stderr).toBe(0);
};

const fixture = (test: (root: string) => void) =>
  Effect.gen(function* candidateFixture() {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(os.tmpdir(), 'ontos-shell-candidates-'))),
      (directory) => Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    yield* Effect.sync(() => {
      write(
        root,
        `${shell}/src/routes/ui-kit.css`,
        readFileSync(path.join(workspace, shell, 'src/routes/ui-kit.css'), 'utf-8'),
      );
      symlinkSync(path.join(workspace, shell, 'node_modules'), path.join(root, shell, 'node_modules'), 'dir');
      write(root, ALPHA_VIEW, 'export const view = <div className="p-4" />;\n');
      write(root, AVAILABILITY_VIEW, 'export const view = <div className="m-4" />;\n');
      succeeds(root, ALL);
      test(root);
    });
  }).pipe(Effect.scoped);

it.live('ignores a source rename but fails closed for a new utility, icon or theme-variable token', () =>
  fixture((root) => {
    const before = readFileSync(path.join(root, candidates, ALPHA_PROJECTION), 'utf-8');
    write(root, ALPHA_VIEW, 'export const renamed = <div className="p-4" />;\n');
    succeeds(root, CHECK, VERTICAL, 'alpha');
    expect(readFileSync(path.join(root, candidates, ALPHA_PROJECTION), 'utf-8')).toBe(before);
    for (const source of [
      '<div className="p-4 me-50" />',
      '<div className="p-4 icon-[mdi--account-plus]" />',
      'const color = "--color-red-500";',
    ]) {
      write(root, 'verticals/alpha/vertical.manifest.ts', source);
      const result = run(root, CHECK, VERTICAL, 'alpha');
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain('Stale Shell UI candidates: alpha');
      succeeds(root, ALL);
      succeeds(root, CHECK, ALL, GOLDEN);
    }
  }),
);

it.live('checks unreleased availability and new/deleted verticals instead of trusting the release matrix', () =>
  fixture((root) => {
    write(root, AVAILABILITY_VIEW, '<div className="me-50" />');
    expect(outputOf(run(root, CHECK, ALL))).toContain('availability');
    succeeds(root, ALL);
    write(root, 'verticals/new-unit/src/view.tsx', '<div className="ms-51" />');
    expect(outputOf(run(root, CHECK, ALL))).toContain('new-unit');
    succeeds(root, ALL);
    rmSync(path.join(root, 'verticals/new-unit'), { recursive: true });
    expect(outputOf(run(root, CHECK, ALL))).toContain('obsolete new-unit.txt');
    succeeds(root, ALL);
    succeeds(root, CHECK, ALL, GOLDEN);
    expect(run(root, CHECK, VERTICAL, '../alpha').status).not.toBe(0);
  }),
);

it.live(
  'the webpack compiler emits byte-identical production CSS from the committed projection and original globs',
  () => Effect.sync(() => succeeds(workspace, CHECK, ALL, GOLDEN)),
);
