import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { CiScope } from '../plan-ci-checks.mts';
import { CiTemplatesSchema, inScope, rootLevelPackageDirectories } from '../plan-ci-checks.mts';

/*
 * The demo trunk's own CI rules, which main does not have. A diff inside a scope of scripts/ci-matrices.json runs only
 * the scope's source rows, the static contracts, the lint of the changed files and the unit rows of the packages it
 * changes: no unit is built and no service starts. These tests prove that nothing those skipped rows run reads a
 * scoped file, so a new import or path into a scoped file takes it out of its scope here instead of letting a broken
 * runtime change through the gates.
 */

const repository = path.resolve(import.meta.dirname, '../../..');
const templates = Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
  readFileSync(path.join(repository, 'app/scripts/ci-matrices.json'), 'utf-8'),
);
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
