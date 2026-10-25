import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  bootstrapRelationshipRequest,
  bootstrapRelationshipsFromNative,
  companyMembershipAdmissionRelationships,
  scopedActionRoleBootstrapRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import {
  buildActionAuthorizationRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../packages/core-runtime/src/permissions/context-access.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { toSpiceDbActionObjectId } from '../../packages/core-runtime/src/permissions/service.ts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import {
  agentBotPrincipal,
  commercePortalRelationships,
  companyPermissionRelationships,
  crmIntakeRelationships,
  demoCompanyMemberships,
  demoHumanAccounts,
  demoPermissionRelationships,
  demoRoles,
  principalRelationships,
  privacyConsentAuthorityRelationships,
  rentalPermissionRelationships,
  scopedDemoActionRelationships,
} from './permissions.mts';
import type { DemoAction, DemoRelationship } from './permissions.mts';

const coreActions = coreActionCatalog.map((descriptor): DemoAction => {
  const { authorization } = descriptor.entrypoint;
  if (authorization.kind !== 'action_execution') {
    throw new Error('Core Action catalog must declare Action execution authorization');
  }
  return {
    actionKey: descriptor.actionKey,
    legalEntityScope: descriptor.legalEntityScope,
    owningModuleKey: descriptor.owningModuleKey,
    provisioning: authorization.provisioning,
  };
});
const relationshipSet = (rows: readonly DemoRelationship[]) =>
  new Set(bootstrapRelationshipRequest(rows).updates.map((row) => JSON.stringify(row)));
const isModuleStructure = ({ relation, resourceType }: DemoRelationship) =>
  resourceType === 'module_access' && relation === 'legal_entity';
const authority = (rows: readonly DemoRelationship[]) =>
  new Set(
    rows.filter((row) => row.resourceType !== 'action' && !isModuleStructure(row)).map((row) => JSON.stringify(row)),
  );
const companyIds = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
];

const identityModuleId = 'core.identity';
const coreModuleIds = [...new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey))];
const coreModuleStructure = companyIds.flatMap((legalEntityId) =>
  coreModuleIds.map((moduleId): DemoRelationship => ({
    relation: 'legal_entity',
    resourceId: toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) ?? '',
    resourceType: 'module_access',
    subjectId: toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '',
    subjectType: 'legal_entity',
  })),
);

// The bootstrap consumer accepts an omitted userset, but not protobuf's empty-string sentinel.
const SubjectSchema = Schema.Struct({
  subjectRelation: Schema.optionalKey(Schema.Trim.check(Schema.isNonEmpty())),
});

it.effect('omits empty native subject relations without changing bootstrap authorization', () =>
  Effect.gen(function* validatesBootstrapSubjects() {
    const [{ principalId }] = demoHumanAccounts;
    let directSubjects = 0;
    let usersets = 0;
    for (const action of coreActions) {
      const scope =
        action.legalEntityScope === 'forbidden'
          ? { tenantId: demoTenantId }
          : { legalEntityId: demoLegalEntityId, tenantId: demoTenantId };
      const roleKey = 'bootstrap-subject-regression';
      const native = scopedActionRoleBootstrapRelationships({ ...scope, action, roleKey });
      const relationships = scopedDemoActionRelationships(
        principalId,
        action,
        demoLegalEntityId,
        demoTenantId,
        roleKey,
      );
      // The demo adds its explicit role membership and, for tenant Actions, a context-role link.
      const projected = relationships.slice(action.legalEntityScope === 'forbidden' ? 2 : 1);
      yield* Schema.decodeUnknownEffect(Schema.Array(SubjectSchema))(relationships);
      expect(bootstrapRelationshipRequest(projected)).toEqual(bootstrapRelationshipRequest(native));
      for (const [index, row] of native.entries()) {
        if (row.subjectRelation === '') {
          directSubjects += 1;
          expect(projected[index]).not.toHaveProperty('subjectRelation');
        } else {
          usersets += 1;
          expect(projected[index]?.subjectRelation).toBe(row.subjectRelation);
        }
      }
    }
    expect(directSubjects).toBeGreaterThan(0);
    expect(usersets).toBeGreaterThan(0);
  }),
);

it.effect('installs the canonical Core Action structure in exactly the demo tenant and company scopes', () =>
  Effect.gen(function* validatesInstalledCoreTopology() {
    const moduleKeys = [...new Set(coreActions.map(({ owningModuleKey }) => owningModuleKey))];
    const installed = [
      { moduleKeys, tenantId: demoTenantId },
      ...companyIds.map((legalEntityId) => ({ legalEntityId, moduleKeys, tenantId: demoTenantId })),
    ];
    const expected = bootstrapRelationshipsFromNative(
      buildActionAuthorizationRelationships(deriveScopedActionAuthorization(coreActions, installed)),
    );
    const relationships = demoPermissionRelationships(coreActions);
    const structure = relationships.filter(({ resourceType }) => resourceType === 'action');
    expect(bootstrapRelationshipRequest(structure)).toEqual(bootstrapRelationshipRequest(expected));
    yield* Schema.decodeUnknownEffect(Schema.Array(SubjectSchema))(relationships);
    for (const row of structure) {
      expect(row).not.toHaveProperty('subjectRelation');
    }
    const action = coreActions.find(({ actionKey }) => actionKey === 'core.identity.configure-demo-companies');
    expect(action?.legalEntityScope).toBe('optional');
    expect(structure).toContainEqual({
      relation: 'tenant_scope',
      resourceId: toSpiceDbActionObjectId({
        actionKey: 'core.identity.configure-demo-companies',
        tenantId: demoTenantId,
      }),
      resourceType: 'action',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    });
  }),
);

it.effect('installs exactly the catalogued Core module structure without depending on discovered Actions', () =>
  Effect.gen(function* validatesCoreModuleTopology() {
    expect(coreModuleIds).toContain(identityModuleId);
    for (const actions of [[], coreActions]) {
      const structure = demoPermissionRelationships(actions).filter(isModuleStructure);
      const coreStructure = structure.filter(({ resourceId }) =>
        coreModuleStructure.some((expected) => expected.resourceId === resourceId),
      );
      expect(relationshipSet(coreStructure)).toEqual(relationshipSet(coreModuleStructure));
      yield* Schema.decodeUnknownEffect(Schema.Array(SubjectSchema))(coreStructure);
      for (const row of coreStructure) {
        expect(row).not.toHaveProperty('subjectRelation');
      }
    }
  }),
);

it('keeps Core identity admission on the existing company-admin role, not a new accessor grant', () => {
  const relationships = demoPermissionRelationships(coreActions);
  const legal = toLegalEntityAccessObjectId(demoTenantId, rentalDemoLegalEntityId) ?? '';
  const adminRole = toScopedRoleObjectId({
    legalEntityId: rentalDemoLegalEntityId,
    roleKey: 'admin',
    tenantId: demoTenantId,
  });
  const principalId = '72000000-0000-4000-8000-000000000021';
  expect(relationships).toContainEqual({
    relation: 'member',
    resourceId: adminRole,
    resourceType: 'scoped_role',
    subjectId: principalId,
    subjectType: 'principal',
  });
  expect(relationships).toContainEqual({
    relation: 'admin',
    resourceId: legal,
    resourceType: 'legal_entity',
    subjectId: adminRole,
    subjectRelation: 'member',
    subjectType: 'scoped_role',
  });
  expect(relationships).toContainEqual({
    relation: 'legal_entity',
    resourceId: toModuleAccessObjectId(demoTenantId, rentalDemoLegalEntityId, identityModuleId),
    resourceType: 'module_access',
    subjectId: legal,
    subjectType: 'legal_entity',
  });
  expect(
    relationships.filter(
      (row) =>
        row.resourceType === 'module_access' &&
        coreModuleStructure.some(({ resourceId }) => resourceId === row.resourceId) &&
        row.relation !== 'legal_entity',
    ),
  ).toEqual([]);
});

it('adds no memberships, capabilities, role grants or self-service authority with Core topology', () => {
  const relationships = demoPermissionRelationships(coreActions);
  // Compare against the unchanged role-policy producers, including their explicit Core grants.
  const existingPolicy = companyMembershipAdmissionRelationships(
    [
      ...demoHumanAccounts.flatMap((account) =>
        principalRelationships(account.principalId, demoRoles[account.role], coreActions),
      ),
      ...principalRelationships(agentBotPrincipal.principalId, demoRoles[agentBotPrincipal.role], coreActions),
      ...rentalPermissionRelationships(coreActions),
      ...companyPermissionRelationships(coreActions),
      ...commercePortalRelationships(coreActions),
      ...privacyConsentAuthorityRelationships(coreActions),
      ...crmIntakeRelationships(coreActions),
    ],
    demoCompanyMemberships.map(({ principalId }) => ({ principalId, tenantId: demoTenantId })),
  );
  expect(authority(relationships)).toEqual(authority(existingPolicy));
  expect(relationshipSet(relationships.filter(isModuleStructure))).toEqual(
    relationshipSet([...existingPolicy.filter(isModuleStructure), ...coreModuleStructure]),
  );
  expect(relationships.filter(({ relation }) => relation === 'executor' || relation === 'self_credentials')).toEqual(
    [],
  );
  expect(
    relationships
      .filter(({ resourceType }) => resourceType === 'action')
      .every(({ relation }) => ['tenant_scope', 'company_scope', 'grant'].includes(relation)),
  ).toBe(true);
});

it('does not install undiscovered Actions or infer Core ownership from an Action key prefix', () => {
  expect(demoPermissionRelationships([]).filter(({ resourceType }) => resourceType === 'action')).toEqual([]);
  const notInCatalog: DemoAction = {
    actionKey: 'core.identity.not-in-native-catalog',
    legalEntityScope: 'optional',
    owningModuleKey: identityModuleId,
    provisioning: 'explicit',
  };
  const unknownModule: DemoAction = {
    actionKey: 'core.unknown.not-in-native-catalog',
    legalEntityScope: 'required',
    owningModuleKey: 'core.unknown',
    provisioning: 'explicit',
  };
  expect(demoPermissionRelationships([...coreActions, notInCatalog, unknownModule])).toEqual(
    demoPermissionRelationships(coreActions),
  );
});
