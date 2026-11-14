import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

/**
 * The authorization-v2 cutover deleted the legacy provisioning runtime (ADR-0030). No script may import it again, and
 * no local compatibility stub may stand in for it: the deploy host and the release path must go through the canonical
 * access bootstrap, the single Core writer and the read-only release gate.
 */
const script = (relative: string) => new URL(`../${relative}`, import.meta.url);

/** The retired modules; the deleted CLI and the core runtime that derived legacy Action edges. */
const RETIRED_MODULES = [
  'provision-current-action-authorization',
  'install/action-authorization-provisioning',
  'permissions/business-permission-mutation',
  'permissions/authorization-mutation',
  'permissions/authorization-reconciler',
  'permissions/action-authorization-preflight',
  'permissions/owner-authorization-overlay',
  'permissions/resource-containment-mutation',
] as const;

/** The modules this repair owns; each is the deploy host, the release gate, or the stage grant path. */
const REPAIRED_MODULES = [
  'zerops/app-host.mts',
  'zerops/release-access-verification.mts',
  'zerops/release-access-verification.test.mts',
  'demo/reconcile-stage-service-grants.mts',
  'demo/n1-stage-grants.mts',
  'demo/n1-stage-grants.test.mts',
  'demo/n1-release-grants.mts',
  'demo/n1-release-grants.test.mts',
  'tests/reconcile-stage-service-grants.test.mts',
  'integration/service-grant-scans.test.mts',
] as const;

it('no longer ships the retired provisioning CLI or its test', () => {
  expect(existsSync(script('provision-current-action-authorization.mts'))).toBe(false);
  expect(existsSync(script('tests/provision-current-action-authorization.test.mts'))).toBe(false);
});

it('no longer ships the retired core authorization runtime', () => {
  for (const retired of RETIRED_MODULES) {
    expect(existsSync(script(`../packages/core-runtime/src/${retired}.ts`))).toBe(false);
  }
});

it('no repaired module imports a retired authorization module', () => {
  const violations: string[] = [];
  for (const module of REPAIRED_MODULES) {
    const source = readFileSync(script(module), 'utf-8');
    for (const retired of RETIRED_MODULES) {
      if (source.includes(retired)) {
        violations.push(`${module} -> ${retired}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

it('the release gate is read-only and the deploy host runs it before publishing', () => {
  const host = readFileSync(script('zerops/app-host.mts'), 'utf-8');
  const gate = readFileSync(script('zerops/release-access-verification.mts'), 'utf-8');
  const verify = host.indexOf('yield* verifyReleaseAccessIntent(releaseSnapshot)');
  const publish = host.indexOf('yield* publishSnapshot(releaseSnapshot)');
  expect(verify).toBeGreaterThan(-1);
  expect(publish).toBeGreaterThan(verify);
  expect(gate).not.toContain('writeRelationships');
  expect(gate).not.toContain('.reconcile(');
});

/** The retired relationship builders the demo policy source used to export; nothing may import them again. */
const RETIRED_DEMO_BUILDERS = [
  'principalRelationships',
  'scopedDemoActionRelationships',
  'companyAdministratorWorkforceRelationships',
  'companyCoreModuleStructure',
  'roleRelationship',
  'demoPermissionRelationships',
  'commercePortalRelationships',
  'privacyConsentAuthorityRelationships',
  'marketRetirementRelationships',
  'crmIntakeRelationships',
  'tenantAdministratorCrmRelationships',
  'rentalPermissionRelationships',
  'companyPermissionRelationships',
  'reviewedHumanActionAddonRelationships',
] as const;

it('no script imports a retired demo relationship builder', () => {
  const violations: string[] = [];
  const walk = (directory: URL): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.output') {
        continue;
      }
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
      if (entry.isDirectory()) {
        walk(child);
      } else if (/\.(?:mts|ts|tsx)$/u.test(entry.name) && entry.name !== 'retired-authorization-imports.test.mts') {
        const source = readFileSync(child, 'utf-8');
        if (/demo\/permissions\.mts|\.\/permissions\.mts/u.test(source)) {
          for (const retired of RETIRED_DEMO_BUILDERS) {
            if (new RegExp(`\\b${retired}\\b`, 'u').test(source)) {
              violations.push(`${child.pathname} -> ${retired}`);
            }
          }
        }
      }
    }
  };
  walk(script('..'));
  expect(violations).toEqual([]);
});

it('keeps the retired demo grant helpers from writing a relationship by hand', () => {
  const helpers = [
    'demo/reconcile-stage-service-grants.mts',
    'demo/n1-stage-grants.mts',
    'demo/n1-release-grants.mts',
    'demo/retired-authorization.mts',
  ] as const;
  for (const helper of helpers) {
    const source = readFileSync(script(helper), 'utf-8');
    expect({ helper, writes: source.includes('writeRelationships(') }).toEqual({ helper, writes: false });
  }
});

it('does not ship the unused v1 stage tuple planners or their only consumers', () => {
  for (const path of [
    'demo/siampark-cases-stage.mts',
    'demo/orphan-agents-stage.mts',
    'demo/agent-policies-stage.mts',
    'demo/agent-policies-stage-model.mts',
  ]) {
    expect(existsSync(script(path))).toBe(false);
  }
});
