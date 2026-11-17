import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CiTemplatesSchema,
  filterPaths,
  integrationPhases,
  matchingPackages,
  planCiChecks,
  unknownFilters,
  withCiTopologyDependencies,
} from '../plan-ci-checks.mts';
import { workspaceConsumerClosure } from '../workspace-consumer-closure.mts';

const templates = Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
  readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
);

it('prepares the database even when browser tests are not selected, without adding unrelated browser work', () => {
  const phases = integrationPhases(templates.integration.filter(({ suite }) => suite !== 'browser'));
  expect(phases.preparation).toEqual([{ name: 'Prepare integration database', suite: 'database' }]);
  expect(phases.topology).toEqual(templates.integration.filter(({ suite }) => suite === 'bootstrap'));
  expect(phases.work).toEqual(templates.integration.filter((entry) => entry.suite === 'integration'));
  expect(integrationPhases([])).toEqual({ preparation: [], topology: [], work: [] });
});
const CATALOG = '@app/catalog';
const PRICING = '@app/pricing';
const CATALOG_SOURCE = 'app/verticals/catalog/src/service.ts';
const ANOTHER_DIRECTORY = 'verticals/another';
const CUSTOMER_CONTEXT = '@app/commerce-customer-context';
const SHELL = '@app/shell-super-app';
const CATALOG_DIRECTORY = 'verticals/catalog';
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
  { dependencies: [CATALOG], directory: 'verticals/pricing', name: PRICING },
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
  expect(
    matchingPackages(tests.map((entry) => entry['package-filters'] ?? '').join(' '), packages).map(({ name }) => name),
  ).toEqual([CATALOG, PRICING]);
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

it('retains the native preproposal proof for each runtime owner even without ordinary package-filter matches', () => {
  const native = templates.integration.find((entry) => entry['native-preproposal'] === true);
  expect(native?.['proof-packages']).toHaveLength(8);
  for (const owner of native?.['proof-packages'] ?? []) {
    const workspacePackage = packages.find(({ name }) => name === owner);
    const plan = planCiChecks({
      changedPaths: [`app/${workspacePackage?.directory ?? 'missing'}/src/service.ts`],
      packages,
      templates,
    });
    expect(plan.mode).toBe('affected');
    expect(plan.integration.some((entry) => entry['native-preproposal'] === true)).toBe(true);
    if (owner === PRICING) {
      expect(plan.affectedPackages).toEqual([PRICING]);
      expect(['', '--filter ./verticals/pricing']).toContain(
        plan.integration.find((entry) => entry['native-preproposal'] === true)?.['package-filters'],
      );
      expect(plan.integration.find((entry) => entry['native-preproposal'] === true)?.['root-suite']).toBe(false);
    }
  }
});

it('omits the native preproposal proof for an unrelated owner and widens unknown proof dependencies', () => {
  const plan = (entries: typeof packages) =>
    planCiChecks({ changedPaths: ['app/verticals/privacy/src/service.ts'], packages: entries, templates });
  expect(plan(packages).mode).toBe('affected');
  expect(plan(packages).integration.some((entry) => entry['native-preproposal'] === true)).toBe(false);
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

it('rejects incomplete full matrices and widens unsupported package-selector syntax', () => {
  expect(
    Schema.is(CiTemplatesSchema)({
      ...templates,
      integration: [{ name: 'Missing package selection', suite: 'integration' }],
    }),
  ).toBe(false);
  expect(
    planCiChecks({
      changedPaths: [CATALOG_SOURCE],
      packages,
      templates: {
        ...templates,
        integration: [
          {
            name: 'Unproven selector',
            'package-filters': '--filter ./verticals/catalog --filter @app/pricing...',
            suite: 'integration',
          },
        ],
      },
    }).mode,
  ).toBe('full');
});

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
  const roots = plan.integration.filter((entry) => entry['root-suite'] === true);
  expect(roots.map((entry) => entry['root-rstest-shard'])).toEqual(
    templates.integration.filter((entry) => entry['root-suite'] === true).map((entry) => entry['root-rstest-shard']),
  );
  const filters = roots.map((entry) => entry['package-filters'] ?? '').join(' ');
  expect(filters).toContain('--filter ./apps/shell-super-app');
  expect(filters).toContain('--filter ./verticals/catalog');
});

it('follows topology-only Shell and vertical remote references to browser tests', () => {
  const verticals = [
    { id: 'catalog', package: CATALOG, path: CATALOG_DIRECTORY },
    { id: 'pricing', package: PRICING, path: 'verticals/pricing' },
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
  const selected = plan.integration.filter((entry) =>
    (entry['package-filters'] ?? '').includes('./verticals/commerce-customer-context'),
  );
  expect(
    EffectArray.sort(
      selected
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
  expect(plan.integration.filter((entry) => entry['native-preproposal'] === true)).toHaveLength(2);
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
  for (const command of [
    ...templates.unit.flatMap(({ commands }) => commands.split('\n').filter(Boolean)),
    ...templates.integration.map((entry) => entry['package-filters'] ?? ''),
  ]) {
    expect(unknownFilters(command)).toBe(false);
    expect(filterPaths(command).filter(({ path: selected }) => !knownSelectors.has(selected ?? ''))).toEqual([]);
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
      const documentationPlan = run('pull_request');
      expect(documentationPlan).toContain('mode=docs\n');
      expect(documentationPlan).not.toContain('cloudflare-artifact-build');
      expect(run('merge_group')).toContain('mode=docs\n');
      expect(run('workflow_dispatch')).toContain('mode=full\n');
      expect(run('pull_request', '0'.repeat(40))).toContain('mode=full\n');
      expect(run('pull_request', base, 'true')).toContain('mode=full\n');
      git('mv', 'README.md', 'runtime.ts');
      git('commit', '--quiet', '-m', 'rename into application input');
      expect(run('pull_request')).toContain('mode=affected\n');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }),
);

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
      'scripts/plan-ci-without-install.sh',
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
    for (const changed of [CATALOG_SOURCE, 'app/scripts/check.mts']) {
      const paths = path.join(fixture, 'paths');
      const output = path.join(fixture, 'output');
      const summary = path.join(fixture, 'summary');
      writeFileSync(paths, `${changed}\0`);
      writeFileSync(output, '');
      execFileSync('/bin/bash', ['scripts/plan-ci-without-install.sh', paths], {
        cwd: fixture,
        env: {
          BOOTSTRAP_MODE: 'affected',
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      const native = readFileSync(output, 'utf-8');
      writeFileSync(output, '');
      execFileSync(process.execPath, ['scripts/plan-ci-checks.mts', '--paths-file', paths], {
        cwd: app,
        env: {
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        },
      });
      const installed = readFileSync(output, 'utf-8');
      expect(decode(native)).toEqual(decode(installed));
    }
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
