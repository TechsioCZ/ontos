import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { demoTenantId } from './fixture-ids.mts';
import { AKROS_PLAYGROUND_TENANT_ID, symmyAkrosModuleKeys } from './stage-tenant-modules.mts';
import {
  SymmyAkrosActivationPlanSchema,
  symmyAkrosActivationIdempotencyKey,
  symmyAkrosActivationSteps,
  symmyAkrosOperatorRefusals,
} from './symmy-akros-activate.mts';

const session = { authMethod: 'session', tenantId: AKROS_PLAYGROUND_TENANT_ID };
const plan = {
  actionKey: 'core.modules.change-tenant-module-state',
  compositionRevision: 'a'.repeat(64),
  moduleKeys: [...symmyAkrosModuleKeys],
  operatorPrincipalId: '72000000-0000-4000-8000-000000000021',
  tenantId: AKROS_PLAYGROUND_TENANT_ID,
};
const validPlan = Schema.is(SymmyAkrosActivationPlanSchema);
const pricing = 'commerce.pricing';
const active = 'active';
const owners = symmyAkrosModuleKeys.filter((key) => key !== 'integration.symmy');

it('accepts only a tenant-only session of the AKROS playground Tenant', () => {
  expect(symmyAkrosOperatorRefusals(session)).toEqual([]);
  expect(
    symmyAkrosOperatorRefusals({ ...session, legalEntityId: 'c0c78a3e-6e2a-57e0-9d0d-86253499fee7' }),
  ).toHaveLength(1);
  expect(symmyAkrosOperatorRefusals({ ...session, authMethod: 'api_key' })).toHaveLength(1);
  // Another Tenant is refused, and its stage scope approves none of the Symmy owners either.
  const demo = symmyAkrosOperatorRefusals({ ...session, tenantId: demoTenantId });
  expect(demo[0]).toBe('The operator is not signed in to the AKROS playground Tenant');
  expect(demo).toContain('stageActivationScopes does not approve integration.symmy for this Tenant');
});

it('the reviewed plan names the Core activation Action, the AKROS Tenant and only Symmy modules', () => {
  expect(validPlan(plan)).toBe(true);
  expect(validPlan({ ...plan, tenantId: demoTenantId })).toBe(false);
  expect(validPlan({ ...plan, moduleKeys: [...owners, 'commerce.tax'] })).toBe(false);
  expect(validPlan({ ...plan, moduleKeys: [...owners, 'commerce.assortment'] })).toBe(false);
  expect(validPlan({ ...plan, actionKey: 'integration.symmy.admit-symmy-job' })).toBe(false);
  expect(validPlan({ ...plan, compositionRevision: '' })).toBe(false);
  expect(validPlan({ ...plan, operatorPrincipalId: 'not-a-principal' })).toBe(false);
});

it('activates what is inactive or missing, owners before Symmy, and leaves an active module alone', () => {
  expect(symmyAkrosActivationSteps([])).toEqual(Result.succeed({ activate: symmyAkrosModuleKeys, alreadyActive: [] }));
  const partial = symmyAkrosActivationSteps([
    { moduleKey: pricing, state: active },
    { moduleKey: 'privacy.core', state: 'inactive' },
    // Tax and other modules of the Tenant are not this plan's and never change it.
    { moduleKey: 'commerce.tax', state: 'suspended' },
  ]);
  expect(partial).toEqual(
    Result.succeed({
      activate: symmyAkrosModuleKeys.filter((key) => key !== pricing),
      alreadyActive: [pricing],
    }),
  );
  const converged = symmyAkrosActivationSteps(symmyAkrosModuleKeys.map((moduleKey) => ({ moduleKey, state: active })));
  expect(converged).toEqual(Result.succeed({ activate: [], alreadyActive: symmyAkrosModuleKeys }));
});

it('never replaces a state a person set, and refuses contradictory evidence', () => {
  const refused = symmyAkrosActivationSteps([
    { moduleKey: 'integration.symmy', state: 'suspended' },
    { moduleKey: 'party.registry', state: active },
    { moduleKey: 'party.registry', state: 'inactive' },
  ]);
  expect(refused).toEqual(
    Result.fail([
      'party.registry has contradictory state rows',
      'integration.symmy is suspended, a state a person set; this activation never replaces it',
    ]),
  );
});

it('applying the same reviewed plan again reuses one idempotency key per module', () => {
  const fingerprint = 'b'.repeat(64);
  const keys = symmyAkrosModuleKeys.map((key) => symmyAkrosActivationIdempotencyKey(fingerprint, key));
  expect(new Set(keys).size).toBe(symmyAkrosModuleKeys.length);
  expect(keys[0]).toBe(`symmy-akros-activation:${fingerprint}:commerce.catalog`);
  expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(200);
});
