import { ownerResourceModuleContainment, toLegalEntityAccessObjectId, toModuleAccessObjectId } from '@app/core-runtime';
import { v1 } from '@authzed/authzed-node';
import { Array as EffectArray, Order, Schema } from 'effect';

import {
  bootstrapRelationshipsFromNative,
  companyMembershipAdmissionRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import {
  buildActionAuthorizationRelationships,
  deriveScopedActionAuthorization,
} from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { coreActionCatalog } from '../../packages/core-runtime/src/modules/actions/catalog.ts';
import { demoId } from './fixture-ids.mts';
import type { CommercePortalWorkload, DemoAction, DemoRelationship, DemoRole } from './permissions.mts';
import {
  commercePortalPrincipal,
  commercePortalRelationships,
  commercePortalRole,
  eshopDemoRoles,
  principalRelationships,
} from './permissions.mts';

const playgroundKey = 'akros-playground';
const principalResource = 'core.principal';
const marketModule = 'commerce.market-catalog';
const registryModule = 'commerce.storefront-registry';
export const akrosPlaygroundTenantId = demoId('tenant', playgroundKey);
export const akrosPlaygroundLegalEntityId = demoId('legal-entity', playgroundKey);
const account = (name: string, displayName: string, roleKey: string, role: DemoRole) => ({
  authBindingId: demoId('core.auth-binding', `akros-playground-${name}`),
  displayName,
  email: `${name}@akros.playground`,
  principalId: demoId(principalResource, `akros-playground-${name}`),
  role,
  roleKey,
});

/** Independent identities, never aliases or additional bindings of demo principals. */
export const akrosPlaygroundAccounts = [
  account('admin', 'Správce AKROS', 'administration', {
    ...eshopDemoRoles.akrosAdmin,
    // Tenant read_all admits every company, including future ones. This account administers only AKROS.
    label: 'Správce firmy AKROS',
  }),
  account('eshop', 'Správce e-shopu AKROS', 'eshop-administration', eshopDemoRoles.akrosAdmin),
  account('expedice', 'Expedice AKROS', 'fulfilment', eshopDemoRoles.fulfilment),
] as const;

/**
 * AKROS's own Commerce portal workload: customer self-enrollment for this Tenant reserves and activates bindings, and
 * runs the Party, Privacy and Commerce owner Actions, as this Principal. Its key is the AKROS entry of
 * `COMMERCE_TENANT_CREDENTIALS`; the Shell and Commerce verification grants name it for this Tenant only.
 */
export const akrosPlaygroundCommercePortal: CommercePortalWorkload = {
  apiKeyName: 'akros-playground-commerce-portal',
  displayName: commercePortalPrincipal.displayName,
  legalEntityId: akrosPlaygroundLegalEntityId,
  principalId: demoId(principalResource, 'akros-playground-commerce-portal'),
  roleKey: 'commerce-portal',
  tenantId: akrosPlaygroundTenantId,
};

export const akrosPlaygroundServices = [
  {
    displayName: 'akros-playground-storefront',
    principalId: demoId(principalResource, 'akros-playground-storefront'),
    role: eshopDemoRoles.akrosStorefront,
    roleKey: 'storefront',
  },
  {
    displayName: 'akros-playground-market-authority',
    principalId: demoId(principalResource, 'akros-playground-market-authority'),
    role: {
      actionKeys: { 'commerce.customer-context': ['commerce.customer-context.reserve-market-retirement'] },
      contextPermissions: { 'commerce.customer-context': ['market.catalog.read'] },
      label: 'Market authority',
      modules: {
        'commerce.customer-context': 'read',
        [marketModule]: 'read',
        [registryModule]: 'read',
      },
      restrictedModules: ['commerce.customer-context'],
    } satisfies DemoRole,
    roleKey: 'market-authority',
  },
  {
    displayName: akrosPlaygroundCommercePortal.apiKeyName,
    principalId: akrosPlaygroundCommercePortal.principalId,
    role: commercePortalRole,
    roleKey: akrosPlaygroundCommercePortal.roleKey,
  },
] as const;

export const akrosPlaygroundModules = EffectArray.sort(
  [...new Set(akrosPlaygroundAccounts.flatMap(({ role }) => Object.keys(role.modules)))],
  Order.String,
);
const coreModuleKeys = [...new Set(coreActionCatalog.map(({ owningModuleKey }) => owningModuleKey))];

export const akrosPlaygroundDefinition = {
  accounts: akrosPlaygroundAccounts.map(({ role: _role, ...identity }) => identity),
  defaultLocale: 'cs',
  displayName: 'AKROS',
  legalEntityId: akrosPlaygroundLegalEntityId,
  legalName: 'AKROS',
  modules: akrosPlaygroundModules,
  registrationCountry: 'CZ',
  registrationNumber: 'PLAYGROUND-AKROS',
  services: akrosPlaygroundServices.map(({ role: _role, ...identity }) => identity),
  slug: playgroundKey,
  tenantId: akrosPlaygroundTenantId,
};

const PrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
const AuthBindingIdSchema = Schema.String.pipe(Schema.brand('AuthBindingId'));
const RoleKeySchema = Schema.String.pipe(Schema.brand('RoleKey'));
const LegalEntityIdSchema = Schema.String.pipe(Schema.brand('LegalEntityId'));
const TenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
const identityFields = {
  displayName: Schema.String,
  principalId: Schema.toEncoded(PrincipalIdSchema),
  roleKey: Schema.toEncoded(RoleKeySchema),
};
export const AkrosPlaygroundDefinitionSchema = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({
      ...identityFields,
      authBindingId: Schema.toEncoded(AuthBindingIdSchema),
      email: Schema.String,
    }),
  ),
  defaultLocale: Schema.String,
  displayName: Schema.String,
  legalEntityId: Schema.toEncoded(LegalEntityIdSchema),
  legalName: Schema.String,
  modules: Schema.Array(Schema.String),
  registrationCountry: Schema.String,
  registrationNumber: Schema.String,
  services: Schema.Array(Schema.Struct(identityFields)),
  slug: Schema.String,
  tenantId: Schema.toEncoded(TenantIdSchema),
});

export const akrosPlaygroundRelationships = (actions: readonly DemoAction[]): readonly v1.Relationship[] => {
  const moduleKeys = [...coreModuleKeys, ...akrosPlaygroundModules];
  const scopes = [
    { moduleKeys, tenantId: akrosPlaygroundTenantId },
    { legalEntityId: akrosPlaygroundLegalEntityId, moduleKeys, tenantId: akrosPlaygroundTenantId },
  ];
  const topology = bootstrapRelationshipsFromNative(
    buildActionAuthorizationRelationships(deriveScopedActionAuthorization(actions, scopes)),
  );
  const subjects = [...akrosPlaygroundAccounts, ...akrosPlaygroundServices];
  const policy = [
    ...subjects.flatMap(({ principalId, role, roleKey }) =>
      principalRelationships(
        principalId,
        role,
        actions,
        akrosPlaygroundLegalEntityId,
        akrosPlaygroundTenantId,
        roleKey,
      ),
    ),
    ...commercePortalRelationships(actions, akrosPlaygroundCommercePortal),
  ];
  const resources = [
    {
      moduleId: marketModule,
      resourceId: akrosPlaygroundLegalEntityId,
      resourceType: 'commerce.market-catalog.market-catalog-root',
    },
    {
      moduleId: registryModule,
      resourceId: 'akros-storefront',
      resourceType: 'commerce.storefront-registry.storefront-application',
    },
  ].flatMap((resource): readonly DemoRelationship[] => {
    const edge = ownerResourceModuleContainment(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, resource);
    return edge === undefined
      ? []
      : [
          {
            relation: edge.relation,
            resourceId: edge.resource.objectId,
            resourceType: edge.resource.objectType,
            subjectId: edge.container.objectId,
            subjectType: edge.container.objectType,
          },
        ];
  });
  // Company-scoped Core modules (people administration, roles) reach the company only through this edge; the demo
  // topology writes it for every company, and without it a company administrator is denied the people page.
  const companyStructure: readonly DemoRelationship[] = moduleKeys.map((moduleId) => ({
    relation: 'legal_entity',
    resourceId: toModuleAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, moduleId) ?? '',
    resourceType: 'module_access',
    subjectId: toLegalEntityAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId) ?? '',
    subjectType: 'legal_entity',
  }));
  // Resource reads use module->read_all, in addition to the named context permission.
  const [, authority] = akrosPlaygroundServices;
  const authorityRole = policy.find(
    (row) => row.resourceType === 'scoped_role' && row.subjectId === authority.principalId,
  )?.resourceId;
  const resourceReaders: DemoRelationship[] =
    authorityRole === undefined
      ? []
      : [marketModule, registryModule].map((moduleId) => ({
          relation: 'reader_role',
          resourceId: toModuleAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, moduleId) ?? '',
          resourceType: 'module_access',
          subjectId: authorityRole,
          subjectRelation: 'member',
          subjectType: 'scoped_role',
        }));
  const rows = companyMembershipAdmissionRelationships(
    [...topology, ...policy, ...resources, ...resourceReaders, ...companyStructure],
    akrosPlaygroundAccounts.map(({ principalId }) => ({ principalId, tenantId: akrosPlaygroundTenantId })),
  );
  return [
    ...new Map(
      rows.map((row) => {
        const relationship = v1.Relationship.create({
          relation: row.relation,
          resource: { objectId: row.resourceId, objectType: row.resourceType },
          subject: {
            object: { objectId: row.subjectId, objectType: row.subjectType },
            optionalRelation: row.subjectRelation ?? '',
          },
        });
        return [v1.Relationship.toJsonString(relationship), relationship];
      }),
    ).values(),
  ];
};

export const akrosPlaygroundAccessTargets = [
  { objectId: akrosPlaygroundTenantId, objectType: 'tenant', permission: 'access' },
  {
    objectId: toLegalEntityAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId) ?? '',
    objectType: 'legal_entity',
    permission: 'access',
  },
  ...['demo.merchandise', marketModule, registryModule].map((moduleId) => ({
    objectId: toModuleAccessObjectId(akrosPlaygroundTenantId, akrosPlaygroundLegalEntityId, moduleId) ?? '',
    objectType: 'module_access',
    permission: 'access',
  })),
];
