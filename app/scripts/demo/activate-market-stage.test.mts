import type { NodeServices } from '@effect/platform-node';
import type { Layer } from 'effect';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  marketActivationPlanFingerprint,
  marketActivationScopeAllowed,
  ReviewedMarketActivationPlanSchema,
} from './activate-market-stage.mts';
import type { StageMarketOperatorLive } from './activate-market-stage.mts';
import { demoTenantId } from './fixture-ids.mts';

const plan = {
  actionKey: 'core.modules.change-tenant-module-state',
  compositionRevision: 'a'.repeat(64),
  moduleKey: 'commerce.market-catalog',
  operatorPrincipalId: '72000000-0000-4000-8000-000000000021',
  tenantId: demoTenantId,
};
const validPlan = Schema.is(ReviewedMarketActivationPlanSchema);

it('accepts only tenant-only session scope in the approved demo tenant', () => {
  expect(marketActivationScopeAllowed(demoTenantId, 'session')).toBe(true);
  for (const method of ['api_key', 'system', 'oauth_connection', 'support_impersonation']) {
    expect(marketActivationScopeAllowed(demoTenantId, method)).toBe(false);
  }
  expect(marketActivationScopeAllowed(demoTenantId, 'session', '71000000-0000-4000-8000-000000000024')).toBe(false);
  expect(marketActivationScopeAllowed('70000000-0000-4000-8000-000000000010', 'session')).toBe(false);
});

it('the reviewed plan names only Market, its genuine Core activation Action, and the exact demo tenant', () => {
  expect(validPlan(plan)).toBe(true);
  expect(validPlan({ ...plan, moduleKey: 'privacy.core' })).toBe(false);
  expect(validPlan({ ...plan, actionKey: 'commerce.market-catalog.retire-market' })).toBe(false);
  expect(validPlan({ ...plan, tenantId: '70000000-0000-4000-8000-000000000010' })).toBe(false);
  expect(validPlan({ ...plan, operatorPrincipalId: 'not-a-principal' })).toBe(false);
  expect(validPlan({ ...plan, compositionRevision: '' })).toBe(false);
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
