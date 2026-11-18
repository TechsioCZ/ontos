import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { parseCiMatrices } from '../ci/ci-matrices.mts';
import type { CiScope } from '../plan-ci-checks.mts';
import { inScope } from '../plan-ci-checks.mts';

/*
 * The demo trunk's own CI rules, which main does not have. A diff inside a scope of scripts/ci-matrices.json runs only
 * the scope's source rows, the static contracts, the lint of the changed files and the unit rows of the packages it
 * changes: no unit is built and no service starts. These tests prove that nothing those skipped rows run reads a
 * scoped file, so a new import or path into a scoped file takes it out of its scope here instead of letting a broken
 * runtime change through the gates.
 */

const repository = path.resolve(import.meta.dirname, '../../..');
/** The demo trunk's matrices: the shared file with the overlay its gates workflow names. */
const templates = Result.getOrThrow(
  parseCiMatrices(
    readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
    readFileSync(new URL('../ci-matrices.demo.json', import.meta.url), 'utf-8'),
  ),
);
const rootLevelPackageDirectories = templates['root-packages'] ?? [];
/** A missing scope matches nothing, which the first test reports. */
const scope = (name: string): CiScope =>
  (templates.scopes ?? []).find((entry) => entry.name === name) ?? { name, paths: ['!**'], source: ['missing'] };
const STAGE = scope('the stage delivery and the repository tooling tests');
const STOREFRONTS = scope('the storefronts');

const tracked = execFileSync('/usr/bin/git', ['ls-files', '-z'], {
  cwd: repository,
  encoding: 'utf-8',
  maxBuffer: 268_435_456,
})
  .split('\0')
  .filter(Boolean);
const documentation = (file: string) => file.endsWith('.md') || /(?:^|\/)(?:docs|specs)\//u.test(file);
/** The repository tooling tests: the Rstest `scripts` project (app/rstest.config.ts), which every scope runs. */
const toolingTest = (file: string) =>
  /^app\/scripts\/.+\.test\.mts$/u.test(file) && !/^app\/scripts\/(?:integration|scaffolding)\//u.test(file);

/** A file's text without comments, so that prose naming a file is not taken for a read. */
const code = (file: string) => {
  const text = readFileSync(path.join(repository, file), 'utf-8');
  return /\.(?:[cm]?[jt]sx?)$/u.test(file)
    ? text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(?<before>^|[^:'"`\\])\/\/.*$/gmu, '$<before>')
    : text.replaceAll(/^\s*#.*$/gmu, '');
};
const sources = new Map(
  tracked
    .filter((file) => /\.(?:[cm]?[jt]sx?|sh|ya?ml|json|txt|toml)$/u.test(file) && !documentation(file))
    .map((file) => [file, code(file)]),
);

/**
 * How a referrer names a file: by its file name, an .mts also by its emitted .mjs or .js name. A test file is named
 * with its directory, so that a tooling test is not mistaken for an integration test of the same name.
 */
const names = (file: string) => {
  if (file.startsWith('.github/actions/deliver-stage/')) {
    return ['actions/deliver-stage'];
  }
  const base = path.posix.basename(file);
  if (toolingTest(file)) {
    return [`${path.posix.basename(path.posix.dirname(file))}/${base}`, `./${base}`];
  }
  return base.endsWith('.mts') ? [base, base.replace(/\.mts$/u, '.mjs'), base.replace(/\.mts$/u, '.js')] : [base];
};

it('names only source rows the matrices have, and runs the tooling tests in every scope', () => {
  expect((templates.scopes ?? []).map(({ name }) => name)).toEqual([STAGE.name, STOREFRONTS.name]);
  for (const entry of templates.scopes ?? []) {
    for (const name of entry.source) {
      expect(
        templates.source.some((row) => row.name === name),
        `${entry.name}: ${name}`,
      ).toBe(true);
    }
    expect(
      entry.source.filter((name) => name.startsWith('Repository Tooling Tests ')),
      entry.name,
    ).toHaveLength(3);
  }
});

it('keeps every stage-delivery file out of everything a scoped plan skips', () => {
  const scoped = tracked.filter((file) => inScope(STAGE, file));
  // Every listed path exists, so a renamed file cannot leave a stale entry that matches nothing.
  for (const glob of STAGE.paths.filter((entry) => !entry.includes('*'))) {
    expect(tracked, glob).toContain(glob);
  }
  expect(scoped).toContain('.github/workflows/zerops-stage.yml');
  expect(scoped).toContain('app/scripts/zerops/prove-app-runtime.mts');
  const scopedSet = new Set(scoped);
  const readers = scoped.flatMap((file) =>
    [...sources]
      .filter(
        ([referrer, text]) =>
          referrer !== file &&
          !scopedSet.has(referrer) &&
          !toolingTest(referrer) &&
          // The scopes' own definition.
          referrer !== 'app/scripts/ci-matrices.json' &&
          // `pnpm quality:audit:test` runs tooling tests, exactly as the tooling rows do.
          !(referrer === 'app/package.json' && toolingTest(file)) &&
          // The Zerops build and start commands run in the deploy, never in a gate.
          referrer !== 'app/zerops.yaml' &&
          // The deploy planner names its stage workflow and delivery action as delivery roots: paths it classifies a
          // diff by. The gates import it only for unit identities, which never follow those roots.
          !(
            referrer === 'app/scripts/zerops/delivery-plan.mts' &&
            (file === '.github/workflows/zerops-stage.yml' || file.startsWith('.github/actions/deliver-stage/'))
          ) &&
          names(file).some((name) => text.includes(name)),
      )
      .map(([referrer]) => `${referrer} names ${file}`),
  );
  expect(readers).toEqual([]);
  // Only tooling tests and their one fixture among the tests: an integration suite or a package test is never scoped.
  expect(
    scoped.filter((file) => file.startsWith('app/') && !file.startsWith('app/scripts/zerops/') && !toolingTest(file)),
  ).toEqual(['app/scripts/tests/zerops-deployment.fixture.mts']);
});

it('keeps every scoped storefront file out of everything a scoped plan skips', () => {
  const storefronts = rootLevelPackageDirectories.map((directory) => `app/${directory}/`);
  expect(STOREFRONTS.paths.filter((glob) => !glob.startsWith('!'))).toEqual(storefronts.map((root) => `${root}**`));
  // What the skipped rows run: the packages, the gates' scripts and the gates workflow with its install action. The
  // stage delivery and the local operator and font tools are not run by any gate.
  const skippedReaders = [...sources].filter(
    ([file]) =>
      /^app\/(?:apps|packages|verticals)\//u.test(file) ||
      (file.startsWith('app/scripts/') &&
        !toolingTest(file) &&
        !inScope(STAGE, file) &&
        !/^app\/scripts\/(?:demo|fonts)\//u.test(file)) ||
      file === '.github/workflows/ultramodern-workspace-gates.yml' ||
      file.startsWith('.github/actions/install-app/'),
  );
  const reads = skippedReaders.flatMap(([file, text]) =>
    [...text.matchAll(/(?<root>akros-storefront|n1-storefront)\/(?<rest>[\w@./-]+)/gu)]
      .map(({ groups }) => `app/${groups?.root ?? ''}/${groups?.rest ?? ''}`)
      .filter((named) =>
        tracked.some((entry) => (entry === named || entry.startsWith(`${named}/`)) && inScope(STOREFRONTS, entry)),
      )
      .map((named) => `${file} reads ${named}`),
  );
  expect(reads).toEqual([]);
  // No workspace package depends on a storefront, so a storefront change selects no other package's rows.
  const dependents = tracked
    .filter((file) => /^app\/(?:apps|packages|verticals)\/[^/]+\/package\.json$/u.test(file))
    .filter((file) => {
      const manifest = readFileSync(path.join(repository, file), 'utf-8');
      return rootLevelPackageDirectories.some((name) => manifest.includes(`"${name}"`));
    });
  expect(dependents).toEqual([]);
  // The generated catalogue a Merchandise script reads stays outside the scope.
  expect(inScope(STOREFRONTS, 'app/akros-storefront/src/catalog-import/generated/catalog.generated.json')).toBe(false);
});

const TsconfigSchema = Schema.Struct({
  files: Schema.optional(Schema.Array(Schema.String)),
  include: Schema.optional(Schema.Array(Schema.String)),
  references: Schema.optional(Schema.Array(Schema.Struct({ path: Schema.String }))),
});
/**
 * The app-relative trees and files a TS-Go program compiles, with the projects it references: each include or file
 * up to its first wildcard, or the project's whole directory when it names neither. `''` is the whole app.
 */
const programInputs = (project: string, seen = new Set<string>()): readonly string[] => {
  const file = project.endsWith('.json') ? project : path.posix.join(project, 'tsconfig.json');
  if (seen.has(file)) {
    return [];
  }
  seen.add(file);
  const config = Schema.decodeUnknownSync(Schema.fromJsonString(TsconfigSchema))(
    readFileSync(path.join(repository, 'app', file), 'utf-8'),
  );
  const directory = path.posix.dirname(file);
  const entries = [...(config.include ?? []), ...(config.files ?? [])].map((entry) => {
    const resolved = path.posix.normalize(path.posix.join(directory, entry));
    const wildcard = resolved.search(/[*?{]/u);
    return wildcard === -1 ? resolved : resolved.slice(0, resolved.lastIndexOf('/', wildcard) + 1);
  });
  const own =
    config.include === undefined && config.files === undefined ? [directory === '.' ? '' : `${directory}/`] : entries;
  return [
    ...own,
    ...(config.references ?? []).flatMap((reference) =>
      programInputs(path.posix.join(directory, reference.path), seen),
    ),
  ];
};
const RootScriptsSchema = Schema.Struct({ scripts: Schema.Record(Schema.String, Schema.String) });
const { scripts } = Schema.decodeUnknownSync(Schema.fromJsonString(RootScriptsSchema))(
  readFileSync(path.join(repository, 'app/package.json'), 'utf-8'),
);

/**
 * What each command of a source row that some scope skips reads: app-relative trees (ending in `/`) and files, `''`
 * for the whole app. The TS-Go programs are read from their tsconfig files; the scripts' inputs are the trees they
 * walk (scripts/check-ontos-api-boundaries.mts, check-handler-service-provision.mts, generate-shell-ui-candidates.mts,
 * check-module-entrypoint-boundaries.mts, authorization-catalog-report.mts and authorization-catalog-artifact.mts, and
 * the files the generation tests copy). What a command imports is found by the name checks above. A command that
 * walks the whole app, as the repository policy does, can therefore never be skipped by a scope, and a new command in
 * a skipped row fails here until its inputs are declared.
 */
const PACKAGES = 'packages/';
const VERTICALS = 'verticals/';
const WORKSPACE = ['apps/', PACKAGES, VERTICALS, 'topology/'];
const skippedCommandInputs = new Map<string, readonly string[]>([
  ['pnpm --filter ./packages/shared-contracts test:types', ['packages/shared-contracts/']],
  // Each storefront's tsconfig.typecheck.json also references workspace packages and verticals.
  [
    'pnpm --filter akros-storefront --filter n1-storefront run typecheck',
    [...programInputs('akros-storefront'), ...programInputs('n1-storefront'), PACKAGES, VERTICALS],
  ],
  ['pnpm api:check:ontos', [...WORKSPACE, 'package.json']],
  ['pnpm handler-services:check', WORKSPACE],
  [
    'pnpm lint:effect-diagnostics',
    [...(scripts['lint:effect-diagnostics'] ?? '').matchAll(/--project (?<project>\S+)/gu)].flatMap(({ groups }) =>
      programInputs(groups?.project ?? '.'),
    ),
  ],
  ['pnpm module-entrypoints:check', [...WORKSPACE, 'scripts/zerops/module-credential-callers.generated.mts']],
  ['pnpm shell:ui-candidates:check', ['apps/shell-super-app/', VERTICALS]],
  ['pnpm test:generation', ['scripts/scaffolding/', ...WORKSPACE]],
  ['pnpm typecheck', programInputs('tsconfig.json')],
]);
/** Whether a repository path lies in an app-relative input. */
const readBy = (file: string, input: string) =>
  input === '' || file === `app/${input}` || file.startsWith(input.endsWith('/') ? `app/${input}` : `app/${input}/`);

it('skips no source command that reads a scoped file, whether it names the file or walks its tree', () => {
  const skipped = (entry: CiScope) =>
    templates.source
      .filter(({ name }) => !entry.source.includes(name))
      .flatMap(({ commands }) => commands.split('\n').filter(Boolean));
  const scopes = templates.scopes ?? [];
  // Every skipped command is declared, and every declared one is still skipped somewhere.
  expect([...skippedCommandInputs.keys()].toSorted()).toEqual([...new Set(scopes.flatMap(skipped))].toSorted());
  // The derived TS-Go inputs are the packages' own trees, so a program that compiles a scoped file is caught.
  expect(skippedCommandInputs.get('pnpm typecheck')?.length).toBeGreaterThan(40);
  expect(skippedCommandInputs.get('pnpm lint:effect-diagnostics')).toContain('scripts/scaffolding/');
  const reads = scopes.flatMap((entry) => {
    const scoped = tracked.filter((file) => inScope(entry, file));
    return skipped(entry).flatMap((command) =>
      (skippedCommandInputs.get(command) ?? ['']).flatMap((input) =>
        scoped
          .filter((file) => readBy(file, input))
          .map((file) => `${entry.name} skips ${command}, which reads ${file}`),
      ),
    );
  });
  expect(reads).toEqual([]);
  // The whole-tree walker of the policy is declared as such, so no scope may skip a row that runs it.
  expect(readBy('app/n1-storefront/src/app/page.tsx', '')).toBe(true);
  expect(scopes.flatMap(skipped)).not.toContain('pnpm lint:repository-policy');
});

/** A push run as the run list returns it; a run without a conclusion is still running. */
const run = (sha: string, conclusion: string | null) => ({
  conclusion,
  head_sha: sha,
  status: conclusion === null ? 'in_progress' : 'completed',
});
const green = (sha: string) => run(sha, 'success');

const StepsSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      steps: Schema.optional(
        Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), run: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});

it('compares a demo push with the newest green ancestor, and runs everything without one', () => {
  const plan = Schema.decodeUnknownSync(StepsSchema)(
    parse(readFileSync(path.join(repository, '.github/workflows/ultramodern-workspace-gates.yml'), 'utf-8')),
  ).jobs['ci-plan'];
  // The run list of this workflow is read with the job's own token.
  expect(plan?.permissions).toEqual({ actions: 'read', contents: 'read' });
  const script = plan?.steps?.find(({ id }) => id === 'proven-base')?.run ?? 'exit 1';
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-proven-base-'));
  const git = (...args: readonly string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args], {
      cwd: directory,
      encoding: 'utf-8',
    }).trim();
  const commit = (message: string) => {
    git('commit', '--allow-empty', '--quiet', '--message', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '--quiet', '--initial-branch', 'demo');
    const first = commit('first');
    const second = commit('second');
    git('checkout', '--quiet', '--orphan', 'elsewhere');
    const unrelated = commit('unrelated');
    git('checkout', '--quiet', 'demo');
    const head = commit('head');
    const bin = path.join(directory, '.bin');
    mkdirSync(bin);
    // The fake GitHub API answers `gh api <path> --jq <filter>` through jq: the workflow of this run, then its push
    // runs on the branch, newest first, as the unfiltered list returns them.
    writeFileSync(
      path.join(bin, 'gh'),
      [
        '#!/bin/bash',
        '[[ "$FAIL" != true ]] || exit 1',
        'body="$RUNS"',
        '[[ "$2" != */actions/runs/* ]] || body=\'{"workflow_id":7}\'',
        'exec jq -r "$4" <<<"$body"',
        '',
      ].join('\n'),
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    const base = (runs: readonly ReturnType<typeof run>[], fail = false) => {
      const output = path.join(directory, '.output');
      writeFileSync(output, '');
      execFileSync('/bin/bash', ['-e', '-c', script], {
        cwd: directory,
        env: {
          FAIL: String(fail),
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'owner/repository',
          GITHUB_RUN_ID: '1',
          GITHUB_SHA: head,
          PATH: `${bin}:/usr/bin:/bin`,
          RUNS: JSON.stringify({ workflow_runs: runs }),
        },
        stdio: 'pipe',
      });
      return readFileSync(output, 'utf-8').trim();
    };
    // The commit itself and a commit outside its history never count; the newest green ancestor does.
    expect(base([green(head), green(unrelated), green(second), green(first)])).toBe(`base=${second}`);
    // A failed, cancelled or still running run proves nothing, so its commit is compared past.
    expect(base([run(head, null), run(second, 'failure'), run(second, 'cancelled'), green(first)])).toBe(
      `base=${first}`,
    );
    // No green ancestor, no answer or an unreadable answer: no base, so the complete suite runs.
    expect(base([green(unrelated), green(head), run(first, 'failure')])).toBe('');
    expect(base([])).toBe('');
    expect(base([green(second)], true)).toBe('');
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
