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
const authority = (rows: readonly DemoRelationship[]) =>
  new Set(rows.filter(({ resourceType }) => resourceType !== 'action').map((row) => JSON.stringify(row)));
const companyIds = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
];

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

it('adds no memberships, capabilities, role grants or self-service authority with Core Action topology', () => {
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
    owningModuleKey: 'core.identity',
    provisioning: 'explicit',
  };
  expect(demoPermissionRelationships([...coreActions, notInCatalog])).toEqual(demoPermissionRelationships(coreActions));
});
