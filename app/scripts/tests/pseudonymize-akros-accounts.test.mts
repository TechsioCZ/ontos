import { v1 } from '@authzed/authzed-node';
import { Array as Arr, Effect, Exit, Option, Order } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  fromScopedRoleObjectId,
  toScopedRoleObjectId,
} from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { eshopPersonaEmails } from '../demo/eshop-markets-stage-grants.mts';
import { akrosDemoLegalEntityId, demoId, demoTenantId } from '../demo/fixture-ids.mts';
import {
  companyHumanAccounts,
  demoPrincipalRoleKey,
  eshopDemoRoles,
  principalRelationships,
} from '../demo/permissions.mts';
import {
  accountPlanFingerprint,
  agentOperatorsAfterCreate,
  agentOperatorsAfterRetire,
  isAgentOperatorEdge,
  isPseudonymSource,
  pseudonymAccountIdentity,
  pseudonymAgent,
  pseudonymRoleId,
  remapAccountRelationships,
  sameAccounts,
  scopedRoleAssignments,
  validatePseudonymAccountPlan,
} from '../demo/pseudonymize-akros-accounts-policy.mts';
import { pseudonymEmployee } from '../demo/pseudonymize-akros-accounts-workforce.mts';

const principalNamespace = 'core.principal';
const oldEshopEmail = 'eshop@akros.demo';
const oldAdminName = 'Správce e-shopu AKROS';
const newEshopEmail = 'eshop@sroubarna.demo';
const adminRoleKey = 'eshop-administration';
const superadminEmail = 'obchod@demo.ontos';
const marketRoot = 'market-root';
const brandedAdministrator = 'AKROS administrator';
const old = demoId(principalNamespace, 'akros-eshop');
const identity = pseudonymAccountIdentity(oldEshopEmail, oldAdminName);
const membership = {
  affiliation: 'employee' as const,
  legalEntityId: akrosDemoLegalEntityId,
  revision: 1,
  status: 'active' as const,
};
const account = {
  ...identity,
  memberships: [membership],
  oldDisplayName: oldAdminName,
  oldEmail: oldEshopEmail,
  oldPrincipalId: old,
  relationships: [],
  roles: [],
};
const plan = {
  accounts: [account],
  agents: [],
  employees: [],
  operatorPrincipalId: demoId(principalNamespace, 'obchod'),
  schemaVersion: 2 as const,
  tenantId: demoTenantId,
};
const companyRole = toScopedRoleObjectId({
  legalEntityId: akrosDemoLegalEntityId,
  roleKey: adminRoleKey,
  tenantId: demoTenantId,
});
const tenantRole = toScopedRoleObjectId({ roleKey: 'tenant-reader', tenantId: demoTenantId });
const edge = (objectType: string, objectId: string, relation: string, subjectId = old) =>
  v1.Relationship.create({
    relation,
    resource: { objectId, objectType },
    subject: { object: { objectId: subjectId, objectType: 'principal' }, optionalRelation: '' },
  });

it('maps administrator, fulfilment, warm-up and arbitrary synthetic accounts without changing their local part', () => {
  expect(identity.email).toBe(newEshopEmail);
  expect(identity.displayName).toBe('Správce e-shopu ŠroubShop');
  expect(identity.newPrincipalId).toBe(demoId(principalNamespace, 'sroubarna-eshop'));
  expect(identity.newPrincipalId).not.toBe(old);
  expect(pseudonymAccountIdentity('expedice@akros.demo', 'Expedice AKROS')).toMatchObject({
    displayName: 'Expedice ŠroubShop',
    newPrincipalId: demoId(principalNamespace, 'sroubarna-expedice'),
  });
  expect(pseudonymAccountIdentity('warmup@akros.demo', 'Stage warm-up (read only) · akros')).toMatchObject({
    displayName: 'Stage warm-up (read only) · sroubarna',
    email: 'warmup@sroubarna.demo',
    newAuthBindingId: demoId('core.auth-binding', 'warmup-sroubarna'),
    newPrincipalId: demoId(principalNamespace, 'warmup-sroubarna'),
  });
  for (const local of ['qa-test', 'x']) {
    expect(pseudonymAccountIdentity(`${local}@akros.demo`, 'Test AKROS').email).toBe(`${local}@sroubarna.demo`);
  }
});

it('excludes the overarching superadmin and every separate AKROS playground login', () => {
  expect(isPseudonymSource(superadminEmail, brandedAdministrator)).toBe(false);
  expect(isPseudonymSource('eshop@akros.playground', brandedAdministrator)).toBe(false);
  expect(isPseudonymSource('other@example.test', brandedAdministrator)).toBe(true);
  expect(isPseudonymSource('eshop@kavarna.demo', 'Tereza Malá')).toBe(false);
});

it('fails closed on ambiguous mappings, branded or foreign targets and empty inventory', () => {
  expect(validatePseudonymAccountPlan(plan)).toBe(true);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [account, account] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [{ ...account, displayName: 'AKROS' }] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [{ ...account, displayName: 'Někdo jiný' }] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [{ ...account, memberships: [] }] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [{ ...account, newPrincipalId: old }] })).toBe(false);
  expect(validatePseudonymAccountPlan({ ...plan, accounts: [{ ...account, oldEmail: superadminEmail }] })).toBe(false);
  expect(accountPlanFingerprint('reviewed')).toBe(accountPlanFingerprint('reviewed'));
  expect(accountPlanFingerprint('changed')).not.toBe(accountPlanFingerprint('reviewed'));
});

it('detects any drift between the reviewed plan and the live source', () => {
  expect(sameAccounts([account], [{ ...account, memberships: [membership] }])).toBe(true);
  expect(sameAccounts([account], [{ ...account, memberships: [{ ...membership, revision: 2 }] }])).toBe(false);
  expect(sameAccounts([account], [{ ...account, relationships: ['extra'] }])).toBe(false);
});

it.effect('copies direct resource grants and scoped-role membership, remapping only identity structure', () =>
  Effect.gen(function* copyExactPolicy() {
    const source = [
      edge('resource', marketRoot, 'writer'),
      edge('principal', old, 'self'),
      edge('scoped_role', companyRole, 'member'),
    ];
    const result = yield* remapAccountRelationships(source, old, identity.newPrincipalId);
    expect(result[0]?.resource).toEqual(source[0]?.resource);
    expect(result[0]?.relation).toBe('writer');
    expect(result[0]?.subject?.object?.objectId).toBe(identity.newPrincipalId);
    expect(result[1]?.resource?.objectId).toBe(identity.newPrincipalId);
    expect(result[2]?.resource).toEqual(source[2]?.resource);
    expect(source[0]?.subject?.object?.objectId).toBe(old);
  }),
);

it.effect('refuses conditional, expiring and foreign subject grants rather than broadening authority', () =>
  Effect.gen(function* conditionalPolicy() {
    const valid = edge('resource', marketRoot, 'reader');
    for (const candidate of [
      v1.Relationship.create({ ...valid, optionalCaveat: { caveatName: 'condition' } }),
      v1.Relationship.create({ ...valid, optionalExpiresAt: { nanos: 0, seconds: '100' } }),
      edge('resource', marketRoot, 'reader', 'foreign'),
    ]) {
      const exit = yield* Effect.exit(remapAccountRelationships([candidate], old, identity.newPrincipalId));
      expect(Exit.isFailure(exit)).toBe(true);
    }
  }),
);

it.effect('lists every role assignment once, in tenant and company scope, for revocation', () =>
  Effect.gen(function* roleAssignments() {
    const roles = yield* scopedRoleAssignments([
      edge('scoped_role', companyRole, 'member'),
      edge('scoped_role', companyRole, 'member'),
      edge('scoped_role', tenantRole, 'member'),
      edge('resource', marketRoot, 'writer'),
    ]);
    expect(roles).toHaveLength(2);
    expect(roles).toContainEqual({
      legalEntityId: akrosDemoLegalEntityId,
      roleKey: adminRoleKey,
      tenantId: demoTenantId,
    });
    expect(roles).toContainEqual({ roleKey: 'tenant-reader', tenantId: demoTenantId });
    const foreign = toScopedRoleObjectId({ roleKey: 'reader', tenantId: demoId('tenant', 'other') });
    const exit = yield* Effect.exit(scopedRoleAssignments([edge('scoped_role', foreign, 'member')]));
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it('renames the warm-up scoped role while preserving its exact company scope', () => {
  const oldRole = toScopedRoleObjectId({
    legalEntityId: akrosDemoLegalEntityId,
    roleKey: 'warmup-akros-reader',
    tenantId: demoTenantId,
  });
  const mapped = fromScopedRoleObjectId(pseudonymRoleId(oldRole));
  expect(Option.isSome(mapped) && mapped.value).toEqual({
    legalEntityId: akrosDemoLegalEntityId,
    roleKey: 'warmup-sroubarna-reader',
    tenantId: demoTenantId,
  });
  expect(pseudonymRoleId(companyRole)).toBe(companyRole);
});

it('renames workforce employees in place and relinks them to the migrated login', () => {
  const employee = {
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    department: 'E-shop',
    email: oldEshopEmail,
    fullName: oldAdminName,
    id: demoId('workforce.employee', 'akros-eshop'),
    principalRef: { principalId: old, tenantId: demoTenantId },
    role: 'SUPPORT',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as const;
  expect(pseudonymEmployee(employee, [account])).toEqual({
    email: newEshopEmail,
    fullName: 'Správce e-shopu ŠroubShop',
    id: employee.id,
    newPrincipalId: Option.some(identity.newPrincipalId),
    oldEmail: oldEshopEmail,
    oldFullName: oldAdminName,
    oldPrincipalId: Option.some(old),
  });
  const { principalRef: _unlinked, ...unlinked } = employee;
  expect(pseudonymEmployee({ ...unlinked, email: 'sklad@akros.demo' }, [account]).newPrincipalId).toEqual(
    Option.none(),
  );
});

it('fresh seeds produce the pseudonymous accounts with the same role keys and market/storefront policy', () => {
  const admin = companyHumanAccounts.find(({ email }) => email === newEshopEmail);
  const fulfilment = companyHumanAccounts.find(({ email }) => email === 'expedice@sroubarna.demo');
  expect(companyHumanAccounts.some(({ email }) => email.endsWith('@akros.demo'))).toBe(false);
  expect(admin?.principalId).toBe(identity.newPrincipalId);
  expect(admin?.role).toBe('akrosAdmin');
  expect(fulfilment?.role).toBe('fulfilment');
  expect(demoPrincipalRoleKey(identity.newPrincipalId)).toBe(adminRoleKey);
  expect(eshopPersonaEmails).toContain(newEshopEmail);
  expect(eshopPersonaEmails).toContain('expedice@sroubarna.demo');
  expect(eshopDemoRoles.akrosAdmin.modules).toMatchObject({
    'commerce.market-catalog': 'write',
    'commerce.storefront-registry': 'write',
  });
  expect(
    principalRelationships(identity.newPrincipalId, eshopDemoRoles.akrosAdmin, [], akrosDemoLegalEntityId).length,
  ).toBeGreaterThan(0);
});

const agentId = demoId(principalNamespace, 'agent-eshop-assistant');
const colleague = demoId(principalNamespace, 'kolega');
const directoryAgent = {
  description: 'Odpovídá na dotazy k produktům.',
  displayName: 'Asistent e-shopu',
  hasProfile: true,
  modules: [],
  operatorCommand: { desiredOperatorPrincipalIds: [old, colleague], revision: 3 },
  operatorPrincipalIds: [old, colleague],
  ownerPrincipalId: old,
  principalId: agentId,
  status: 'active' as const,
  writePolicy: 'read_only' as const,
};

it('moves an agent owned and operated by a migrated login, keeping every other operator and the profile', () => {
  const moved = pseudonymAgent(directoryAgent, akrosDemoLegalEntityId, [account]);
  expect(Option.isSome(moved)).toBe(true);
  if (Option.isSome(moved)) {
    expect(moved.value).toMatchObject({
      agentPrincipalId: agentId,
      description: directoryAgent.description,
      newOwnerPrincipalId: Option.some(identity.newPrincipalId),
      oldOwnerPrincipalId: Option.some(old),
      operatorRevision: 3,
      writePolicy: 'read_only',
    });
    // Phase A: both logins operate the agent; phase B: only the new one, colleague untouched.
    expect(agentOperatorsAfterCreate(moved.value, [account])).toEqual(
      Arr.sort([old, colleague, identity.newPrincipalId], Order.String),
    );
    expect(agentOperatorsAfterRetire(moved.value, [account])).toEqual(
      Arr.sort([colleague, identity.newPrincipalId], Order.String),
    );
    expect(validatePseudonymAccountPlan({ ...plan, agents: [moved.value] })).toBe(true);
    expect(validatePseudonymAccountPlan({ ...plan, agents: [moved.value, moved.value] })).toBe(false);
    expect(
      validatePseudonymAccountPlan({ ...plan, agents: [{ ...moved.value, newOwnerPrincipalId: Option.some(old) }] }),
    ).toBe(false);
  }
});

it('leaves agents of unrelated people alone and treats an unowned agent as owner-neutral', () => {
  const unrelated = {
    ...directoryAgent,
    operatorCommand: null,
    operatorPrincipalIds: [colleague],
    ownerPrincipalId: colleague,
  };
  expect(Option.isNone(pseudonymAgent(unrelated, akrosDemoLegalEntityId, [account]))).toBe(true);
  const unowned = pseudonymAgent({ ...directoryAgent, ownerPrincipalId: null }, akrosDemoLegalEntityId, [account]);
  expect(Option.isSome(unowned) && Option.isNone(unowned.value.newOwnerPrincipalId)).toBe(true);
});

it('never copies agent operator edges; the governed operator command owns them', () => {
  expect(isAgentOperatorEdge(edge('principal', agentId, 'operator'), old)).toBe(true);
  expect(isAgentOperatorEdge(edge('principal', old, 'self'), old)).toBe(false);
  expect(isAgentOperatorEdge(edge('resource', marketRoot, 'writer'), old)).toBe(false);
});
