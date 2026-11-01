import { toModuleAccessObjectId, toSpiceDbActionObjectId } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';

import type { DemoAction } from '../demo/permissions.mts';
import { akrosStorefrontPrincipal, companyHumanAccounts } from '../demo/permissions.mts';
import {
  eshopMarketGrantRelationships,
  eshopMarketGrantSource,
  eshopMarketPermissionChecks,
  eshopMarketPlanFingerprint,
} from '../demo/eshop-markets-stage-grants.mts';
import { akrosDemoLegalEntityId, demoTenantId, eshopDemoLegalEntityId } from '../demo/fixture-ids.mts';

const marketModule = 'commerce.market-catalog';
const action = (actionKey: string, owningModuleKey: string): DemoAction => ({
  actionKey,
  legalEntityScope: 'required',
  owningModuleKey,
  provisioning: 'explicit',
});
const actions: readonly DemoAction[] = [
  action('commerce.market-catalog.create-market', marketModule),
  action('commerce.market-catalog.retire-market', marketModule),
  action('commerce.storefront-registry.register-storefront-application', 'commerce.storefront-registry'),
  action('demo.merchandise.apply-command', 'demo.merchandise'),
];
it('adds only the e-shop market slice: no identity, membership, or unrelated module edges', () => {
  const source = eshopMarketGrantSource(actions);
  const humans = new Set(
    companyHumanAccounts
      .filter(({ email }) => email.startsWith('eshop@') || email.startsWith('expedice@'))
      .map(({ principalId }) => principalId),
  );
  const humanEdges = source.filter((item) => humans.has(item.subjectId));
  expect(humanEdges.length).toBeGreaterThan(0);
  expect(humanEdges.some((item) => item.resourceType === 'tenant' || item.resourceType === 'legal_entity')).toBe(false);
  const merchandiseAkros = toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, 'demo.merchandise');
  expect(source.some((item) => item.resourceId === merchandiseAkros)).toBe(false);
  const merchandiseAction = toSpiceDbActionObjectId({
    actionKey: 'demo.merchandise.apply-command',
    legalEntityId: akrosDemoLegalEntityId,
    tenantId: demoTenantId,
  });
  expect(source.some((item) => item.resourceId === merchandiseAction)).toBe(false);
});

it('opens Market for the storefront and both companies, with containment for roots and storefronts', () => {
  const source = eshopMarketGrantSource(actions);
  const marketAkros = toModuleAccessObjectId(demoTenantId, akrosDemoLegalEntityId, marketModule);
  const marketKavarna = toModuleAccessObjectId(demoTenantId, eshopDemoLegalEntityId, marketModule);
  expect(source.some((item) => item.resourceId === marketAkros && item.relation === 'accessor_role')).toBe(true);
  expect(source.some((item) => item.resourceId === marketKavarna && item.relation === 'accessor_role')).toBe(true);
  expect(source.filter((item) => item.relation === 'module' && item.resourceType === 'resource')).toHaveLength(4);
  expect(source.some((item) => item.subjectId === akrosStorefrontPrincipal.principalId)).toBe(true);
});

it('fingerprints the exact deduplicated plan', () => {
  const desired = eshopMarketGrantRelationships(actions);
  expect(new Set(desired.map((item) => JSON.stringify(item))).size).toBe(desired.length);
  expect(eshopMarketPlanFingerprint(desired)).toMatch(/^[a-f0-9]{64}$/u);
  expect(eshopMarketPlanFingerprint(desired.slice(1))).not.toBe(eshopMarketPlanFingerprint(desired));
});

it('verifies allowed and denied company boundaries', () => {
  const checks = eshopMarketPermissionChecks();
  expect(checks.filter(({ expected }) => !expected).length).toBeGreaterThanOrEqual(4);
  expect(checks.every(({ principalId, resource }) => principalId.length > 0 && resource.objectId.length > 0)).toBe(
    true,
  );
});
