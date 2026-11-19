import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
  .filter((file) => file.length > 0 && existsSync(path.join(repository, file)));
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
          // The scopes' own definition: the shared matrices and the demo overlay.
          referrer !== 'app/scripts/ci-matrices.json' &&
          referrer !== 'app/scripts/ci-matrices.demo.json' &&
          // `pnpm quality:audit:test` runs tooling tests, exactly as the tooling rows do.
          !(referrer === 'app/package.json' && toolingTest(file)) &&
          // The lint configuration names tooling tests in its override lists; every scope lints the files it changes.
          !(referrer === 'app/oxlint.config.ts' && toolingTest(file)) &&
          // The Zerops build and start commands run in the deploy, never in a gate.
          referrer !== 'app/zerops.yaml' &&
          // The deploy planner names its stage workflow and delivery action as delivery roots: paths it classifies a
          // diff by. The gates never import it: their unit identities come from scripts/ci/unit-inputs.mts.
          !(
            referrer === 'app/scripts/zerops/delivery-plan.mts' &&
            (file === '.github/workflows/zerops-stage.yml' || file.startsWith('.github/actions/deliver-stage/'))
          ) &&
          // The merge planner reads its verdict table from this document. No gate runs the planner; its tooling
          // test, which every scoped plan runs, reads the real table and refuses a malformed one.
          !(referrer === 'app/scripts/merge/plan.mts' && file === 'app/docs/architecture/MERGING.md') &&
          names(file).some((name) => text.includes(name)),
      )
      .map(([referrer]) => `${referrer} names ${file}`),
  );
  expect(readers).toEqual([]);
  // Only tooling tests, their one fixture and the merge verdict table that a tooling test reads: an integration suite
  // or a package test is never scoped.
  expect(
    scoped.filter((file) => file.startsWith('app/') && !file.startsWith('app/scripts/zerops/') && !toolingTest(file)),
  ).toEqual(['app/docs/architecture/MERGING.md', 'app/scripts/tests/zerops-deployment.fixture.mts']);
});

it('runs both storefront linters in the source row every storefront scope selects', () => {
  const row = templates.source.find(({ name }) => name === 'Typecheck and OntOS API Boundary Rules');
  expect(STOREFRONTS.source).toContain(row?.name);
  for (const directory of rootLevelPackageDirectories) {
    expect(row?.commands).toContain(`pnpm --filter ./${directory} run lint`);
  }
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
  ['pnpm --filter ./akros-storefront run lint', ['akros-storefront/src/', 'akros-storefront/tests/']],
  ['pnpm --filter ./n1-storefront run lint', ['n1-storefront/src/', 'n1-storefront/tests/']],
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
  [
    'pnpm lint:effect-diagnostics:demo',
    [...(scripts['lint:effect-diagnostics:demo'] ?? '').matchAll(/--project (?<project>\S+)/gu)].flatMap(({ groups }) =>
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
  expect(skippedCommandInputs.get('pnpm lint:effect-diagnostics:demo')).toContain('scripts/demo/email-dispatcher/');
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

it('runs the demo-only Effect diagnostics in pnpm check, beside the shared ones that lint runs', () => {
  // The shared `lint` line stays identical to main's, so the demo projects get their own lane of scripts/check.mts.
  expect(scripts.lint).toMatch(/&& pnpm lint:effect-diagnostics$/u);
  expect(readFileSync(new URL('../check.mts', import.meta.url), 'utf-8')).toContain(
    "['lint:effect-diagnostics:demo'],",
  );
});

const PlanJobSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ permissions: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
});

it('lets the plan job read the run list that the newest-green-push lookup needs', () => {
  // The lookup is main's, in scripts/plan-ci-changes.sh; scripts/tests/ci-change-plan.test.mts proves it.
  const plan = Schema.decodeUnknownSync(PlanJobSchema)(
    parse(readFileSync(path.join(repository, '.github/workflows/ultramodern-workspace-gates.yml'), 'utf-8')),
  ).jobs['ci-plan'];
  expect(plan?.permissions).toEqual({ actions: 'read', contents: 'read' });
});
