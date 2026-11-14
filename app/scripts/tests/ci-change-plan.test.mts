import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CiTemplatesSchema, planCiChecks, withCiTopologyDependencies } from '../plan-ci-checks.mts';
import { workspaceConsumerClosure } from '../workspace-consumer-closure.mts';

const templates = Schema.decodeUnknownSync(Schema.fromJsonString(CiTemplatesSchema))(
  readFileSync(new URL('../ci-matrices.json', import.meta.url), 'utf-8'),
);
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

it('selects owner and transitive consumer tests without selecting an unrelated owner', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates,
  });
  expect(plan.mode).toBe('affected');
  expect(plan.affectedPackages).toEqual([CATALOG, PRICING]);
  expect(plan.integration.map(({ name }) => name)).toEqual([
    'Pricing and Inventory Integration',
    'Catalog Integration',
    'Native Preproposal Basis and Approval Proof',
  ]);
  expect(plan.unit.flatMap(({ commands }) => commands.split('\n'))).toContain(
    'pnpm -r --no-sort --if-present --filter ./verticals/catalog run test:unit',
  );
});

it('retains the native preproposal proof for each runtime owner even without ordinary package-filter matches', () => {
  const native = templates.integration.find((entry) => entry['native-preproposal'] === true);
  expect(native?.['proof-packages']).toHaveLength(8);
  for (const owner of native?.['proof-packages'] ?? []) {
    const workspacePackage = packages.find(({ name }) => name === owner);
    const plan = planCiChecks({
      applyAffected: true,
      changedPaths: [`app/${workspacePackage?.directory ?? 'missing'}/src/service.ts`],
      packages,
      templates,
    });
    expect(plan.mode).toBe('affected');
    expect(plan.integration.some((entry) => entry['native-preproposal'] === true)).toBe(true);
    if (owner === PRICING) {
      expect(plan.affectedPackages).toEqual([PRICING]);
      expect(plan.integration.find((entry) => entry['native-preproposal'] === true)?.['package-filters']).toBe('');
      expect(plan.integration.find((entry) => entry['native-preproposal'] === true)?.['root-suite']).toBe(false);
    }
  }
});

it('omits the native preproposal proof for an unrelated owner and widens unknown proof dependencies', () => {
  const plan = (entries: typeof packages) =>
    planCiChecks({
      applyAffected: true,
      changedPaths: ['app/verticals/privacy/src/service.ts'],
      packages: entries,
      templates,
    });
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

it('gives each matrix job only its own rows and plans a job without rows as skipped', () => {
  const full = planCiChecks({ applyAffected: false, changedPaths: [CATALOG_SOURCE], packages, templates });
  expect(full.jobs.browser.map(({ suite }) => suite)).toEqual(['browser']);
  expect(full.jobs.services.every(({ suite }) => suite === 'integration')).toBe(true);
  expect(full.jobs.services.length + full.jobs.browser.length).toBe(templates.integration.length);
  // The Fresh Database rows run the files that migrate their own database and never restore the seed.
  const fresh = full.jobs.services.filter((entry) => entry['fresh-database-tests'] === 'only');
  expect(fresh.length).toBeGreaterThan(0);
  expect(fresh.some((entry) => entry.seed === true)).toBe(false);
  expect(full.jobs.unitArtifacts.every((entry) => entry['node-artifacts'] === true)).toBe(true);
  expect(full.jobs.unitPlain.some((entry) => entry['node-artifacts'] === true)).toBe(false);
  expect(full.jobs.unitArtifacts.length + full.jobs.unitPlain.length).toBe(templates.unit.length);
  expect(Object.values(full.expected).every((result) => result === 'success')).toBe(true);
  const affected = planCiChecks({ applyAffected: true, changedPaths: [CATALOG_SOURCE], packages, templates });
  // Catalog and Pricing unit rows read built outputs, and no browser row consumes them.
  expect(affected.expected['workspace-unit-artifacts']).toBe('success');
  expect(affected.expected['browser-integration']).toBe('skipped');
  expect(affected.expected['node-artifact-proof']).toBe('success');
  expect(affected.expected['node-artifact-build']).toBe('success');
  // The seed producer runs whenever an integration row does, also on an affected round; no row waits for it.
  expect(affected.expected['integration-seed-proof']).toBe('success');
  expect(affected.jobs.services.map(({ name }) => name)).toContain('Catalog Integration');
  // A sharded single-package row whose package is affected runs exactly as planned.
  const shell = planCiChecks({
    applyAffected: true,
    changedPaths: ['app/apps/shell-super-app/src/service.ts'],
    packages,
    templates,
  });
  expect(shell.unit.filter(({ name }) => name.startsWith('Unit Tests (Shell')).map(({ commands }) => commands)).toEqual(
    templates.unit.filter(({ name }) => name.startsWith('Unit Tests (Shell')).map(({ commands }) => commands),
  );
});

it('keeps affected selection in shadow mode until explicitly enabled', () => {
  const plan = planCiChecks({
    applyAffected: false,
    changedPaths: [CATALOG_SOURCE],
    packages,
    templates,
  });
  expect(plan.mode).toBe('full');
  expect(plan.integration).toEqual(templates.integration);
  expect(plan.expected).not.toHaveProperty('cloudflare-artifact-build');
  expect(plan.affectedPackages).toEqual([CATALOG, PRICING]);
});

it('keeps mixed documentation and owner changes scoped, but widens a mixed unknown owner', () => {
  expect(
    planCiChecks({
      applyAffected: true,
      changedPaths: ['README.md', CATALOG_SOURCE],
      packages,
      templates,
    }).mode,
  ).toBe('affected');
  expect(
    planCiChecks({
      applyAffected: true,
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
    expect(
      planCiChecks({
        applyAffected: true,
        changedPaths: [CATALOG_SOURCE],
        packages: [...packages, extra],
        templates,
      }).mode,
    ).toBe('full');
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
      applyAffected: true,
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

it('selects browser checks, all root integration shards and every Shell shard when they consume a changed package', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages: [
      ...packages.map((entry) => (entry.name === SHELL ? { ...entry, dependencies: [CATALOG] } : entry)),
      { dependencies: [CATALOG], directory: '.', name: 'app' },
    ],
    templates,
  });
  expect(plan.integration.some(({ suite }) => suite === 'browser')).toBe(true);
  const roots = plan.integration.filter(
    (entry) => entry['root-suite'] === true && entry['fresh-database-tests'] !== 'only',
  );
  expect(roots.map((entry) => entry['root-rstest-shard'])).toEqual(['1/4', '2/4', '3/4', '4/4']);
  expect(roots.every((entry) => entry['package-filters'] === '')).toBe(true);
  // The Shell suite runs in its own shards, so the root-suite shard names no package here.
  expect(plan.integration.find((entry) => entry['root-suite'] === true)?.['package-filters']).toBe('');
  expect(
    plan.integration
      .filter((entry) => entry['package-filters'] === '--filter ./apps/shell-super-app')
      .map((entry) => entry['rstest-shard']),
  ).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5']);
});

it('keeps a root-only integration shard empty of package filters rather than selecting every package', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: [CATALOG_SOURCE],
    packages: [...packages, { dependencies: [CATALOG], directory: '.', name: 'app' }],
    templates,
  });
  expect(plan.integration.find((entry) => entry['root-suite'] === true)?.['package-filters']).toBe('');
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
    const plan = (changedPath: string) =>
      planCiChecks({ applyAffected: true, changedPaths: [changedPath], packages: graph, templates });
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
        applyAffected: true,
        changedPaths: [CATALOG_SOURCE],
        packages: withCiTopologyDependencies(packages, topology),
        templates,
      }).mode,
    ).toBe('full');
  }
});

it('uses every customer-context shard for any selected customer-context package change', () => {
  const plan = planCiChecks({
    applyAffected: true,
    changedPaths: ['app/verticals/commerce-customer-context/src/service.ts'],
    packages,
    templates,
  });
  expect(
    plan.integration
      .filter((entry) => entry['rstest-shard'] !== undefined && entry['fresh-database-tests'] !== 'only')
      .map((entry) => entry['rstest-shard']),
  ).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5']);
  // Its files that migrate their own database still run, in the Fresh Database rows.
  expect(plan.integration.filter((entry) => entry['fresh-database-tests'] === 'only')).toHaveLength(2);
  expect(plan.integration.some((entry) => entry['native-preproposal'] === true)).toBe(true);
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
    expect(planCiChecks({ applyAffected: true, changedPaths: [changedPath], packages, templates }).mode).toBe('full');
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
      const run = (event: string, comparison = base, force = 'false', candidate = 'false') => {
        const output = path.join(directory, 'outputs');
        writeFileSync(output, '');
        execFileSync('/bin/bash', [script, path.join(directory, 'paths')], {
          cwd: directory,
          env: {
            BASE_SHA: comparison,
            CANDIDATE_DISPATCH: candidate,
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
      // A candidate dispatch with a resolved comparison point is classified like a pull request, unless forced full.
      expect(run('workflow_dispatch', base, 'false', 'true')).toContain('mode=docs\n');
      expect(run('workflow_dispatch', base, 'true', 'true')).toContain('mode=full\n');
      expect(run('workflow_dispatch', '0'.repeat(40), 'false', 'true')).toContain('mode=full\n');
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
