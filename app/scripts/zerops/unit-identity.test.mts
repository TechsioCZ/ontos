import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { readUnitIdentities } from './delivery-plan-cli.mts';
import {
  BUILD_DRIVER,
  BUILD_DRIVER_TOOLS,
  buildEnvironment,
  isTestInput,
  unitInputDigest,
  unitInputGraph,
  unitInputs,
} from './delivery-plan.mts';
import type { ExcludedInput, UnitInputGraph, WorkspacePackage } from './delivery-plan.mts';
import { packageEntries } from '../ci/unit-inputs.mts';

const CRM = 'app/verticals/crm';
const PARTY = 'app/verticals/party';
const OTHER = 'app/verticals/other';
const SHELL = 'app/apps/shell-super-app';
const CONTRACTS = 'app/packages/shared-contracts';
const PARTY_PACKAGE = '@app/party';
const PARTY_API = `${PARTY}/src/api.ts`;
/** A Party export no other unit imports: only a build that walks every export of Party reads it. */
const PARTY_WORKER = `${PARTY}/src/worker.ts`;
const EXPORT_WALK = 'app/scripts/complete-packaged-node-dependencies.mts';
const KIT = 'app/packages/kit';
const KIT_PACKAGE = '@app/kit';
const SHELL_PACKAGE = '@app/shell-super-app';
const KIT_SOURCE = `${KIT}/src/index.ts`;
const CRM_ENTRY = `${CRM}/src/index.ts`;
const CRM_IMPORTED_TEST_HELPER = `${CRM}/tests/support/fixture-ids.ts`;
const OWNER_ENTRY = 'app/scripts/zerops/owner-entry.mts';
const EMPTY_MODULE = 'export {};';
const ZEROPS_YAML = 'app/zerops.yaml';
const LOCKFILE = 'app/pnpm-lock.yaml';
const packages: readonly WorkspacePackage[] = [
  {
    directory: CRM,
    name: '@app/crm',
    // The Shell is a devDependency (a test helper), so only an import from included code brings it in.
    workspaceDependencies: [PARTY_PACKAGE, KIT_PACKAGE, SHELL_PACKAGE],
  },
  { directory: PARTY, name: PARTY_PACKAGE, workspaceDependencies: [] },
  { directory: OTHER, name: '@app/other', workspaceDependencies: [KIT_PACKAGE] },
  { directory: SHELL, name: SHELL_PACKAGE, workspaceDependencies: [] },
  { directory: CONTRACTS, name: '@app/shared-contracts', workspaceDependencies: [] },
  { directory: KIT, name: KIT_PACKAGE, workspaceDependencies: [] },
];
const CRM_SOURCE = [
  "import { party } from '@app/party/api';",
  "import { kit } from '@app/kit';",
  "import { ids } from '../tests/support/fixture-ids.ts';",
  'export const crm = [party, kit, ids];',
].join('\n');
/** A small commit: each file's text is what the reference scan reads, its identity is what the digest hashes. */
const FILES: readonly (readonly [string, string])[] = [
  ['.github/workflows/zerops-stage.yml', 'jobs: {}'],
  [`${CONTRACTS}/package.json`, '{"name":"@app/shared-contracts"}'],
  [`${CONTRACTS}/src/index.ts`, 'export const contract = 1;'],
  [`${CRM}/README.md`, '# CRM'],
  [
    `${CRM}/package.json`,
    JSON.stringify({
      name: '@app/crm',
      scripts: { build: 'modern build && pnpm run contract', contract: 'node ../../scripts/generate-contract.mts' },
    }),
  ],
  [`${CRM}/src/index.test.ts`, "import { crm } from './index.ts';"],
  [CRM_ENTRY, CRM_SOURCE],
  [CRM_IMPORTED_TEST_HELPER, 'export const ids = [1];'],
  [`${CRM}/tests/page.test.ts`, "import { crm } from '../src/index.ts';"],
  [`${CRM}/tsconfig.json`, '{"extends":"../../tsconfig.base.json"}'],
  [`${KIT}/package.json`, '{"name":"@app/kit","exports":{".":"./src/index.ts"}}'],
  [KIT_SOURCE, 'export const kit = 1;'],
  [`${OTHER}/package.json`, '{"name":"@app/other"}'],
  [`${OTHER}/src/index.ts`, "import { kit } from '@app/kit';\nexport const other = kit;"],
  [`${PARTY}/package.json`, '{"name":"@app/party","exports":{"./api":"./src/api.ts","./worker":"./src/worker.ts"}}'],
  [PARTY_API, 'export const party = 1;'],
  [PARTY_WORKER, 'export const worker = 1;'],
  [`${PARTY}/tests/api.test.ts`, "import { party } from '../src/api.ts';"],
  [
    `${SHELL}/package.json`,
    JSON.stringify({
      name: SHELL_PACKAGE,
      scripts: { build: 'modern build && node ../../scripts/complete-packaged-node-dependencies.mts .' },
    }),
  ],
  [`${SHELL}/src/index.ts`, "import { party } from '@app/party/api';\nexport const shell = party;"],
  [EXPORT_WALK, EMPTY_MODULE],
  ['app/.mise.toml', '[tools]'],
  ['app/module-federation.shared.ts', 'export const shared = {};'],
  ['app/package.json', '{"name":"app"}'],
  [LOCKFILE, 'lockfileVersion: 9'],
  ['app/quality-audit/lint-suppressions.json', '[]'],
  [
    'app/scripts/generate-contract.mts',
    [
      "import { readTopology } from './topology-reader.mts';",
      // A comment naming a script is prose, not a read.
      "// replaces 'scripts/unused.mts'",
      "export const topology = readTopology('topology/reference-topology.json');",
    ].join('\n'),
  ],
  ['app/scripts/topology-reader.mts', 'export const readTopology = (file: string) => file;'],
  ['app/scripts/unused.mts', EMPTY_MODULE],
  [
    BUILD_DRIVER,
    [
      '# The release pack runs later: scripts/zerops/pack-app-release.sh',
      'node "$root/scripts/zerops/delivery-plan-cli.mts" digests >"$ZEROPS_UNIT_DIGESTS"',
      'for project in packages/shared-contracts; do',
      '  pnpm exec ultramodern-create ultramodern typecheck --build "$project/tsconfig.json"',
      'done',
      '(cd "$dir" && pnpm run build && node "$root/scripts/zerops/owner-entry.mts" "$dir")',
    ].join('\n'),
  ],
  ['app/scripts/zerops/delivery-plan-cli.mts', EMPTY_MODULE],
  ['app/scripts/zerops/hosted-credential-claim.mts', 'export const claim = 1;'],
  [OWNER_ENTRY, "import { claim } from './hosted-credential-claim.mts';"],
  ['app/scripts/zerops/push-service.sh', 'zcli push'],
  ['app/scripts/zerops/pack-app-release.sh', 'tar -cf release.tar app'],
  ['app/topology/reference-topology.json', '{}'],
  ['app/tsconfig.base.json', '{}'],
  [ZEROPS_YAML, 'zerops: []'],
];
/** The fixture commit with some files changed (a new blob ID) and some files added or replaced. */
const graphOf = (
  changed: readonly string[] = [],
  added: readonly (readonly [string, string])[] = [],
): UnitInputGraph => {
  const files = [...FILES.filter(([filepath]) => !added.some(([other]) => other === filepath)), ...added];
  return unitInputGraph({
    entries: files.map(([filepath]) => ({
      identity: `100644 blob ${filepath}${changed.includes(filepath) ? '-changed' : ''}`,
      path: filepath,
    })),
    packages,
    sources: new Map(files),
  });
};
const environment = buildEnvironment([
  ['HOME', '/home/runner'],
  ['ONTOS_PUBLIC_ORIGIN', 'https://stage.example'],
]);
const identity = (graph: UnitInputGraph, variables = environment, unit = CRM) =>
  unitInputDigest(unit, { environment: variables, graph });
const sameAfter = (changed: string) =>
  identity(graphOf([changed])).pipe(
    Effect.flatMap((after) => identity(graphOf()).pipe(Effect.map((before) => ({ changed, same: after === before })))),
  );

it.effect('changes a unit identity for a change in any dependency, reached file, build script or root input', () =>
  Effect.gen(function* changedInputs() {
    for (const changed of [
      CRM_ENTRY,
      CRM_IMPORTED_TEST_HELPER,
      PARTY_API,
      `${CONTRACTS}/src/index.ts`,
      `${CRM}/package.json`,
      'app/scripts/generate-contract.mts',
      'app/scripts/topology-reader.mts',
      'app/topology/reference-topology.json',
      BUILD_DRIVER,
      OWNER_ENTRY,
      'app/scripts/zerops/hosted-credential-claim.mts',
      LOCKFILE,
      'app/.mise.toml',
      'app/tsconfig.base.json',
      'app/module-federation.shared.ts',
    ]) {
      expect(yield* sameAfter(changed)).toEqual({ changed, same: false });
    }
    const baseline = yield* identity(graphOf());
    // A root file nobody classified is an input until someone says why it is not.
    expect(yield* identity(graphOf([], [['app/new-build-config.ts', EMPTY_MODULE]]))).not.toBe(baseline);
    for (const variable of [
      ['MODERN_PUBLIC_SITE_URL', 'https://x.example'],
      ['ONTOS_PUBLIC_ORIGIN', 'https://other.example'],
    ] as const) {
      expect(yield* identity(graphOf(), buildEnvironment([variable]))).not.toBe(baseline);
    }
  }),
);

it.effect('keeps a unit identity for unrelated units, deploy files, tests, docs, workflows and unused scripts', () =>
  Effect.gen(function* unchangedInputs() {
    for (const changed of [
      `${OTHER}/src/index.ts`,
      `${SHELL}/src/index.ts`,
      ZEROPS_YAML,
      'app/scripts/zerops/push-service.sh',
      'app/scripts/zerops/pack-app-release.sh',
      'app/scripts/zerops/delivery-plan-cli.mts',
      'app/scripts/unused.mts',
      `${CRM}/src/index.test.ts`,
      `${CRM}/tests/page.test.ts`,
      `${PARTY}/tests/api.test.ts`,
      `${CRM}/README.md`,
      '.github/workflows/zerops-stage.yml',
      'app/quality-audit/lint-suppressions.json',
    ]) {
      expect(yield* sameAfter(changed)).toEqual({ changed, same: true });
    }
    // Identity overrides and unrelated variables only relabel the output or never reach it.
    const relabelled = buildEnvironment([
      ...environment,
      ['CI', 'true'],
      ['GITHUB_SHA', 'f'.repeat(40)],
      ['ULTRAMODERN_BUILD_MARKER', 'marker'],
      ['ULTRAMODERN_SOURCE_REVISION', 'f'.repeat(40)],
    ]);
    expect(yield* identity(graphOf(), relabelled)).toBe(yield* identity(graphOf()));
  }),
);

it.effect('follows a devDependency only when included code imports it', () =>
  Effect.gen(function* devDependency() {
    expect(yield* sameAfter(`${SHELL}/src/index.ts`)).toEqual({ changed: `${SHELL}/src/index.ts`, same: true });
    const importing = [[CRM_ENTRY, `${CRM_SOURCE}\nimport '@app/shell-super-app/runtime';`]] as const;
    const baseline = yield* identity(graphOf([], importing));
    expect(yield* identity(graphOf([`${SHELL}/src/index.ts`], importing))).not.toBe(baseline);
  }),
);

/**
 * One unit's change rebuilds only what depends on it; whatever every unit reads rebuilds all. A dependency counts by
 * what the unit reaches of it: a package's exports (and their imports), never a file no export reaches.
 */
it.effect('changes the units that reach a change and keeps every other unit', () =>
  Effect.gen(function* dependents() {
    const units = [CRM, OTHER, PARTY];
    const changedUnits = (changed: string) =>
      Effect.gen(function* compareUnits() {
        const changes = [];
        for (const unit of units) {
          const before = yield* identity(graphOf(), environment, unit);
          if ((yield* identity(graphOf([changed]), environment, unit)) !== before) {
            changes.push(unit);
          }
        }
        return { changed, units: changes };
      });
    // One vertical's source: the vertical and the units that import what it exports.
    expect(yield* changedUnits(PARTY_API)).toEqual({ changed: PARTY_API, units: [CRM, PARTY] });
    expect(yield* changedUnits(PARTY_WORKER)).toEqual({ changed: PARTY_WORKER, units: [PARTY] });
    expect(yield* changedUnits(`${OTHER}/src/index.ts`)).toEqual({ changed: `${OTHER}/src/index.ts`, units: [OTHER] });
    // A build that walks every export of the packages it carries reads the exports it does not import too.
    const shellBefore = yield* identity(graphOf(), environment, SHELL);
    expect(yield* identity(graphOf([PARTY_WORKER]), environment, SHELL)).not.toBe(shellBefore);
    // A shared package: every unit that imports it.
    expect(yield* changedUnits(KIT_SOURCE)).toEqual({ changed: KIT_SOURCE, units: [CRM, OTHER] });
    // The packages the build driver compiles first, the build driver and what it runs: every unit.
    for (const changed of [`${CONTRACTS}/src/index.ts`, BUILD_DRIVER, OWNER_ENTRY, LOCKFILE]) {
      expect(yield* changedUnits(changed)).toEqual({ changed, units });
    }
  }),
);

it.effect('counts what the deploy trace carries and esbuild reads of an imported package', () =>
  Effect.gen(function* carriedFiles() {
    const shadow = `${PARTY}/api/index.ts`;
    const shadowImport = `${PARTY}/src/server.ts`;
    const tsconfig = `${PARTY}/tsconfig.json`;
    const added = [
      [shadow, "import { server } from '../src/server.ts';"],
      [shadowImport, 'export const server = 1;'],
      [tsconfig, '{"extends":"../../tsconfig.base.json"}'],
    ] as const;
    const baseline = yield* identity(graphOf([], added));
    // The trace copies `<package>/api/index.ts` beside the `./api` target, and esbuild reads the package's tsconfig.
    expect(yield* identity(graphOf([shadow], added))).not.toBe(baseline);
    expect(yield* identity(graphOf([tsconfig], added))).not.toBe(baseline);
    // The trace follows the carried file's imports, and the Shell's packaging completes them: they count too.
    expect(yield* identity(graphOf([shadowImport], added))).not.toBe(baseline);
  }),
);

it.effect('resolves a carried subpath directory as Node does: its own package.json main, then its index', () =>
  Effect.gen(function* nestedManifest() {
    const principal = `${PARTY}/api/auth/action-principal.ts`;
    const nested = [`${PARTY}/api/package.json`, '{"main":"./auth/action-principal.ts"}'] as const;
    const base = [
      [`${PARTY}/api/index.ts`, EMPTY_MODULE],
      [principal, "import { server } from '../../src/server.ts';\nexport const principal = server;"],
      [`${PARTY}/src/server.ts`, 'export const server = 1;'],
    ] as const;
    const baseline = yield* identity(graphOf([], base));
    // A manifest that selects another file changes what the trace and Node load for `@app/party/api`.
    const selected = yield* identity(graphOf([], [...base, nested]));
    expect(selected).not.toBe(baseline);
    // The selected file and what it imports are then read.
    expect(yield* identity(graphOf([principal], [...base, nested]))).not.toBe(selected);
    expect(yield* identity(graphOf([`${PARTY}/src/server.ts`], [...base, nested]))).not.toBe(selected);
  }),
);

it.effect('counts every file below a Tailwind @source directory, even one that holds an index module', () =>
  Effect.gen(function* sourceDirectory() {
    const stylesheet = [`${SHELL}/src/routes/ui-kit.css`, "@source '../../../../packages/kit/src';"] as const;
    const baseline = yield* identity(graphOf([], [stylesheet]), environment, SHELL);
    const candidates = [`${KIT}/src/utility-candidates.tsx`, 'export const width = "w-[317px]";'] as const;
    expect(yield* identity(graphOf([], [stylesheet, candidates]), environment, SHELL)).not.toBe(baseline);
    // A Tailwind import's own `source(…)` base is scanned the same way.
    const based = [
      `${SHELL}/src/routes/ui-kit.css`,
      "@import 'tailwindcss' source('../../../../packages/kit');",
    ] as const;
    const before = yield* identity(graphOf([], [based]), environment, SHELL);
    expect(yield* identity(graphOf([], [based, candidates]), environment, SHELL)).not.toBe(before);
  }),
);

it.effect('counts the route metadata of every app for a unit whose build generates its public surface', () =>
  Effect.gen(function* publicSurface() {
    const meta = `${OTHER}/src/routes/[lang]/route.meta.ts`;
    const metaImport = `${OTHER}/src/routes/route-ids.ts`;
    const page = `${OTHER}/src/routes/[lang]/page.tsx`;
    const manifest = JSON.stringify({
      name: '@app/crm',
      scripts: { build: 'modern build && ultramodern-create ultramodern public-surface --app crm --target dist' },
    });
    const added = [
      [`${CRM}/package.json`, manifest],
      [meta, "import { id } from '../route-ids.ts';\nexport const routeMeta = { id };"],
      [metaImport, "export const id = 'other';"],
      [page, 'export const Page = () => null;'],
    ] as const;
    const baseline = yield* identity(graphOf([], added));
    // The generator imports and validates every topology app's route metadata before it selects --app.
    expect(yield* identity(graphOf([meta], added))).not.toBe(baseline);
    expect(yield* identity(graphOf([metaImport], added))).not.toBe(baseline);
    // A new app route metadata file counts; another route file's text does not.
    const added2 = [...added, [`${OTHER}/src/routes/[lang]/about/route.meta.ts`, EMPTY_MODULE]] as const;
    expect(yield* identity(graphOf([], added2))).not.toBe(baseline);
    expect(yield* identity(graphOf([page], added))).toBe(baseline);
  }),
);

it('reads a package as its manifest and every export target, or whole when its exports are not plain files', () => {
  const manifest = `${PARTY}/package.json`;
  const index = `${PARTY}/src/index.ts`;
  const entries = (exports: string) => packageEntries(PARTY, `{"name":"${PARTY_PACKAGE}","exports":${exports}}`);
  expect(entries('{".":"./src/index.ts","./api":{"default":"./src/api.ts","types":"./src/api.d.ts"}}')).toEqual([
    manifest,
    index,
    `${PARTY}/src/api.ts`,
    `${PARTY}/src/api.d.ts`,
  ]);
  expect(entries('"./src/index.ts"')).toEqual([manifest, index]);
  // A subpath reads only its own targets, under every condition.
  const subpaths = '{".":"./src/index.ts","./api":{"default":"./src/api.ts","types":"./src/api.d.ts"}}';
  expect(packageEntries(PARTY, `{"exports":${subpaths}}`, './api')).toEqual([
    manifest,
    `${PARTY}/src/api.ts`,
    `${PARTY}/src/api.d.ts`,
  ]);
  expect(packageEntries(PARTY, `{"exports":${subpaths}}`, '.')).toEqual([manifest, index]);
  expect(packageEntries(PARTY, '{"exports":{"default":"./src/index.ts"}}', '.')).toEqual([manifest, index]);
  // An unexported or pattern-matched subpath cannot be named from the map, so the package counts whole.
  expect(packageEntries(PARTY, `{"exports":${subpaths}}`, './other')).toEqual([]);
  expect(packageEntries(PARTY, '{"exports":{"./*":"./src/*.ts"}}', './api')).toEqual([]);
  expect(entries('{".":"./src/index.ts","./private":null}')).toEqual([manifest, index]);
  // Each of these resolves files the map does not name, so the package counts whole.
  for (const exports of ['{"./*":"./src/*.ts"}', '{"./":"./"}', '{".":"../other/index.ts"}', '{".":1}']) {
    expect({ entries: entries(exports), exports }).toEqual({ entries: [], exports });
  }
  expect(packageEntries(PARTY, `{"name":"${PARTY_PACKAGE}"}`)).toEqual([]);
});

/** The rule the identity must never break: inside the unit, only tests and docs stay out. */
const unsafeExclusions = (directory: string, excluded: readonly ExcludedInput[]) =>
  excluded.filter(
    (entry) =>
      entry.path.startsWith(`${directory}/`) &&
      !(entry.reason === 'test' && isTestInput(entry.path)) &&
      entry.reason !== 'documentation',
  );
it.effect('excludes nothing from a unit except tests and documentation', () =>
  Effect.gen(function* fixtureExclusions() {
    const { excluded, inputs } = yield* unitInputs(CRM, graphOf());
    expect(unsafeExclusions(CRM, excluded)).toEqual([]);
    expect(inputs.map((entry) => entry.path)).toContain(CRM_IMPORTED_TEST_HELPER);
    expect(excluded.map((entry) => entry.path)).not.toContain(CRM_IMPORTED_TEST_HELPER);
    expect(excluded.find((entry) => entry.path === ZEROPS_YAML)?.reason).toBe('non-build');
    expect(FILES.length).toBe(inputs.length + excluded.length);
  }),
);

it.effect(
  'excludes nothing but tests and documentation from any committed unit, and lists only real driver tools',
  () =>
    Effect.gen(function* committedExclusions() {
      const { graph, units } = yield* readUnitIdentities('HEAD');
      const driver = graph.workspace.sources.get(BUILD_DRIVER) ?? '';
      for (const script of BUILD_DRIVER_TOOLS.keys()) {
        expect({ named: driver.includes(script), script }).toEqual({ named: true, script });
      }
      expect(units.length).toBeGreaterThan(1);
      for (const { directory } of units) {
        const { excluded } = yield* unitInputs(directory, graph);
        expect({ directory, unsafe: unsafeExclusions(directory, excluded) }).toEqual({ directory, unsafe: [] });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

/**
 * The deploy planner and the identity code itself must never become a unit's input: a fixture inside a unit's folder
 * (the Shell's Tailwind scan reads its tests too) that reached them would make every planner edit rebuild that unit.
 * The build drivers themselves (build-app.sh, owner-entry.mts and what they reach) are inputs by design.
 */
const PLANNER = new Set([
  'app/scripts/zerops/delivery-plan.mts',
  ...[...BUILD_DRIVER_TOOLS.keys()].map((script) => `app/${script}`),
  'app/scripts/ci/unit-output-cache.mts',
  'app/scripts/ci/unit-inputs.mts',
]);
it.effect(
  'keeps the deploy planner out of every committed unit, the Shell included',
  () =>
    Effect.gen(function* plannerNotAnInput() {
      const { graph, units } = yield* readUnitIdentities('HEAD');
      for (const directory of [
        ...units.map((unit) => unit.directory),
        'app/verticals/party-registry',
        'app/verticals/commerce-customer-context',
      ]) {
        const { inputs, reachedFrom } = yield* unitInputs(directory, graph);
        const planner = inputs
          .filter((entry) => PLANNER.has(entry.path))
          .map((entry) => `${entry.path} <- ${reachedFrom.get(entry.path) ?? ''}`);
        expect({ directory, planner }).toEqual({ directory, planner: [] });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
