import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const ACTION_URL = new URL('../../../.github/actions/install-app/action.yml', import.meta.url);
const expression = (body: string) => `\${{ ${body} }}`;
const DERIVED_PATHS = expression('steps.packages.outputs.paths');
/** The only programs the listing step runs; a fixed PATH keeps the fixture independent of this machine. */
const STEP_PATH = '/usr/bin:/bin';
const COMPLETE_INSTALL = "inputs.install-args == ''";
/** The node_modules globs the installed-workspace cache once spelled out, which missed root-level packages. */
const LITERAL_PATTERNS = ['apps/*', 'packages/*', 'verticals/*'];
const ROOT_PACKAGE = 'root-package';

const StepSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.String,
  run: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const ActionSchema = Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(StepSchema) }) });

const {
  runs: { steps },
} = Schema.decodeUnknownSync(ActionSchema)(parse(readFileSync(ACTION_URL, 'utf-8')));
const step = (id: string) => {
  const found = steps.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`install-app has no step ${id}`);
  }
  return found;
};

const blocks = /^(?<name>\w+)<<EOF\n(?<body>[\s\S]*?)\nEOF$/gmu;

/** Runs the action's package listing in `workspace`, as the composite step does in app/. */
const derive = (workspace: string) => {
  const output = path.join(workspace, '.github-output');
  writeFileSync(output, '');
  try {
    execFileSync('/bin/bash', ['-c', step('packages').run ?? ''], {
      cwd: workspace,
      env: { GITHUB_OUTPUT: output, PATH: STEP_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return 'failed';
  }
  const outputs = new Map<string, readonly string[]>();
  for (const { groups } of readFileSync(output, 'utf-8').matchAll(blocks)) {
    outputs.set(groups?.name ?? '', (groups?.body ?? '').split('\n'));
  }
  return { directories: outputs.get('directories') ?? [], paths: outputs.get('paths') ?? [] };
};

/** Every directory of `workspace` one or two levels deep that carries a package manifest. */
const childDirectories = (workspace: string, parent: string): readonly string[] =>
  readdirSync(path.join(workspace, parent), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() && entry.name !== 'node_modules' ? [path.posix.join(parent, entry.name)] : [],
  );
const manifestDirectories = (workspace: string): readonly string[] =>
  childDirectories(workspace, '')
    .flatMap((directory) => [directory, ...childDirectories(workspace, directory)])
    .filter((directory) => existsSync(path.join(workspace, directory, 'package.json')));

/** The manifest directories a cache path list would leave without their node_modules. */
const uncovered = (workspace: string, directories: readonly string[]) =>
  manifestDirectories(workspace).filter((directory) => !directories.includes(directory));

const withWorkspace = (listing: string, body: (workspace: string) => void) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'install-app-cache-paths-'));
  try {
    writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), listing);
    for (const directory of ['apps/shell', 'verticals/catalog', 'packages/core', ROOT_PACKAGE]) {
      mkdirSync(path.join(workspace, directory), { recursive: true });
      writeFileSync(path.join(workspace, directory, 'package.json'), '{}');
    }
    mkdirSync(path.join(workspace, 'apps/notes'), { recursive: true });
    body(workspace);
  } finally {
    rmSync(workspace, { force: true, recursive: true });
  }
};

const LISTING = [
  'catalogs: {}',
  '',
  'packages:',
  '  - apps/*',
  '  # A package at the workspace root.',
  '  - verticals/*',
  '  - packages/*',
  `  - '${ROOT_PACKAGE}'`,
  'enableGlobalVirtualStore: false',
  '',
].join('\n');

it('caches the node_modules of every package the workspace lists, root-level packages included', () => {
  withWorkspace(LISTING, (workspace) => {
    const derived = derive(workspace);
    if (derived === 'failed') {
      throw new Error('the package listing failed on a supported workspace');
    }
    const { directories, paths } = derived;
    expect(directories).toEqual(['apps/shell', 'verticals/catalog', 'packages/core', ROOT_PACKAGE]);
    expect(paths).toEqual([
      'app/node_modules',
      '!app/node_modules/.cache',
      ...directories.map((directory) => `app/${directory}/node_modules`),
    ]);
    expect(uncovered(workspace, directories)).toEqual([]);
  });
});

it('leaves out a root-level package the workspace does not list, which the uncovered check reports', () => {
  withWorkspace(LISTING.replace(`  - '${ROOT_PACKAGE}'\n`, ''), (workspace) => {
    const derived = derive(workspace);
    if (derived === 'failed') {
      throw new Error('the package listing failed on a supported workspace');
    }
    expect(uncovered(workspace, derived.directories)).toEqual([ROOT_PACKAGE]);
  });
});

it('refuses a workspace pattern the cache key does not hash', () => {
  for (const pattern of ['apps/**', '!apps/notes', 'apps/*/nested', '..', '.']) {
    withWorkspace(`packages:\n  - apps/*\n  - '${pattern}'\n`, (workspace) => {
      expect(derive(workspace), pattern).toBe('failed');
    });
  }
});

it('restores and saves only the derived paths, only for complete installs, and never re-saves an exact hit', () => {
  expect(step('packages').if).toBe(COMPLETE_INSTALL);
  expect(step('workspace').if).toBe(COMPLETE_INSTALL);
  expect(step('workspace').with?.path).toBe(DERIVED_PATHS);
  expect(step('workspace').with?.key).toContain("'app/*/package.json', 'app/*/*/package.json'");
  expect(step('restored').if).toBe(COMPLETE_INSTALL);
  const save = steps.find(({ name }) => name === 'Save the installed workspace');
  expect(save?.with?.path).toBe(DERIVED_PATHS);
  expect(save?.if).toContain("steps.workspace.outputs.cache-hit != 'true'");
  for (const { name, run } of steps) {
    for (const pattern of LITERAL_PATTERNS) {
      expect(run ?? '', name).not.toContain(`${pattern}/node_modules`);
    }
  }
});
