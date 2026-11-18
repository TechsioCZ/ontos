import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const ACTION_URL = new URL('../../../.github/actions/install-app/action.yml', import.meta.url);
const UTF8 = 'utf-8';
const MANIFEST = 'package.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';
/** The only programs the listing step runs (sha256sum is in /sbin on macOS); a fixed PATH keeps the run hermetic. */
const STEP_PATH = '/usr/bin:/bin:/sbin';
const KEY_STEP = 'Name the installed workspace';
const APP = fileURLToPath(new URL('../..', import.meta.url));
const expression = (body: string) => `\${{ ${body} }}`;
const DERIVED_PATHS = expression('steps.packages.outputs.paths');
const DERIVED_MANIFESTS = expression('steps.packages.outputs.manifests');

const StepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const ActionSchema = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(StepSchema) }) });
const WorkspaceSchema = Schema.Struct({ packages: Schema.Array(Schema.String) });

const {
  runs: { steps },
} = Schema.decodeUnknownSync(ActionSchema)(parse(readFileSync(ACTION_URL, UTF8)));
const step = (name: string) => {
  const found = steps.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`install-app has no step ${name}`);
  }
  return found;
};
const LISTING_STEP = step('List the workspace packages');

const blocks = /^(?<name>\w+)<<EOF\n(?<body>[\s\S]*?)\nEOF$/gmu;

/** Runs the action's package listing in `workspace`, as the composite step does in app/. */
const derive = (workspace: string) => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'install-app-output-'));
  const output = path.join(scratch, 'github-output');
  writeFileSync(output, '');
  let text = '';
  try {
    execFileSync('/bin/bash', ['-c', LISTING_STEP.run ?? ''], {
      cwd: workspace,
      encoding: UTF8,
      env: { GITHUB_OUTPUT: output, PATH: STEP_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    text = readFileSync(output, UTF8);
  } catch (error) {
    // The step's own diagnostic, so a test tells the action's rejection from any other failure.
    return { failed: Schema.decodeUnknownSync(Schema.Struct({ stdout: Schema.String }))(error).stdout };
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
  const outputs = new Map<string, readonly string[]>();
  for (const { groups } of text.matchAll(blocks)) {
    outputs.set(groups?.name ?? '', (groups?.body ?? '').split('\n'));
  }
  return {
    directories: outputs.get('directories') ?? [],
    manifests: /^manifests=(?<hash>\w+)$/mu.exec(text)?.groups?.hash ?? '',
    paths: outputs.get('paths') ?? [],
  };
};
const deriveOrThrow = (workspace: string) => {
  const derived = derive(workspace);
  if ('failed' in derived) {
    throw new Error(`the package listing failed in ${workspace}: ${derived.failed}`);
  }
  return derived;
};

/** The directories under `workspace` one glob segment at a time matches, with `*` and `?` inside a segment. */
const expand = (workspace: string, segments: readonly string[], parent = ''): readonly string[] => {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return [parent];
  }
  const source = segment
    .replaceAll(/[.+^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  const matcher = new RegExp(`^${source}$`, 'u');
  return readdirSync(path.join(workspace, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && matcher.test(entry.name))
    .flatMap((entry) => expand(workspace, rest, path.posix.join(parent, entry.name)));
};

/** The package directories pnpm takes from `packages:`: every positive glob's manifests, minus every negation's. */
const workspacePackages = (workspace: string) => {
  const { packages } = Schema.decodeUnknownSync(WorkspaceSchema)(
    parse(readFileSync(path.join(workspace, WORKSPACE_FILE), UTF8)),
  );
  const matches = (patterns: readonly string[]) =>
    patterns.flatMap((pattern) =>
      expand(workspace, pattern.split('/')).filter((directory) =>
        existsSync(path.join(workspace, directory, MANIFEST)),
      ),
    );
  const negated = packages.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1));
  const excluded = new Set(matches(negated));
  const included = matches(packages.filter((pattern) => !pattern.startsWith('!')));
  return EffectArray.sort(
    [...new Set(included)].filter(
      (directory) => !excluded.has(directory) && !directory.split('/').includes('node_modules'),
    ),
    Order.String,
  );
};

/** The workspace packages whose node_modules the cached paths leave out. */
const uncovered = (workspace: string, paths: readonly string[]) =>
  workspacePackages(workspace).filter((directory) => !paths.includes(`app/${directory}/node_modules`));

const withWorkspace = (listing: string, directories: readonly string[], body: (workspace: string) => void) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'install-app-cache-paths-'));
  try {
    writeFileSync(path.join(workspace, WORKSPACE_FILE), listing);
    for (const directory of directories) {
      mkdirSync(path.join(workspace, directory), { recursive: true });
      writeFileSync(path.join(workspace, directory, MANIFEST), `{"name":"${directory}"}`);
    }
    body(workspace);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};
const addPackage = (workspace: string, directory: string) => {
  mkdirSync(path.join(workspace, directory), { recursive: true });
  writeFileSync(path.join(workspace, directory, MANIFEST), '{}');
};

const LISTING = [
  'catalogs: {}',
  '',
  'packages:',
  '  - apps/*',
  '  # A package at the workspace root.',
  '  - "verticals/*" # quoted, with a comment',
  "  - 'packages/*'",
  '  - root-package',
  "  - '!packages/fixture-*'",
  'enableGlobalVirtualStore: false',
  '',
].join('\n');
const FIXTURE = ['apps/shell', 'verticals/catalog', 'packages/core', 'packages/fixture-a', 'root-package', 'other/x'];

it('caches and keys the node_modules of every package this workspace declares', () => {
  const { directories, manifests, paths } = deriveOrThrow(APP);
  expect(directories).toEqual(workspacePackages(APP));
  expect(uncovered(APP, paths)).toEqual([]);
  expect(paths.slice(0, 2)).toEqual(['app/node_modules', '!app/node_modules/.cache']);
  expect(manifests).toMatch(/^[0-9a-f]{64}$/u);
});

it('follows the packages: globs, negations, quotes and comments of a workspace file', () => {
  withWorkspace(LISTING, FIXTURE, (workspace) => {
    const { directories, paths } = deriveOrThrow(workspace);
    expect(directories).toEqual(['apps/shell', 'packages/core', 'root-package', 'verticals/catalog']);
    expect(directories).toEqual(workspacePackages(workspace));
    expect(uncovered(workspace, paths)).toEqual([]);
  });
});

it('covers a package directory added to the workspace in the cached paths and the key', () => {
  withWorkspace(LISTING, FIXTURE, (workspace) => {
    const before = deriveOrThrow(workspace);
    addPackage(workspace, 'apps/added');
    expect(uncovered(workspace, before.paths)).toEqual(['apps/added']);
    const after = deriveOrThrow(workspace);
    expect(uncovered(workspace, after.paths)).toEqual([]);
    expect(after.manifests).not.toBe(before.manifests);

    writeFileSync(
      path.join(workspace, WORKSPACE_FILE),
      LISTING.replace('  - root-package\n', '  - root-package\n  - extra\n'),
    );
    addPackage(workspace, 'extra');
    const declared = deriveOrThrow(workspace);
    expect(declared.directories).toContain('extra');
    expect(uncovered(workspace, declared.paths)).toEqual([]);
    expect(declared.manifests).not.toBe(after.manifests);
  });
});

it('refuses a workspace file it cannot expand exactly', () => {
  for (const entry of ['apps/**', '../outside', './apps/*', '{a,b}/*', '[unclosed']) {
    withWorkspace(`packages:\n  - apps/*\n  - '${entry}'\n`, FIXTURE, (workspace) => {
      expect(derive(workspace), entry).toEqual({
        failed: `::error::The install action expands only '*' and '?' inside package directories; app/pnpm-workspace.yaml lists '${entry}'.\n`,
      });
    });
  }
  withWorkspace('packages: [apps/*]\n', FIXTURE, (workspace) => {
    expect(derive(workspace)).toEqual({ failed: '::error::app/pnpm-workspace.yaml lists no package directory.\n' });
  });
  withWorkspace('packages:\n  - apps/*\n  -\n    - nested\n', FIXTURE, (workspace) => {
    expect(derive(workspace)).toEqual({
      failed: '::error::The install action cannot read this packages: entry of app/pnpm-workspace.yaml:   -\n',
    });
  });
});

it('restores and saves exactly the derived paths under a key that names every package manifest', () => {
  const key = step(KEY_STEP);
  const restore = step('Restore the installed workspace');
  const save = step('Save the installed workspace');
  expect(restore.with?.path).toBe(DERIVED_PATHS);
  expect(save.with?.path).toBe(DERIVED_PATHS);
  expect(key.run).toContain(DERIVED_MANIFESTS);
  expect(key.run).toContain("'app/pnpm-workspace.yaml'");
  expect(restore.with?.key).toBe(expression('steps.workspace-key.outputs.key'));
  expect(save.with?.key).toBe(expression('steps.workspace.outputs.cache-primary-key'));
  for (const { name, run, with: inputs } of steps) {
    expect(`${run ?? ''}${JSON.stringify(inputs ?? {})}`, name).not.toMatch(
      /(?:apps|packages|verticals)\/\*\/node_modules/u,
    );
  }
});

it('keys the installed workspace on its install code and both hosted runner image variables', () => {
  const key = step(KEY_STEP);
  expect(key.id).toBe('workspace-key');
  expect(key.run).toContain("hashFiles('.github/actions/install-app/action.yml',");
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'install-app-key-'));
  const output = path.join(scratch, 'github-output');
  try {
    // GitHub evaluates these expressions before bash runs; leave the image reads to the actual step.
    const run = (key.run ?? '').replaceAll(/\$\{\{.*?\}\}/gu, 'hash');
    for (const [ImageOS, ImageVersion] of [
      ['ubuntu24', '20261109.1.0'],
      ['ubuntu24', '20261116.1.0'],
      ['ubuntu26', '20261116.1.0'],
    ]) {
      writeFileSync(output, '');
      execFileSync('/bin/bash', ['-c', run], {
        env: { GITHUB_OUTPUT: output, ImageOS, ImageVersion, PATH: STEP_PATH },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(readFileSync(output, UTF8)).toBe(`key=pnpm-workspace-hash-hash-${ImageOS}-${ImageVersion}-hash-hash\n`);
    }
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
});

it('never saves an exact hit again and lets a caller opt out of the gates tree', () => {
  const optedIn = "inputs.restore-node-modules == 'true'";
  for (const name of [
    'List the workspace packages',
    KEY_STEP,
    'Restore the installed workspace',
    'Verify the restored workspace resolves',
  ]) {
    expect(step(name).if, name).toBe(optedIn);
  }
  for (const name of ['Check that the installed workspace may be published', 'Save the installed workspace']) {
    expect(step(name).if, name).toContain(optedIn);
    expect(step(name).if, name).toContain("steps.workspace.outputs.cache-hit != 'true'");
  }
});
