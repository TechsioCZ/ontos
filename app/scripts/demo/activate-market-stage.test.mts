import type { NodeServices } from '@effect/platform-node';
import type { Layer } from 'effect';
import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  activationSellingEvidence,
  AKROS_PLAYGROUND_TENANT_ID,
  marketActivationPlanFingerprint,
  marketActivationScopeAllowed,
  ReviewedMarketActivationPlanSchema,
} from './activate-market-stage.mts';
import type { StageMarketOperatorLive } from './activate-market-stage.mts';
import { demoTenantId } from './fixture-ids.mts';
import { N1_TENANT_ID } from './n1-stage-grants.mts';

const market = 'commerce.market-catalog';
const merchandise = 'demo.merchandise';
const billing = 'finance.billing';
const storefrontRegistry = 'commerce.storefront-registry';
const session = 'session';
const akrosCompanyId = '71000000-0000-4000-8000-000000000024';
const plan = {
  actionKey: 'core.modules.change-tenant-module-state',
  compositionRevision: 'a'.repeat(64),
  moduleKey: market,
  operatorPrincipalId: '72000000-0000-4000-8000-000000000021',
  sellingModules: [],
  tenantId: demoTenantId,
};
const validPlan = Schema.is(ReviewedMarketActivationPlanSchema);
const tasks = 'work.tasks';
const tax = 'commerce.tax';
const localDevelopmentTenantId = '70000000-0000-4000-8000-000000000010';
const verificationTenantId = '70000000-0000-4000-8000-000000000090';

it('accepts only a tenant-only session in a Tenant allowed the module', () => {
  expect(marketActivationScopeAllowed(demoTenantId, market, session)).toBe(true);
  for (const method of ['api_key', 'system', 'oauth_connection', 'support_impersonation']) {
    expect(marketActivationScopeAllowed(demoTenantId, market, method)).toBe(false);
  }
  expect(marketActivationScopeAllowed(demoTenantId, market, session, akrosCompanyId)).toBe(false);
  expect(marketActivationScopeAllowed(localDevelopmentTenantId, market, session)).toBe(false);
  // N1 may activate Tasks for its storefront inquiries, and nothing else; the demo tenant may not take Tasks here.
  expect(marketActivationScopeAllowed(N1_TENANT_ID, tasks, session)).toBe(true);
  expect(marketActivationScopeAllowed(N1_TENANT_ID, 'projects.core', session)).toBe(false);
  expect(marketActivationScopeAllowed(demoTenantId, tasks, session)).toBe(false);
});

it('the reviewed plan names only an allowed module, its Core activation Action, and an allowed Tenant', () => {
  expect(validPlan(plan)).toBe(true);
  expect(validPlan({ ...plan, moduleKey: storefrontRegistry })).toBe(true);
  expect(validPlan({ ...plan, moduleKey: 'projects.core' })).toBe(true);
  expect(validPlan({ ...plan, moduleKey: 'commerce.assortment' })).toBe(false);
  expect(validPlan({ ...plan, moduleKey: 'privacy.core' })).toBe(false);
  expect(validPlan({ ...plan, actionKey: 'commerce.market-catalog.retire-market' })).toBe(false);
  expect(validPlan({ ...plan, moduleKey: tasks, tenantId: N1_TENANT_ID })).toBe(true);
  expect(validPlan({ ...plan, tenantId: localDevelopmentTenantId })).toBe(false);
  expect(validPlan({ ...plan, operatorPrincipalId: 'not-a-principal' })).toBe(false);
  expect(validPlan({ ...plan, compositionRevision: '' })).toBe(false);
  const { sellingModules: _omitted, ...withoutSellingModules } = plan;
  expect(validPlan(withoutSellingModules)).toBe(false);
  expect(validPlan({ ...plan, sellingModules: [tasks] })).toBe(false);
});

it('commerce.tax may be installed in exactly the three stage Tenants that sell or invoice', () => {
  for (const tenantId of [demoTenantId, N1_TENANT_ID, AKROS_PLAYGROUND_TENANT_ID]) {
    expect(marketActivationScopeAllowed(tenantId, tax, session)).toBe(true);
    expect(marketActivationScopeAllowed(tenantId, tax, 'api_key')).toBe(false);
    expect(validPlan({ ...plan, moduleKey: tax, sellingModules: [merchandise], tenantId })).toBe(true);
  }
  // Company-scoped sessions never install tenant-wide, even for tax.
  expect(marketActivationScopeAllowed(demoTenantId, tax, session, akrosCompanyId)).toBe(false);
  for (const tenantId of [localDevelopmentTenantId, verificationTenantId]) {
    expect(marketActivationScopeAllowed(tenantId, tax, session)).toBe(false);
    expect(validPlan({ ...plan, moduleKey: tax, sellingModules: [billing], tenantId })).toBe(false);
  }
  // The playground gets tax only; N1 gets tax and Tasks only.
  expect(marketActivationScopeAllowed(AKROS_PLAYGROUND_TENANT_ID, market, session)).toBe(false);
  expect(marketActivationScopeAllowed(N1_TENANT_ID, storefrontRegistry, session)).toBe(false);
});

it('installs tax only where the Tenant already sells or invoices, and records that evidence in the plan', () => {
  expect(activationSellingEvidence(tax, [merchandise, tasks])).toEqual(Result.succeed([merchandise]));
  expect(activationSellingEvidence(tax, [billing, 'demo.merchandise'])).toEqual(Result.succeed([merchandise, billing]));
  const refused = activationSellingEvidence(tax, [tasks]);
  expect(Result.isFailure(refused)).toBe(true);
  expect(Result.isFailure(refused) ? refused.failure : '').toContain('demo.merchandise nor finance.billing');
  // Other modules carry no selling prerequisite.
  expect(activationSellingEvidence(tasks, [])).toEqual(Result.succeed([]));
  const text = JSON.stringify({ ...plan, moduleKey: tax, sellingModules: [merchandise] });
  expect(
    marketActivationPlanFingerprint(
      JSON.stringify({ ...plan, moduleKey: tax, sellingModules: [merchandise, billing] }),
    ),
  ).not.toBe(marketActivationPlanFingerprint(text));
});

it('binds the reviewed fingerprint to the exact operator and approved composition', () => {
  const text = JSON.stringify(plan);
  const fingerprint = marketActivationPlanFingerprint(text);
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(marketActivationPlanFingerprint(text)).toBe(fingerprint);
  expect(marketActivationPlanFingerprint(JSON.stringify({ ...plan, compositionRevision: 'b'.repeat(64) }))).not.toBe(
    fingerprint,
  );
  expect(
    marketActivationPlanFingerprint(
      JSON.stringify({ ...plan, operatorPrincipalId: '72000000-0000-4000-8000-000000000022' }),
    ),
  ).not.toBe(fingerprint);
});

type UnprovidedServices = Exclude<
  Layer.Services<typeof StageMarketOperatorLive>,
  Layer.Success<typeof NodeServices.layer>
>;
const servicesAreComplete: [UnprovidedServices] extends [never] ? true : false = true;
it('the native operator composition supplies the Core activation Action requirements', () => {
  expect(servicesAreComplete).toBe(true);
});
