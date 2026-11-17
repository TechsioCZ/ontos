import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CiTemplatesSchema,
  ciPlanOutputs,
  filterPaths,
  buildJobPrefix,
  integrationPhases,
  knownTask,
  unitPhases,
  matchingPackages,
  planCiChecks,
  taskDirectory,
  unknownFilters,
  withCiTopologyDependencies,
} from '../plan-ci-checks.mts';
import { workspaceConsumerClosure } from '../workspace-consumer-closure.mts';

const templates = Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
  readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
);

/** Every owner row is one build shard, numbered in row order. */
const ALL_SHARDS = templates.integration.flatMap((entry, index) =>
  entry.suite === 'integration'
    ? [index - templates.integration.findIndex(({ suite }) => suite === 'integration') + 1]
    : [],
);

it('prepares the database even when browser tests are not selected, without adding unrelated browser work', () => {
  const phases = integrationPhases(templates.integration.filter(({ suite }) => suite !== 'browser'));
  expect(phases.setup).toEqual([{ name: 'Prepare integration database', suite: 'database' }]);
  expect(phases.topology).toEqual(templates.integration.filter(({ suite }) => suite === 'bootstrap'));
  expect(phases.build.map(({ shard }) => shard)).toEqual(ALL_SHARDS);
  expect(phases.build.map(({ suite }) => suite)).toEqual(ALL_SHARDS.map(() => 'integration'));
  expect(integrationPhases([])).toEqual({ build: [], setup: [], topology: [] });
});

/** The workspace directories whose integration files a row's tasks run. */
const taskDirectories = (row: { readonly tasks?: readonly string[] | undefined }) => [
  ...new Set((row.tasks ?? []).flatMap((task) => taskDirectory(task) ?? [])),
];
const CATALOG = '@app/catalog';
const PRICING = '@app/pricing';
const CATALOG_SOURCE = 'app/verticals/catalog/src/service.ts';
const ANOTHER_DIRECTORY = 'verticals/another';
const CUSTOMER_CONTEXT = '@app/commerce-customer-context';
const SHELL = '@app/shell-super-app';
const CATALOG_DIRECTORY = 'verticals/catalog';
const PRICING_DIRECTORY = 'verticals/pricing';
const PRIVACY_DIRECTORY = 'verticals/privacy';
const PRIVACY = '@app/privacy';
const SHELL_DIRECTORY = 'apps/shell-super-app';
const AFFECTED_REASON = 'Required tests include the changed owners and their transitive consumers.';
// check-ci-gates.sh pins these six names three times and plan-ci-changes.sh carries a fourth copy, so a
// seventh or renamed key fails the single required status check on every event, including push to main.
const REQUIRED_GATES = [
  'format-and-lint',
  'node-artifact-build',
  'service-integration',
  'static-contracts',
  'workspace-gate',
  'workspace-unit',
];
const packages = [
  { dependencies: [], directory: CATALOG_DIRECTORY, name: CATALOG },
  { dependencies: [CATALOG], directory: PRICING_DIRECTORY, name: PRICING },
  { dependencies: [], directory: PRIVACY_DIRECTORY, name: PRIVACY },
  { dependencies: [], directory: SHELL_DIRECTORY, name: SHELL },
  { dependencies: [], directory: 'verticals/party-registry', name: '@app/party-registry' },
  { dependencies: [], directory: 'verticals/commerce-cart', name: '@app/commerce-cart' },
  { dependencies: [], directory: 'verticals/storefront-registry', name: '@app/storefront-registry' },
  { dependencies: [], directory: 'verticals/commerce-market-catalog', name: '@app/commerce-market-catalog' },
  { dependencies: [], directory: 'verticals/commerce-customer-context', name: CUSTOMER_CONTEXT },
];

const PACKAGE_MANIFEST = 'package.json';
const appRoot = path.resolve(import.meta.dirname, '../..');
const ManifestNameFromJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
/** Every pnpm workspace member the planner can see, read from disk rather than restated here. */
const workspacePackages = ['apps', 'packages', 'verticals'].flatMap((area) =>
  readdirSync(path.join(appRoot, area), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(appRoot, area, entry.name, PACKAGE_MANIFEST)))
    .map((entry) => ({
      dependencies: [],
      directory: `${area}/${entry.name}`,
      name: Schema.decodeUnknownSync(ManifestNameFromJson)(
        readFileSync(path.join(appRoot, area, entry.name, PACKAGE_MANIFEST), 'utf-8'),
      ).name,
    })),
);
const knownSelectors = new Set(['.', ...workspacePackages.map(({ directory }) => directory)]);
const selectedDirectories = (filters: string) =>
  matchingPackages(filters, workspacePackages).map(({ directory }) => directory);

const WAIT_FOR_BUILDS = "bash scripts/wait-for-build-shards.sh 'Build node artifacts (' 11";

it('builds every delivery unit in exactly one owner row, and names each building job as a build shard', () => {
  const topology = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        shell: Schema.Struct({ path: Schema.String }),
        verticals: Schema.Array(Schema.Struct({ path: Schema.String })),
      }),
    ),
  )(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8'));
  const building = templates.integration.filter((entry) => entry.shard !== undefined);
  expect(building.every(({ suite }) => suite === 'integration')).toBe(true);
  const units = building.flatMap(({ units: shardUnits }) => (shardUnits ?? '').split(/\s+/u).filter(Boolean));
  expect(EffectArray.sort(units, Order.String)).toEqual(
    EffectArray.sort(
      [topology.shell, ...topology.verticals].map((unit) => unit.path),
      Order.String,
    ),
  );
  const { build } = integrationPhases(templates.integration);
  // Every consumer waits for this many uploads under this prefix; a seventh shard would never be awaited.
  expect(WAIT_FOR_BUILDS).toContain(`${buildJobPrefix}' ${String(build.length)}`);
  expect(build.map(({ name }) => name)).toEqual(
    building.map(
      (entry, index) => `${buildJobPrefix}${String(index + 1)}/${String(building.length)}) and ${entry.name}`,
    ),
  );
  expect(new Set(building.map(({ shard }) => shard))).toEqual(new Set(building.map((_entry, index) => index + 1)));
});

it('keeps building every shard in an affected plan that selects none of its owner tasks', () => {
  for (const owner of workspacePackages) {
    const plan = planCiChecks({
      changedPaths: [`app/${owner.directory}/src/service.ts`],
      packages: workspacePackages,
      templates,
    });
    const { build } = integrationPhases(plan.integration);
    expect(
      build.map(({ shard }) => shard),
      owner.name,
    ).toEqual(ALL_SHARDS);
    for (const row of build) {
      expect(row.suite === 'build' || (row.tasks?.length ?? 0) > 0, `${owner.name}: ${row.name}`).toBe(true);
    }
  }
  const promotion = planCiChecks({
    changedPaths: ['app/verticals/promotion/src/service.ts'],
    packages: workspacePackages,
    templates,
  });
  expect(promotion.mode).toBe('affected');
  expect(integrationPhases(promotion.integration).build.some(({ suite }) => suite === 'build')).toBe(true);
});

it('preserves the authored worker budget when affected selection narrows package filters', () => {
  const pricing = templates.unit.find((row) =>
    selectedDirectories(row.commands.split('\n')[0] ?? '').includes(PRICING_DIRECTORY),
  );
  expect(pricing).toBeDefined();
  const plan = planCiChecks({
    changedPaths: ['app/verticals/pricing/src/service.ts'],
    packages: workspacePackages,
    templates,
  });
  expect(plan.mode).toBe('affected');
  expect(plan.unit).toHaveLength(1);
  const [selected] = plan.unit;
  expect(selectedDirectories(selected?.commands.split('\n')[0] ?? '')).toEqual([PRICING_DIRECTORY]);
  const flags = /--(?:workspace-concurrency=\d+|pool\.maxWorkers \d+)/gu;
  expect(selected?.commands.match(flags)).toEqual(pricing?.commands.match(flags));
});

it('does not start an integration row after its selected tasks move to another row', () => {
  for (const owner of workspacePackages) {
    const plan = planCiChecks({
      changedPaths: [`app/${owner.directory}/src/service.ts`],
      packages: workspacePackages,
      templates,
    });
    for (const row of plan.integration) {
      if (row.tasks !== undefined) {
        expect(row.tasks.length, `${owner.name}: ${row.name}`).toBeGreaterThan(0);
      }
    }
    const owns = (task: string) => task === `./${owner.directory}` || task.startsWith(`./${owner.directory}#`);
    const expected = templates.integration.flatMap((row) => row.tasks ?? []).filter(owns);
    const selected = plan.integration.flatMap((row) => row.tasks ?? []).filter(owns);
    expect(EffectArray.sort(selected, Order.String), owner.name).toEqual(EffectArray.sort(expected, Order.String));
  }
});

it('selects owner and transitive consumer tests without selecting an unrelated owner', () => {
  const plan = planCiChecks({ changedPaths: [CATALOG_SOURCE], packages, templates });
  expect(plan.mode).toBe('affected');
  expect(plan.affectedPackages).toEqual([CATALOG, PRICING]);
  // Standalone and whole-owner proofs remain selected even without package-filter matches.
  // Ordinary package tests remain restricted to the affected owner and its consumers.
  expect(plan.integration.some(({ suite }) => suite === 'bootstrap')).toBe(true);
  const ordinaryTasks = plan.integration.flatMap((row) => row.tasks ?? []).filter((task) => task.startsWith('./'));
  expect(ordinaryTasks.length).toBeGreaterThan(0);
  expect(
    ordinaryTasks.every((task) => task.startsWith('./verticals/catalog#') || task.startsWith('./verticals/pricing#')),
  ).toBe(true);
  const tests = plan.integration.filter(({ suite }) => suite === 'integration');
  expect(EffectArray.sort([...new Set(tests.flatMap(taskDirectories))], Order.String)).toEqual([
    CATALOG_DIRECTORY,
    PRICING_DIRECTORY,
  ]);
  expect(plan.unit).toHaveLength(2);
  const unitCommands = plan.unit.map(({ commands }) => commands).join('\n');
  expect(unitCommands).toContain('--filter ./verticals/catalog');
  expect(unitCommands).toContain('--filter ./verticals/pricing');
  expect(unitCommands).not.toContain('--filter ./verticals/privacy');
});

it('plans affected selection by default and keeps the forced backstop on the complete suite', () => {
  const plan = planCiChecks({ changedPaths: [CATALOG_SOURCE], packages, templates });
  expect(plan.mode).toBe('affected');
  expect(plan.reason).toBe(AFFECTED_REASON);
  expect(plan.integration).not.toEqual(templates.integration);
  expect(EffectArray.sort(Object.keys(plan.expected), Order.String)).toEqual(REQUIRED_GATES);
  expect(plan.expected).not.toHaveProperty('cloudflare-artifact-build');
  // The nightly cron and workflow_dispatch pass --full; that run is the backstop for a missed impact edge.
  const forced = planCiChecks({ changedPaths: [CATALOG_SOURCE], forceFull: true, packages, templates });
  expect(forced.mode).toBe('full');
  expect(forced.reason).toBe('Shared, sensitive, unknown or explicitly full impact requires the complete suite.');
  expect(forced.integration).toEqual(templates.integration);
  expect(forced.unit).toEqual(templates.unit);
  expect(EffectArray.sort(Object.keys(forced.expected), Order.String)).toEqual(REQUIRED_GATES);
});

const preproposalRow = (entry: { readonly tasks?: readonly string[] | undefined }) =>
  (entry.tasks ?? []).some((task) => task.startsWith('whole:preproposal-'));

it('retains the native preproposal proof for each runtime owner even without ordinary package matches', () => {
  const native = templates.integration.find(preproposalRow);
  expect(native?.['proof-packages']).toHaveLength(8);
  for (const owner of native?.['proof-packages'] ?? []) {
    const workspacePackage = packages.find(({ name }) => name === owner);
    const plan = planCiChecks({
      changedPaths: [`app/${workspacePackage?.directory ?? 'missing'}/src/service.ts`],
      packages,
      templates,
    });
    expect(plan.mode).toBe('affected');
    expect(plan.integration.filter(preproposalRow)).toHaveLength(2);
    if (owner === PRICING) {
      expect(plan.affectedPackages).toEqual([PRICING]);
      for (const row of plan.integration.filter(preproposalRow)) {
        // Only the proof itself and the affected owner's own files remain; no root file rides along.
        expect(taskDirectories(row).every((directory) => directory === PRICING_DIRECTORY)).toBe(true);
        expect((row.tasks ?? []).some((task) => task.startsWith('root:'))).toBe(false);
      }
    }
  }
});

it('omits the native preproposal proof for an unrelated owner and widens unknown proof dependencies', () => {
  const plan = (entries: typeof packages) =>
    planCiChecks({ changedPaths: ['app/verticals/privacy/src/service.ts'], packages: entries, templates });
  expect(plan(packages).mode).toBe('affected');
  expect(
    plan(packages)
      .integration.flatMap((entry) => entry.tasks ?? [])
      .some((task) => task.startsWith('whole:preproposal-')),
  ).toBe(false);
  expect(plan(packages.filter(({ name }) => name !== PRICING)).mode).toBe('full');
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: templates.integration.map((entry) => ({ ...entry, 'proof-packages': [] })),
    }),
  ).toBe(false);
});

it('keeps the build-proof row in every affected plan so the node artifact gate never disappears', () => {
  const proof = { name: 'Node Artifact Proof', suite: 'bootstrap' } as const;
  expect(Schema.is(CiTemplatesSchema)({ ...templates, integration: [proof] })).toBe(true);
  const alongside = planCiChecks({
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates: { ...templates, integration: [...templates.integration, proof] },
  });
  expect(alongside.mode).toBe('affected');
  expect(alongside.integration.map(({ name }) => name)).toContain(proof.name);
  // It names no package, no root suite and no proof packages, yet it alone keeps the gate required.
  const alone = planCiChecks({
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates: { ...templates, integration: [proof] },
  });
  expect(alone.mode).toBe('affected');
  expect(alone.integration).toEqual([proof]);
  expect(alone.expected['service-integration']).toBe('success');
});

it('keeps mixed documentation and owner changes scoped, but widens a mixed unknown owner', () => {
  expect(planCiChecks({ changedPaths: ['README.md', CATALOG_SOURCE], packages, templates }).mode).toBe('affected');
  expect(
    planCiChecks({
      changedPaths: ['app/verticals/missing/src/service.ts', CATALOG_SOURCE],
      packages,
      templates,
    }).mode,
  ).toBe('full');
});

it('widens broken dependency metadata rather than silently dropping its consumers', () => {
  for (const extra of [
    { dependencies: ['@app/missing'], directory: ANOTHER_DIRECTORY, name: '@app/another' },
    { dependencies: [], directory: ANOTHER_DIRECTORY, name: CATALOG },
    { dependencies: [], directory: ANOTHER_DIRECTORY, name: '@app/another', uncertain: true },
  ]) {
    expect(planCiChecks({ changedPaths: [CATALOG_SOURCE], packages: [...packages, extra], templates }).mode).toBe(
      'full',
    );
  }
});

it('rejects incomplete full matrices and widens an unrunnable task form', () => {
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: [{ name: 'Missing task list', suite: 'integration' }],
    }),
  ).toBe(false);
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: [{ name: 'Unrunnable task', suite: 'integration', tasks: ['@app/pricing...'] }],
    }),
  ).toBe(false);
  // The dependency-free planner reads authored JSON without the schema, so it widens on its own.
  for (const task of ['@app/pricing...', './verticals/catalog#one', 'whole:invented']) {
    expect(
      planCiChecks({
        changedPaths: [CATALOG_SOURCE],
        packages,
        templates: { ...templates, integration: [{ name: 'Unproven task', suite: 'integration', tasks: [task] }] },
      }).mode,
      task,
    ).toBe('full');
  }
});

/** The root integration work an integration matrix runs. */
const rootTasks = (entries: readonly { readonly tasks?: readonly string[] | undefined }[]) =>
  EffectArray.sort(
    entries
      .flatMap((entry) => entry.tasks ?? [])
      .filter((task) => task.startsWith('root:') || task === 'whole:migrations'),
    Order.String,
  );

it('selects browser checks and all root integration shards when they consume a changed package', () => {
  const plan = planCiChecks({
    changedPaths: [CATALOG_SOURCE],
    packages: [
      ...packages.map((entry) => (entry.name === SHELL ? { ...entry, dependencies: [CATALOG] } : entry)),
      { dependencies: [CATALOG], directory: '.', name: 'app' },
    ],
    templates,
  });
  expect(plan.integration.some(({ suite }) => suite === 'browser')).toBe(true);
  // Every root file runs, including those listed in rows that hold no other root work.
  expect(rootTasks(plan.integration)).toEqual(rootTasks(templates.integration));
  const directories = new Set(plan.integration.flatMap(taskDirectories));
  expect(directories.has(SHELL_DIRECTORY)).toBe(true);
  expect(directories.has(CATALOG_DIRECTORY)).toBe(true);
});

it('follows topology-only Shell and vertical remote references to browser tests', () => {
  const verticals = [
    { id: 'catalog', package: CATALOG, path: CATALOG_DIRECTORY },
    { id: 'pricing', package: PRICING, path: PRICING_DIRECTORY },
    { id: 'privacy', package: PRIVACY, path: PRIVACY_DIRECTORY },
  ];
  const shell = { id: 'shell-super-app', package: SHELL, path: SHELL_DIRECTORY };
  for (const references of [
    { verticalRefs: ['catalog'] },
    { moduleFederation: { remotes: [{ id: 'catalog' }] } },
    { moduleFederation: { verticalRefs: ['catalog'] } },
  ]) {
    const graph = withCiTopologyDependencies(packages, { shell: { ...shell, ...references }, verticals });
    const plan = (changedPath: string) => planCiChecks({ changedPaths: [changedPath], packages: graph, templates });
    expect(plan(CATALOG_SOURCE).mode).toBe('affected');
    expect(plan(CATALOG_SOURCE).affectedPackages).toContain(SHELL);
    expect(plan(CATALOG_SOURCE).integration.some(({ suite }) => suite === 'browser')).toBe(true);
    expect(plan('app/verticals/privacy/src/service.ts').integration.some(({ suite }) => suite === 'browser')).toBe(
      false,
    );
  }
  const graph = withCiTopologyDependencies(packages, {
    shell: { ...shell, verticalRefs: ['privacy'] },
    verticals: [
      ...verticals.slice(0, 2),
      {
        id: 'privacy',
        moduleFederation: { remotes: [{ id: 'catalog' }] },
        package: PRIVACY,
        path: PRIVACY_DIRECTORY,
      },
    ],
  });
  expect(workspaceConsumerClosure(graph, [CATALOG])).toContain(SHELL);
});

it('widens unknown, duplicate or mismatched topology relationships to the complete suite', () => {
  const shell = { id: 'shell-super-app', package: SHELL, path: SHELL_DIRECTORY, verticalRefs: ['catalog'] };
  const catalog = { id: 'catalog', package: CATALOG, path: CATALOG_DIRECTORY };
  for (const topology of [
    { shell: { ...shell, verticalRefs: ['missing'] }, verticals: [catalog] },
    { shell, verticals: [catalog, catalog] },
    { shell, verticals: [{ ...catalog, path: 'verticals/missing' }] },
    { shell: { ...shell, package: '@app/missing' }, verticals: [catalog] },
  ]) {
    expect(
      planCiChecks({
        changedPaths: [CATALOG_SOURCE],
        packages: withCiTopologyDependencies(packages, topology),
        templates,
      }).mode,
    ).toBe('full');
  }
});

it('selects both disjoint customer-context partitions and retains its independently scheduled native proof', () => {
  const plan = planCiChecks({
    changedPaths: ['app/verticals/commerce-customer-context/src/service.ts'],
    packages,
    templates,
  });
  expect(
    EffectArray.sort(
      plan.integration
        .flatMap((entry) => entry.tasks ?? [])
        .filter((task) => task.startsWith('./verticals/commerce-customer-context#')),
      Order.String,
    ),
  ).toEqual(
    EffectArray.sort(
      Array.from({ length: 56 }, (_, index) => `./verticals/commerce-customer-context#${index + 1}/56`),
      Order.String,
    ),
  );
  expect(plan.integration.filter(preproposalRow)).toHaveLength(2);
});

it('widens changed shared infrastructure, unknown paths and package metadata to the complete suite', () => {
  for (const changedPath of [
    'app/packages/core-runtime/src/service.ts',
    'app/verticals/new-owner/src/service.ts',
    'app/verticals/catalog/package.json',
    'app/verticals/catalog/drizzle/0001.sql',
    'app/verticals/catalog/src/database/schema.ts',
    'app/verticals/catalog/src/permissions/owner.ts',
    'app/docs/architecture/DEPLOYMENT.md',
    '.github/workflows/ultramodern-workspace-gates.yml',
    'app/pnpm-lock.yaml',
  ]) {
    expect(planCiChecks({ changedPaths: [changedPath], packages, templates }).mode).toBe('full');
  }
});

// In affected mode the planner rewrites a unit entry's commands from the FIRST line's selectors alone.
// Any other flag on that line is discarded, so these three properties are the unit matrix's contract.
it('builds every unit entry from literal workspace selectors on its first command line', () => {
  for (const entry of templates.unit) {
    const lines = entry.commands.split('\n').filter(Boolean);
    const firstLine = lines[0] ?? '';
    expect(unknownFilters(firstLine)).toBe(false);
    const selectors = filterPaths(firstLine);
    expect(selectors).toHaveLength([...firstLine.matchAll(/--filter/gu)].length);
    expect(selectors.filter(({ path: selected }) => !knownSelectors.has(selected ?? ''))).toEqual([]);
    // Every later line must select the same packages, because only the first line survives rewriting.
    for (const line of lines.slice(1)) {
      expect(selectedDirectories(line)).toEqual(selectedDirectories(firstLine));
    }
  }
});

it('runs every workspace package in exactly one unit entry', () => {
  const covered = templates.unit.flatMap(({ commands }) => selectedDirectories(commands.split('\n')[0] ?? ''));
  // Disjoint shards: a selector-less reshard (for example `--shard 1/4`) would repeat the whole set per entry.
  expect(new Set(covered).size).toBe(covered.length);
  expect(EffectArray.sort(covered, Order.String)).toEqual(
    EffectArray.sort(
      workspacePackages.map(({ directory }) => directory),
      Order.String,
    ),
  );
});

it('keeps every unit and integration template resolvable so one glob cannot disable affected selection', () => {
  for (const command of templates.unit.flatMap(({ commands }) => commands.split('\n').filter(Boolean))) {
    expect(unknownFilters(command)).toBe(false);
    expect(filterPaths(command).filter(({ path: selected }) => !knownSelectors.has(selected ?? ''))).toEqual([]);
  }
  for (const task of templates.integration.flatMap((entry) => entry.tasks ?? [])) {
    expect(knownTask(task), task).toBe(true);
    const directory = taskDirectory(task);
    expect(directory === undefined || knownSelectors.has(directory), task).toBe(true);
  }
});

it('follows contract producers and terminates on dependency cycles', () => {
  expect(
    workspaceConsumerClosure(
      [
        { contractProducer: 'owner', dependencies: [], name: 'contract' },
        { dependencies: ['consumer'], name: 'owner' },
        { dependencies: ['contract'], name: 'consumer' },
        { dependencies: [], name: 'unrelated' },
      ],
      ['contract'],
    ),
  ).toEqual(new Set(['consumer', 'contract', 'owner']));
});

it.live('uses the exact Git comparison for documentation and refuses mixed, unavailable and manual shortcuts', () =>
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-diff-'));
    const script = fileURLToPath(new URL('../plan-ci-changes.sh', import.meta.url));
    const git = (...args: string[]) =>
      execFileSync('/usr/bin/git', ['-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', ...args], {
        cwd: directory,
        encoding: 'utf-8',
      }).trim();
    try {
      git('init', '--quiet');
      writeFileSync(path.join(directory, 'README.md'), 'before\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(path.join(directory, 'README.md'), 'after\n');
      git('commit', '--quiet', '-am', 'docs');
      const run = (event: string, comparison = base, force = 'false') => {
        const output = path.join(directory, 'outputs');
        writeFileSync(output, '');
        execFileSync('/bin/bash', [script, path.join(directory, 'paths')], {
          cwd: directory,
          env: {
            BASE_SHA: comparison,
            FORCE_FULL: force,
            GITHUB_EVENT_NAME: event,
            GITHUB_OUTPUT: output,
            HEAD_SHA: git('rev-parse', 'HEAD'),
            PATH: '/usr/bin:/bin',
          },
          stdio: 'pipe',
        });
        return readFileSync(output, 'utf-8');
      };
      const documentationPlan = run('merge_group');
      expect(documentationPlan).toContain('mode=docs\n');
      for (const helper of [
        'source',
        'unit',
        'unitAfterDatabase',
        'unitAfterLint',
        'unitAfterTopology',
        'integration',
        'integrationBuild',
        'integrationTopology',
      ]) {
        expect(documentationPlan).toContain(`${helper}=[]\n`);
      }
      expect(documentationPlan).not.toContain('cloudflare-artifact-build');
      expect(documentationPlan).toContain('lintSweep=changed\n');
      expect(run('push')).toContain('mode=docs\n');
      expect(run('workflow_dispatch')).toContain('mode=full\n');
      // Without the exact list, and on the nightly run, every tracked file is linted.
      const sweepAll = 'lintSweep=all\n';
      expect(run('workflow_dispatch')).toContain(sweepAll);
      expect(run('schedule')).toContain(sweepAll);
      expect(run('merge_group', '0'.repeat(40))).toContain('mode=full\n');
      expect(run('merge_group', '0'.repeat(40))).toContain(sweepAll);
      expect(run('merge_group', base, 'true')).toContain('mode=full\n');
      // A pull request is only ever tested as GitHub's merge commit; a plain commit has no exact base.
      expect(run('pull_request')).toContain('mode=full\n');
      git('mv', 'README.md', 'runtime.ts');
      git('commit', '--quiet', '-m', 'rename into application input');
      expect(run('merge_group')).toContain('mode=affected\n');
      expect(run('merge_group')).toContain('lintSweep=changed\n');
      // A changed formatter, linter or hook configuration reformats files nobody touched; test-runner
      // configuration does not alter formatting or lint semantics.
      const sweepAfter = (file: string) => {
        const target = path.join(directory, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${file}\n`);
        git('add', '--all');
        git('commit', '--quiet', '-m', file);
        const plan = run('merge_group', git('rev-parse', 'HEAD~1'));
        return /^lintSweep=(?<sweep>\w+)$/mu.exec(plan)?.groups?.sweep;
      };
      for (const configuration of [
        'lefthook.yml',
        'app/.oxlintrc.json',
        'app/oxfmt.config.ts',
        'app/packages/core-runtime/.prettierrc',
        'app/tools/oxlint/effect-native/rules/no-native-timers.ts',
        'app/patches/linter.patch',
        'app/tsconfig.base.json',
        'app/pnpm-lock.yaml',
        'app/pnpm-workspace.yaml',
        'app/.mise.toml',
      ]) {
        expect(sweepAfter(configuration), configuration).toBe('all');
      }
      for (const configuration of [
        'app/rstest.config.ts',
        'vitest.config.mts',
        'app/verticals/catalog/rstest.config.ts',
      ]) {
        expect(sweepAfter(configuration), configuration).toBe('changed');
      }
      // The base moved on after the fork point. The pull request's merge commit compares with its first
      // parent, so only the pull request's own documentation counts, never the base's newer changes.
      const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
      git('reset', '--quiet', '--hard');
      git('checkout', '--quiet', '-b', 'documentation', base);
      mkdirSync(path.join(directory, 'docs'), { recursive: true });
      writeFileSync(path.join(directory, 'docs/guide.md'), 'guide\n');
      git('add', 'docs/guide.md');
      git('commit', '--quiet', '-m', 'guide');
      git('checkout', '--quiet', trunk);
      git('merge', '--quiet', '--no-ff', '-m', 'Merge documentation', 'documentation');
      expect(run('pull_request', base)).toContain('mode=docs\n');
      expect(readFileSync(path.join(directory, 'paths'), 'utf-8')).toBe('docs/guide.md\0');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

const NO_INSTALL_PLANNER = 'scripts/plan-ci-without-install.sh';
const decode = (value: string) =>
  Object.fromEntries(
    value
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        const key = line.slice(0, separator);
        const encoded = line.slice(separator + 1);
        return [
          key,
          key === 'mode' ? encoded : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(encoded),
        ];
      }),
  );
it('plans with no installed dependencies using the same tested impact algorithm', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'ontos-ci-without-deps-'));
  const app = fileURLToPath(new URL('../..', import.meta.url));
  const copy = (file: string) => {
    const target = path.join(fixture, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(app, file)));
  };
  try {
    for (const file of [
      PACKAGE_MANIFEST,
      'topology/ownership.json',
      'topology/reference-topology.json',
      'scripts/ci-matrices.json',
      'scripts/ci-impact.mts',
      'scripts/workspace-consumer-closure.mts',
      NO_INSTALL_PLANNER,
    ]) {
      copy(file);
    }
    for (const area of ['apps', 'packages', 'verticals']) {
      for (const entry of readdirSync(path.join(app, area))) {
        const file = `${area}/${entry}/package.json`;
        if (existsSync(path.join(app, file))) {
          copy(file);
        }
      }
    }
    expect(existsSync(path.join(fixture, 'node_modules'))).toBe(false);
    const paths = path.join(fixture, 'paths');
    const output = path.join(fixture, 'output');
    const summary = path.join(fixture, 'summary');
    const plan = (command: string, args: readonly string[], cwd: string, mode: Readonly<Record<string, string>>) => {
      writeFileSync(output, '');
      execFileSync(command, args, {
        cwd,
        env: {
          ...mode,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          LINT_SWEEP: 'changed',
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stdio: 'pipe',
      });
      return decode(readFileSync(output, 'utf-8'));
    };
    // The nightly and manual backstop reaches the shell planner as BOOTSTRAP_MODE=full and the installed
    // CLI as --full; both must widen the plan.
    for (const [bootstrapMode, flags] of [
      ['affected', []],
      ['full', ['--full']],
    ] as const) {
      for (const changed of [CATALOG_SOURCE, 'app/scripts/check.mts']) {
        writeFileSync(paths, `${changed}\0`);
        const native = plan('/bin/bash', [NO_INSTALL_PLANNER, paths], fixture, { BOOTSTRAP_MODE: bootstrapMode });
        const installed = plan(
          process.execPath,
          ['scripts/plan-ci-checks.mts', '--paths-file', paths, ...flags],
          app,
          {},
        );
        expect(native).toEqual(installed);
        if (bootstrapMode === 'full') {
          expect(native.mode).toBe('full');
        }
      }
    }
    const invalidModes: readonly Readonly<Record<string, string>>[] = [
      {},
      { BOOTSTRAP_MODE: 'Full' },
      { BOOTSTRAP_MODE: 'docs' },
    ];
    for (const mode of invalidModes) {
      expect(() => plan('/bin/bash', [NO_INSTALL_PLANNER, paths], fixture, mode)).toThrow(
        /BOOTSTRAP_MODE must be affected or full/u,
      );
    }
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

it('promotes a lone affected deferred unit row instead of expanding an empty required matrix', () => {
  const none = { afterDatabase: [], afterLint: [], afterTopology: [] };
  for (const deferred of templates.unit.filter((row) => row['after-check'] !== undefined)) {
    expect(unitPhases([deferred], 'changed')).toEqual({ ...none, work: [deferred] });
  }
  const full = unitPhases(templates.unit, 'changed');
  expect(full.work).toEqual(templates.unit.filter((row) => row['after-check'] === undefined));
  expect([...full.work, ...full.afterDatabase, ...full.afterLint, ...full.afterTopology]).toHaveLength(
    templates.unit.length,
  );
  expect(unitPhases([], 'changed')).toEqual({ ...none, work: [] });
});

it('promotes only one deferred unit row so the others keep their bounded runner slots', () => {
  const selected = templates.unit.filter((row) => row['after-check'] !== undefined);
  expect(selected.length).toBeGreaterThan(1);
  const phases = unitPhases(selected, 'changed');
  expect(phases.work).toEqual(selected.slice(0, 1));
  expect([...phases.afterDatabase, ...phases.afterLint, ...phases.afterTopology]).toHaveLength(selected.length - 1);
});

it('moves the row behind lint to the topology slot when ci-plan sweeps every file', () => {
  const lint = templates.unit.filter((row) => row['after-check'] === 'lint');
  expect(lint).toHaveLength(1);
  const changed = unitPhases(templates.unit, 'changed');
  const all = unitPhases(templates.unit, 'all');
  expect(changed.afterLint).toEqual(lint);
  expect(all.afterLint).toEqual([]);
  expect(all.afterTopology).toEqual(
    templates.unit.filter((row) => changed.afterTopology.includes(row) || lint.includes(row)),
  );
  expect(all.work).toEqual(changed.work);
  expect(all.afterDatabase).toEqual(changed.afterDatabase);
});

/** Every owner task a list of integration rows runs, sorted. */
const ownerTasks = (rows: readonly { readonly tasks?: readonly string[] | undefined }[]) =>
  EffectArray.sort(
    rows.flatMap((row) => row.tasks ?? []),
    Order.String,
  );

// The gate-id jobs (workspace-unit, service-integration, node-artifact-build) must never receive an empty
// matrix while their gate is expected to succeed: expanding an empty matrix fails the run, and skipping it
// fails the gate.
it('gives each gate-id job at least one row for every single-owner change and either lint sweep', () => {
  for (const owner of workspacePackages) {
    const plan = planCiChecks({
      changedPaths: [`app/${owner.directory}/src/service.ts`],
      packages: workspacePackages,
      templates,
    });
    for (const lintSweep of ['all', 'changed'] as const) {
      const outputs = ciPlanOutputs(plan, lintSweep);
      if (plan.expected['workspace-unit'] === 'success') {
        expect(outputs.unit.length, `${owner.name} ${lintSweep}`).toBeGreaterThan(0);
      }
      if (plan.expected['service-integration'] === 'success') {
        expect(outputs.integration.length, `${owner.name} ${lintSweep}`).toBeGreaterThan(0);
        expect(outputs.integrationTopology.length, `${owner.name} ${lintSweep}`).toBeGreaterThan(0);
      }
      expect(outputs.integrationBuild.length, `${owner.name} ${lintSweep}`).toBeGreaterThan(0);
      expect(
        [...outputs.unit, ...outputs.unitAfterDatabase, ...outputs.unitAfterLint, ...outputs.unitAfterTopology],
        owner.name,
      ).toHaveLength(plan.unit.length);
      // Every selected owner task runs on a building owner row.
      expect(ownerTasks(outputs.integrationBuild), owner.name).toEqual(ownerTasks(plan.integration));
    }
  }
});
