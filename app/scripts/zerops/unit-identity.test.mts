import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { readUnitIdentities } from './delivery-plan-cli.mts';
import {
  BUILD_DRIVER,
  BUILD_DRIVER_TOOLS,
  buildEnvironment,
  isTestInput,
  runtimeClosure,
  unitInputDigest,
  unitInputGraph,
  unitInputs,
} from './delivery-plan.mts';
import type { ExcludedInput, UnitInputGraph, WorkspacePackage } from './delivery-plan.mts';

const CRM = 'app/verticals/crm';
const PARTY = 'app/verticals/party';
const OTHER = 'app/verticals/other';
const SHELL = 'app/apps/shell-super-app';
const CONTRACTS = 'app/packages/shared-contracts';
const PARTY_PACKAGE = '@app/party';
const PARTY_API = `${PARTY}/src/api.ts`;
const CRM_ENTRY = `${CRM}/src/index.ts`;
const CRM_IMPORTED_TEST_HELPER = `${CRM}/tests/support/fixture-ids.ts`;
const OWNER_ENTRY = 'app/scripts/zerops/owner-entry.mts';
const EMPTY_MODULE = 'export {};';
const ZEROPS_YAML = 'app/zerops.yaml';
const packages: readonly WorkspacePackage[] = [
  {
    directory: CRM,
    name: '@app/crm',
    runtimeDependencies: [PARTY_PACKAGE],
    // The Shell is a devDependency (a test helper), so only an import from included code brings it in.
    workspaceDependencies: [PARTY_PACKAGE, '@app/shell-super-app'],
  },
  { directory: PARTY, name: PARTY_PACKAGE, runtimeDependencies: [], workspaceDependencies: [] },
  { directory: OTHER, name: '@app/other', runtimeDependencies: [], workspaceDependencies: [] },
  { directory: SHELL, name: '@app/shell-super-app', runtimeDependencies: [], workspaceDependencies: [] },
  { directory: CONTRACTS, name: '@app/shared-contracts', runtimeDependencies: [], workspaceDependencies: [] },
];
const CRM_SOURCE = [
  "import { party } from '@app/party/api';",
  "import { ids } from '../tests/support/fixture-ids.ts';",
  'export const crm = [party, ids];',
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
  [`${OTHER}/package.json`, '{"name":"@app/other"}'],
  [`${OTHER}/src/index.ts`, 'export const other = 1;'],
  [`${PARTY}/package.json`, '{"name":"@app/party"}'],
  [PARTY_API, 'export const party = 1;'],
  [`${PARTY}/tests/api.test.ts`, "import { party } from '../src/api.ts';"],
  [`${SHELL}/package.json`, '{"name":"@app/shell-super-app"}'],
  [`${SHELL}/src/index.ts`, 'export const shell = 1;'],
  ['app/.mise.toml', '[tools]'],
  ['app/module-federation.shared.ts', 'export const shared = {};'],
  ['app/package.json', '{"name":"app"}'],
  ['app/pnpm-lock.yaml', 'lockfileVersion: 9'],
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
const identity = (graph: UnitInputGraph, variables = environment) =>
  unitInputDigest(CRM, { environment: variables, graph });
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
      'app/pnpm-lock.yaml',
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
    expect(yield* runtimeClosure(CRM, packages)).toEqual([CRM, PARTY]);
    const importing = [[CRM_ENTRY, `${CRM_SOURCE}\nimport '@app/shell-super-app/runtime';`]] as const;
    const baseline = yield* identity(graphOf([], importing));
    expect(yield* identity(graphOf([`${SHELL}/src/index.ts`], importing))).not.toBe(baseline);
  }),
);

/** The rule the identity must never break: inside the unit or a dependency, only tests and docs stay out. */
const unsafeExclusions = (closure: readonly string[], excluded: readonly ExcludedInput[]) =>
  excluded.filter(
    (entry) =>
      closure.some((root) => entry.path.startsWith(`${root}/`)) &&
      !(entry.reason === 'test' && isTestInput(entry.path)) &&
      entry.reason !== 'documentation',
  );

it.effect('excludes nothing from a unit or its dependencies except tests and documentation', () =>
  Effect.gen(function* fixtureExclusions() {
    const { closure, excluded, inputs } = yield* unitInputs(CRM, graphOf());
    expect(unsafeExclusions(closure, excluded)).toEqual([]);
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
        const { closure, excluded } = yield* unitInputs(directory, graph);
        expect({ directory, unsafe: unsafeExclusions(closure, excluded) }).toEqual({ directory, unsafe: [] });
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
