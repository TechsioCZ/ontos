import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { tenantServesPeople } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { RELEASE_MODULES_SCRIPT, releaseModulesEnvironment } from '../zerops/app-host.mts';
import { marketActivationScopeAllowed } from './activate-market-stage.mts';
import { demoTenantId } from './fixture-ids.mts';
import { N1_TENANT_ID } from './n1-stage-grants.mts';
import { reportLines, reportProblems } from './release-tenant-modules.mts';
import {
  AKROS_PLAYGROUND_TENANT_ID,
  sellingModuleKeys,
  stageActivationScopes,
  stageReleaseTenantModules,
} from './stage-tenant-modules.mts';

const tax = 'commerce.tax';
const selling = ['demo.merchandise', 'finance.billing'];

it('the release installs only its own reviewed pairs, each of them also a manual pair', () => {
  const released = stageReleaseTenantModules.map(({ moduleKey, tenantId }) => `${tenantId} ${moduleKey}`);
  // Exactly commerce.tax for the three selling Tenants: market catalogue, storefront registry, Projekty and Tasks
  // stay manual, and whatever is added to the manual list later is never installed by a release on its own.
  expect(released).toEqual([
    `${demoTenantId} ${tax}`,
    `${N1_TENANT_ID} ${tax}`,
    `${AKROS_PLAYGROUND_TENANT_ID} ${tax}`,
  ]);
  for (const { moduleKey, tenantId } of stageReleaseTenantModules) {
    expect(marketActivationScopeAllowed(tenantId, moduleKey, 'session')).toBe(true);
    // Never the platform's own tenant, which serves no people (the installer refuses it as well).
    expect(tenantServesPeople(tenantId)).toBe(true);
  }
  const manual = stageActivationScopes.flatMap(({ moduleKeys, tenantId }) =>
    moduleKeys.map((key) => `${tenantId} ${key}`),
  );
  expect(manual.filter((pair) => !released.includes(pair))).toEqual([
    `${demoTenantId} commerce.market-catalog`,
    `${demoTenantId} commerce.storefront-registry`,
    `${demoTenantId} projects.core`,
    `${N1_TENANT_ID} work.tasks`,
  ]);
});

it('declares commerce.tax for the three selling Tenants, only where they already sell or invoice', () => {
  expect(
    stageReleaseTenantModules.filter(({ moduleKey }) => moduleKey === tax).map(({ tenantId }) => tenantId),
  ).toEqual([demoTenantId, N1_TENANT_ID, AKROS_PLAYGROUND_TENANT_ID]);
  for (const entry of stageReleaseTenantModules) {
    expect(entry.sellingModuleKeys).toEqual(entry.moduleKey === tax ? selling : []);
  }
  expect([...sellingModuleKeys]).toEqual(selling);
});

it('reports every decision in one line and fails only on a module it could not install or project', () => {
  const report = {
    modules: [
      {
        detail: 'installed active by the release',
        moduleKey: tax,
        outcome: 'installed' as const,
        tenantId: demoTenantId,
      },
      { detail: 'active', moduleKey: tax, outcome: 'already_active' as const, tenantId: N1_TENANT_ID },
      {
        detail: 'a person set it inactive; a release never changes that',
        moduleKey: 'work.tasks',
        outcome: 'left_as_set' as const,
        tenantId: N1_TENANT_ID,
      },
    ],
    reconciles: [{ deletions: 0, tenantId: demoTenantId, touches: 12 }],
  };
  expect(reportLines(report)).toEqual([
    `[release-modules] tenant ${demoTenantId} ${tax}: installed (installed active by the release)`,
    `[release-modules] tenant ${N1_TENANT_ID} ${tax}: already_active (active)`,
    `[release-modules] tenant ${N1_TENANT_ID} work.tasks: left_as_set (a person set it inactive; a release never changes that)`,
    `[release-modules] tenant ${demoTenantId}: reconciled, SpiceDB +12/-0`,
  ]);
  expect(reportProblems(report)).toEqual([]);
  const failed = {
    modules: [{ detail: 'boom', moduleKey: tax, outcome: 'failed' as const, tenantId: demoTenantId }],
    reconciles: [{ deletions: 0, failure: 'engine down', tenantId: N1_TENANT_ID, touches: 0 }],
  };
  expect(reportProblems(failed)).toEqual([`${demoTenantId} ${tax}`, `${N1_TENANT_ID} reconcile`]);
});

it('the app host runs the release step after it publishes the composition, without holding the boot', () => {
  const host = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
  expect(RELEASE_MODULES_SCRIPT).toBe('scripts/demo/release-tenant-modules.mts');
  const published = host.indexOf('yield* openPublicPort;');
  const step = host.indexOf("'release-modules',");
  const outbox = host.indexOf('const outboxHost = yield* makeCredentialHolder(');
  expect(published).toBeGreaterThan(0);
  expect(step).toBeGreaterThan(published);
  expect(outbox).toBeGreaterThan(step);
  const wiring = host.slice(step, outbox);
  expect(wiring).toContain('Effect.forkChild');
  expect(wiring).toContain('RELEASE MODULE INSTALLATION FAILED');
  // The host never kills the step for time: the step keeps its own limit, and a stop is SIGTERM first.
  expect(wiring).not.toContain('timeout');
  const runChild = host.slice(host.indexOf('const runChild = '), host.indexOf('// HTTP'));
  expect(runChild).toContain('forceKillAfter: FINITE_CHILD_FORCE_KILL_AFTER');
});

it('the release step turns SIGTERM into an interrupt and keeps its own time limit', () => {
  const step = readFileSync(new URL('release-tenant-modules.mts', import.meta.url), 'utf-8');
  expect(step).toContain('NodeRuntime.runMain(');
  expect(step).not.toContain('Effect.runPromiseExit');
  expect(step).toContain('deadline: DateTime.addDuration(yield* DateTime.now, RELEASE_MODULES_BUDGET)');
});

it('starts the release step with only the settings it reads, never the supervisor secrets', () => {
  const container = new Map([
    ['COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL', 'postgresql://portal-admin'],
    ['DATABASE_ADMIN_URL', 'postgresql://admin'],
    ['DATABASE_URL', 'postgresql://runtime'],
    ['ONTOS_OWNER_SECRETS_JSON', '{"secret":"x"}'],
    ['PATH', '/usr/bin'],
    ['SPICEDB_DATABASE_PASSWORD', 'p'],
    ['SPICEDB_ENDPOINT', 'spicedb:50051'],
    ['SPICEDB_PRESHARED_KEY', 'k'],
    ['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT', 'stage'],
  ]);
  const environment = releaseModulesEnvironment(container, {
    BETTER_AUTH_URL: 'https://ontos',
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'http://127.0.0.1:3000/_host/composition',
  });
  expect(environment).toEqual({
    DATABASE_URL: 'postgresql://runtime',
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'http://127.0.0.1:3000/_host/composition',
    PATH: '/usr/bin',
    SPICEDB_ENDPOINT: 'spicedb:50051',
    SPICEDB_PRESHARED_KEY: 'k',
    ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'stage',
  });
  const host = readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
  const step = host.slice(host.indexOf("'release-modules',"), host.indexOf('const outbox = yield* startChild('));
  // `false`: the child does not inherit the supervisor's environment on top.
  expect(step).toMatch(/releaseModulesEnvironment\(releaseSettings, derived\),\s+false,/u);
});
