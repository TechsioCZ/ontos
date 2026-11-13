import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

import { tenantServesPeople } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { RELEASE_MODULES_SCRIPT, releaseModulesEnvironment } from '../zerops/app-host.mts';
import { marketActivationScopeAllowed } from './activate-market-stage.mts';
import { demoTenantId } from './fixture-ids.mts';
import { N1_TENANT_ID } from './n1-stage-grants.mts';
import { reportLines, reportProblems } from './release-tenant-modules.mts';
import { financeBillingManifest } from '../../verticals/finance-billing/vertical.manifest.ts';
import { merchandiseManifest } from '../../verticals/merchandise/vertical.manifest.ts';
import {
  AKROS_PLAYGROUND_TENANT_ID,
  sellingModuleKeys,
  stageActivationScopes,
  stageReleaseModuleRules,
  taxModuleKey,
} from './stage-tenant-modules.mts';

const tax = 'commerce.tax';
const selling = ['demo.merchandise', 'finance.billing'];
const appHostSource = () => readFileSync(new URL('../zerops/app-host.mts', import.meta.url), 'utf-8');
/** Where the app host starts the release module step. */
const RELEASE_STEP_MARKER = "'release-modules',";

it('the release derives its Tenants from a rule, never from a list: Tax wherever a Tenant sells or invoices', () => {
  expect(stageReleaseModuleRules).toEqual([{ moduleKey: tax, whereActive: selling }]);
  expect([...sellingModuleKeys]).toEqual(selling);
  expect(stageReleaseModuleRules.map(({ moduleKey }) => moduleKey)).toEqual([taxModuleKey]);
});

it('Finance Billing and Merchandise install Tax with them, exactly the modules the release rule names', () => {
  const owners: readonly {
    readonly activation: { readonly installsWith?: readonly string[] };
    readonly module: { readonly id: string };
  }[] = [financeBillingManifest, merchandiseManifest];
  const installingTax = owners
    .filter(({ activation }) => activation.installsWith?.includes(tax) === true)
    .map(({ module }) => module.id)
    .toSorted();
  expect(installingTax).toEqual(selling);
  expect(financeBillingManifest.activation.installsWith).toEqual([tax]);
  expect(merchandiseManifest.activation.installsWith).toEqual([tax]);
});

it('the manual activation list still names Tax only beside the selling Tenants it was reviewed for', () => {
  const manual = stageActivationScopes.flatMap(({ moduleKeys, tenantId }) =>
    moduleKeys.map((key) => `${tenantId} ${key}`),
  );
  expect(manual.filter((pair) => pair.endsWith(` ${tax}`))).toEqual([
    `${demoTenantId} ${tax}`,
    `${N1_TENANT_ID} ${tax}`,
    `${AKROS_PLAYGROUND_TENANT_ID} ${tax}`,
  ]);
  for (const tenantId of [demoTenantId, N1_TENANT_ID, AKROS_PLAYGROUND_TENANT_ID]) {
    expect(marketActivationScopeAllowed(tenantId, tax, 'session')).toBe(true);
    expect(tenantServesPeople(tenantId)).toBe(true);
  }
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
  // A failed reconcile says what heals it; no Outbox wake-up is written with the install any more.
  const [, failedLine] = reportLines(failed);
  expect(failedLine).toContain(`tenant ${N1_TENANT_ID}: RECONCILE FAILED (engine down)`);
  expect(failedLine).toContain('this step reconciles it again on the next deploy');
  expect(failedLine).not.toContain('Outbox');
});

it('the access catalog activation runs inside the migrator, before the release step of the same boot', () => {
  const host = appHostSource();
  const migrator = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
  // The migrator's last step is the activation: the same boot's activation can never heal the release step's work,
  // which is why the step reconciles an already active module itself.
  expect(migrator.indexOf('accessReleaseActivationArguments(appDirectory)')).toBeGreaterThan(
    migrator.indexOf("runAppScript('scripts/verify-application-db-schema.mts')"),
  );
  const migrated = host.indexOf("runChild('migrator', node, ['scripts/run-zerops-migrator.mjs']");
  expect(migrated).toBeGreaterThan(0);
  expect(host.indexOf(RELEASE_STEP_MARKER)).toBeGreaterThan(migrated);
});

it('the app host runs the release step after it publishes the composition, without holding the boot', () => {
  const host = appHostSource();
  expect(RELEASE_MODULES_SCRIPT).toBe('scripts/demo/release-tenant-modules.mts');
  const published = host.indexOf('yield* openPublicPort;');
  const step = host.indexOf(RELEASE_STEP_MARKER);
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
  expect(step).toContain('const deadline = DateTime.addDuration(yield* DateTime.now, RELEASE_MODULES_BUDGET);');
  // The Tenants come from Core's module states at every release, never from a list.
  expect(step).toContain('deriveReleaseTenantModules(stageReleaseModuleRules)');
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
  const host = appHostSource();
  const step = host.slice(
    host.indexOf(RELEASE_STEP_MARKER),
    host.indexOf('const outboxHost = yield* makeCredentialHolder('),
  );
  // `false`: the child does not inherit the supervisor's environment on top.
  expect(step).toMatch(/releaseModulesEnvironment\(releaseSettings, derived\),\s+false,/u);
});
