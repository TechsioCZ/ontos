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

/** The names a .mts file is built to: a referrer may name the .mjs or .js it emits instead. */
const emitted = (file: string) =>
  file.endsWith('.mts') ? [file, file.replace(/\.mts$/u, '.mjs'), file.replace(/\.mts$/u, '.js')] : [file];

/** The paths a text names: files, the directories a word with a slash names, and the globs of such words. */
interface NamedPaths {
  readonly files: ReadonlySet<string>;
  readonly globs: readonly string[];
  readonly trees: ReadonlySet<string>;
}

/**
 * The paths a referrer's text names. Each word that a quote, a bracket, a separator or a space leaves is resolved
 * against the referrer's directory, the app root and the repository root, because a script or an import reads from
 * each of them. A `${…}` interpolation is a wildcard. Only a word with a slash names a directory or a glob: a bare
 * word such as `scripts` in prose or `*` in a pattern names nothing but a file beside the referrer.
 */
const namedPaths = (referrer: string, text: string): NamedPaths => {
  const files = new Set<string>();
  const trees = new Set<string>();
  const globs = new Set<string>();
  const words = text
    .replaceAll(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/gu, '*')
    .split(/[\s'"`()[\]{},;=<>|&]+/u)
    .filter((word) => word.length > 0);
  for (const word of words) {
    // A stage file or directory has a dot or a slash in its name; a bare identifier names none.
    if (!word.includes('/') && !word.includes('.')) {
      continue;
    }
    const slashed = word.includes('/');
    for (const root of [path.posix.dirname(referrer), 'app', '.']) {
      const named = path.posix.normalize(path.posix.join(root, word));
      if (named.startsWith('..') || named === '.') {
        continue;
      }
      if (!word.includes('*')) {
        files.add(named);
        if (slashed) {
          trees.add(named);
        }
      } else if (
        slashed &&
        !word.includes('..') &&
        word.slice(0, word.indexOf('*')).split('/').filter(Boolean).length >= 2
      ) {
        // A glob names files only from two literal directories down, as written: `*/*`, `docs/**` or `$dir/../..`
        // name none. The wildcard is judged in the word, since normalizing a `..` after it would erase it.
        globs.add(named);
      }
    }
  }
  return { files, globs: [...globs], trees };
};

/**
 * Whether a referrer's paths name a file: as itself or its emitted name, as a directory of two or more segments that
 * it lies in, or through a glob that matches it.
 */
const namesFile = ({ files, globs, trees }: NamedPaths, file: string) => {
  const segments = file.split('/');
  const directories = Array.from({ length: segments.length - 2 }, (_, index) => segments.slice(0, index + 2).join('/'));
  return (
    emitted(file).some((name) => files.has(name)) ||
    directories.some((directory) => trees.has(directory)) ||
    globs.some((glob) => inScope({ name: glob, paths: [glob], source: [glob] }, file))
  );
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

// The deploy planner names its stage workflows and delivery action as delivery roots: paths it classifies a diff by.
const stageRoot = (file: string) =>
  /^\.github\/workflows\/zerops-[^/]*\.yml$/u.test(file) || file.startsWith('.github/actions/deliver-stage/');
const names = (referrer: string, text: string, file: string) => namesFile(namedPaths(referrer, text), file);
const PROVE_APP_RUNTIME = 'app/scripts/zerops/prove-app-runtime.mts';
const SCRATCH_WORKFLOW = '.github/workflows/x.yml';
const APP_PACKAGE_JSON = 'app/package.json';
const STABLE_TESTS_GLOB = "node --test 'ops/zerops-stable/*.test.mjs'";

/** The referrers that name a scoped file without reading it in any skipped row. */
const exempt = (referrer: string, file: string) =>
  toolingTest(referrer) ||
  // The scopes' own definition: the shared matrices and the demo overlay.
  referrer === 'app/scripts/ci-matrices.json' ||
  referrer === 'app/scripts/ci-matrices.demo.json' ||
  // `pnpm quality:audit:test` runs tooling tests, exactly as the tooling rows do.
  (referrer === APP_PACKAGE_JSON && toolingTest(file)) ||
  // The lint configuration names tooling tests in its override lists; every scope lints the files it changes.
  (referrer === 'app/oxlint.config.ts' && toolingTest(file)) ||
  // Rstest names the native tooling tests only to leave their execution to the native CI row.
  (referrer === 'app/rstest.config.ts' && toolingTest(file)) ||
  // The Zerops build and start commands run in the deploy, never in a gate.
  referrer === 'app/zerops.yaml' ||
  (referrer === 'app/scripts/zerops/delivery-plan.mts' && stageRoot(file)) ||
  // The merge planner reads its verdict table from this document. No gate runs the planner; its tooling test, which
  // every scoped plan runs, reads the real table and refuses a malformed one.
  (referrer === 'app/scripts/merge/plan.mts' && file === 'app/docs/architecture/MERGING.md') ||
  // The runtime model scans the workflow directory for the commands each workflow runs, as the deploy planner does.
  (referrer === 'app/quality-audit/knip-runtime-model.mts' && stageRoot(file)) ||
  // The app runtime manifest names the whole app/scripts tree for the migrator artifact that the gates workflow's
  // migrator job assembles; that job is no ci-matrices row, so no scope skips it.
  referrer === 'app/scripts/zerops/app-runtime-paths.txt' ||
  // The operator's stable catalogue copy runs by hand against stable, never in a gate or a stage delivery; it reuses
  // the stable bootstrap's readers.
  (referrer === 'app/scripts/demo/copy-stage-catalog-to-stable.mts' && file.startsWith('ops/zerops-stable/'));

it('keeps every stage-delivery file out of everything a scoped plan skips', () => {
  const scoped = tracked.filter((file) => inScope(STAGE, file));
  // Every listed path exists, so a renamed file cannot leave a stale entry that matches nothing.
  for (const glob of STAGE.paths.filter((entry) => !entry.includes('*'))) {
    expect(tracked, glob).toContain(glob);
  }
  expect(scoped).toContain('.github/workflows/zerops-stage.yml');
  expect(scoped).toContain(PROVE_APP_RUNTIME);
  const scopedSet = new Set(scoped);
  const readers = [...sources].flatMap(([referrer, text]) => {
    if (scopedSet.has(referrer)) {
      return [];
    }
    const named = namedPaths(referrer, text);
    return scoped
      .filter((file) => referrer !== file && !exempt(referrer, file) && namesFile(named, file))
      .map((file) => `${referrer} names ${file}`);
  });
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

it('tells a reference from a same-named file in another directory', () => {
  // A relative import names the file it resolves to, not every file with its basename.
  const importer = 'app/scripts/demo/prepare.mts';
  const verifyImport = "import { X } from '../ops/stage-demo-verify.mjs';";
  expect(names(importer, verifyImport, 'app/scripts/ops/stage-demo-verify.mjs')).toBe(true);
  expect(names(importer, verifyImport, 'ops/zerops-stable/verify.mjs')).toBe(false);
  // A prose or package-path mention of a basename is not a read of the stable file.
  expect(
    names(
      'app/packages/shared-contracts/src/index.ts',
      "optOut: 'scripts/ultramodern-performance-readiness.config.mjs#enabled=false'",
      'ops/zerops-stable/config.mjs',
    ),
  ).toBe(false);
  // A workflow names a stable script from the repository root, an app script from the app root and its emitted .mjs.
  expect(
    names(SCRATCH_WORKFLOW, 'run: node ops/zerops-stable/deploy.mjs install', 'ops/zerops-stable/deploy.mjs'),
  ).toBe(true);
  expect(names(APP_PACKAGE_JSON, '"x": "node scripts/zerops/prove-app-runtime.mjs"', PROVE_APP_RUNTIME)).toBe(true);
  // A glob names the files it matches from its literal directories; a bare `*/*` or a prose word names none.
  expect(names(SCRATCH_WORKFLOW, STABLE_TESTS_GLOB, 'ops/zerops-stable/push.test.mjs')).toBe(true);
  expect(names(SCRATCH_WORKFLOW, STABLE_TESTS_GLOB, 'ops/zerops-stable/config.mjs')).toBe(false);
  expect(names('app/scripts/x.mts', "const a = b.split('*/*');", PROVE_APP_RUNTIME)).toBe(false);
  // A directory word with a slash names the files under it; a bare word such as `scripts` in prose does not.
  expect(
    names(SCRATCH_WORKFLOW, 'uses: ./.github/actions/deliver-stage', '.github/actions/deliver-stage/action.yml'),
  ).toBe(true);
  expect(
    names('.github/workflows/quality.yml', 'Install without lifecycle scripts', 'app/scripts/tests/x.test.mts'),
  ).toBe(false);
  // A trailing slash is a prefix test in code, not a read of the directory.
  expect(names('app/scripts/ci/unit-inputs.mts', "file.startsWith('app/scripts/')", PROVE_APP_RUNTIME)).toBe(false);
  // A skipped package that imports a scoped script by its relative path still reads it.
  expect(
    names(
      'app/apps/shell-super-app/tests/integration/x.test.ts',
      "from '../../../../scripts/zerops/module-credentials.mts';",
      'app/scripts/zerops/module-credentials.mts',
    ),
  ).toBe(true);
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
  readFileSync(path.join(repository, APP_PACKAGE_JSON), 'utf-8'),
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
  ['pnpm --filter ./n1-storefront run test run', ['n1-storefront/']],
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
  ['pnpm shell:ui-candidates', ['apps/shell-super-app/', VERTICALS]],
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

it('keeps N1 in the source row without unconditional browser setup for the other source checks', () => {
  const name = 'Typecheck and OntOS API Boundary Rules';
  expect(STOREFRONTS.source).toContain(name);
  const row = templates.source.find((entry) => entry.name === name);
  expect(row?.setup).toBeUndefined();
  expect(row?.commands.trim().split('\n').at(-1)).toBe('pnpm --filter ./n1-storefront run test run');
  expect(templates.unit.some(({ commands }) => commands.includes('./n1-storefront run test run'))).toBe(false);
});
