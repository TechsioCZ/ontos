/**
 * Sales-demo role matrix (plan 22): who may read or write which module, as SpiceDB relationships.
 *
 * One `<module>.apply-command` executor grant covers every command of a module, so each demo vertical also
 * runs `shared/actions/command-guard.ts`, which rejects a fixed command list for non-human principals.
 * Pure data and pure builders only; `reset-permissions.mts` writes the result.
 */
import {
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '@app/core-runtime';
import { scopedActionRoleBootstrapRelationships } from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import type { ActionAuthorizationProvisioningAction } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { Schema } from 'effect';

import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';

const commerceModule = 'commerce.customer-context';
const pipelineModule = 'demo.sales-pipeline';
const commercialAdministratorLabel = 'Vedoucí obchodu';

const partyModule = 'party.registry';
const workforceModule = 'demo.workforce';
const operationsModule = 'facility.operations';
const tenantSuperadminRole = 'superadmin';
const principalResource = 'core.principal';
const eshopAdministratorLabel = 'Správce e-shopu';

/**
 * Module IDs as declared in each `vertical.manifest.ts`. Vertical directories: party-registry, work-tasks,
 * finance-billing, workforce, tagging, sales-pipeline, merchandise, sales-insights, commerce-customer-context.
 */
export const demoModuleIds = [
  commerceModule,
  partyModule,
  'privacy.core',
  'work.tasks',
  'finance.billing',
  workforceModule,
  'demo.tagging',
  pipelineModule,
  'demo.merchandise',
  'demo.sales-insights',
  'property.portfolio',
  'property.leasing',
  'legal.agreements',
  'demo.crm',
  operationsModule,
] as const;
export type DemoModuleId = (typeof demoModuleIds)[number];
export const ModuleAccessSchema = Schema.Literals(['read', 'write']);
export type ModuleAccess = typeof ModuleAccessSchema.Type;

/**
 * Modules gated by generated `<module>.read_all` / `<module>.write_all` context permissions. Permission keys
 * allow only `[a-z0-9_]` segments, so `demo.sales-pipeline` uses `demo.sales_pipeline.read_all`.
 * party.registry uses Tenant/legal-entity relations instead; billing has no business permissions.
 */
const contextPermissionModules: ReadonlySet<DemoModuleId> = new Set([
  'demo.merchandise',
  'demo.sales-insights',
  pipelineModule,
  'demo.tagging',
  workforceModule,
  'work.tasks',
  operationsModule,
]);
export const contextPermissionKey = (moduleId: DemoModuleId, access: ModuleAccess) =>
  `${moduleId.replaceAll('-', '_')}.${access === 'read' ? 'read_all' : 'write_all'}`;

/**
 * Owner-declared context permissions granted with any access to the module. The customers page reads the
 * customer segments (commerce customer groups) with `customer.group.read`.
 */
const moduleReadPermissions = (moduleId: DemoModuleId): readonly string[] =>
  moduleId === commerceModule ? ['customer.group.read'] : [];

/** Native Privacy reads are separate company-scoped grants, not implied by module access. */
export const privacyReadContextPermissions = [
  'privacy.processing_catalog.read',
  'privacy.notice.read',
  'privacy.subjects.read',
  'privacy.consent.read',
] as const;

const everything = {
  [commerceModule]: 'write',
  'demo.merchandise': 'write',
  'demo.sales-insights': 'write',
  'demo.tagging': 'write',
  'finance.billing': 'write',
  'legal.agreements': 'write',
  [partyModule]: 'write',
  [pipelineModule]: 'write',
  'work.tasks': 'write',
  [workforceModule]: 'write',
} as const satisfies Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;

export interface DemoRole {
  /** Exact per-module Actions, replacing the automatic all-Actions grant for that module. */
  readonly actionKeys?: Readonly<Partial<Record<DemoModuleId, readonly string[]>>>;
  /** Explicit administrative roles; never inferred from a job, name, or principal kind. */
  readonly companyRole?: 'admin';
  /** Extra owner-declared context permissions (e.g. `demo.crm.read_assigned`) granted on top of module access. */
  readonly contextPermissions?: Readonly<Partial<Record<DemoModuleId, readonly string[]>>>;
  readonly label: string;
  readonly modules: Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;
  /** Modules opened without the generic read_all/write_all grants (only `contextPermissions` apply). */
  readonly restrictedModules?: readonly DemoModuleId[];
  readonly tenantRole?: typeof tenantSuperadminRole;
}

export const demoRoles = {
  accountant: {
    label: 'Účetní',
    modules: {
      [commerceModule]: 'read',
      // Invoice lines pick products; without this read the create form's product list fails to load.
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      // Customer lists show Štítky; without this read every tag cell fails to load for the accountant.
      'demo.tagging': 'read',
      'finance.billing': 'write',
      'legal.agreements': 'read',
      [partyModule]: 'read',
    },
  },
  agentBot: {
    label: 'Agent (bot)',
    modules: {
      [commerceModule]: 'read',
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      'demo.tagging': 'write',
      'finance.billing': 'read',
      'legal.agreements': 'read',
      [partyModule]: 'read',
      [pipelineModule]: 'write',
      'work.tasks': 'write',
      [workforceModule]: 'read',
    },
  },
  headOfSales: {
    companyRole: 'admin',
    label: commercialAdministratorLabel,
    modules: { ...everything, 'privacy.core': 'write' },
    tenantRole: tenantSuperadminRole,
  },
  salesRep: {
    label: 'Obchodník',
    // Billing is visible but not writable: the rep cannot confirm or void invoices.
    modules: {
      [commerceModule]: 'write',
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      'demo.tagging': 'write',
      'finance.billing': 'read',
      'legal.agreements': 'write',
      [partyModule]: 'write',
      [pipelineModule]: 'write',
      'work.tasks': 'write',
      [workforceModule]: 'read',
    },
  },
  warehouse: {
    label: 'Skladník',
    modules: { 'demo.merchandise': 'write', 'work.tasks': 'write' },
  },
} as const satisfies Readonly<Record<string, DemoRole>>;
export type DemoRoleKey = keyof typeof demoRoles;

const human = (key: string, displayName: string, role: DemoRoleKey) => ({
  authBindingId: demoId('core.auth-binding', key),
  authUserId: `demo-${key}`,
  displayName,
  email: `${key}@demo.ontos`,
  principalId: demoId(principalResource, key),
  role,
});

/** Human demo accounts; password `password1234`. Principal IDs are stable for workforce `principalRef`s. */
export const demoHumanAccounts = [
  human('obchod', commercialAdministratorLabel, 'headOfSales'),
  human('obchodnik', 'Obchodník', 'salesRep'),
  human('ucetni', 'Účetní', 'accountant'),
  human('sklad', 'Skladník', 'warehouse'),
] as const;

/** Service principal used by the agent MCP server through a managed API key. */
export const agentBotPrincipal = {
  displayName: 'agent-bot',
  kind: 'service',
  principalId: demoId(principalResource, 'agent-bot'),
  role: 'agentBot',
} as const;

export type DemoAction = ActionAuthorizationProvisioningAction;

export interface DemoRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectRelation?: string;
  readonly subjectType: string;
}

/** Action keys owned by a module (`party.registry.create-party`, `demo.tagging.apply-command`, ...). */
export const moduleActions = (actions: readonly DemoAction[], moduleId: string) =>
  actions.filter(({ owningModuleKey }) => owningModuleKey === moduleId);

const partyRelations = (access: ModuleAccess) =>
  access === 'write'
    ? {
        legalEntity: ['counterparty_manager', 'counterparty_reader'],
        // party_identity_reviewer: the customer form resolves its own no-candidate Duplicate Candidate Case
        // as CREATE_NEW (a Candidate without a VERIFIED IČO is always AMBIGUOUS on create-party).
        tenant: [
          'party_identity_manager',
          'party_identity_reader',
          'party_identity_reviewer',
          'party_relationship_manager',
        ],
      }
    : { legalEntity: ['counterparty_reader'], tenant: ['party_identity_reader'] };

const relationshipKey = (relationship: DemoRelationship) =>
  [
    relationship.resourceType,
    relationship.resourceId,
    relationship.relation,
    relationship.subjectType,
    relationship.subjectId,
    relationship.subjectRelation ?? '',
  ].join('|');

/** A principal is assigned to an exact scoped module role; capabilities target its userset. */
export const demoPrincipalRoleKey = (principalId: string): string => `demo:${principalId}`;

export const roleRelationship = (
  resourceType: string,
  resourceId: string,
  relation: string,
  roleId: string,
): DemoRelationship => ({
  relation,
  resourceId,
  resourceType,
  subjectId: roleId,
  subjectRelation: 'member',
  subjectType: 'scoped_role',
});

/** Optional Actions use the selected company, never an additional implicit tenant grant. */
export const scopedDemoActionRelationships = (
  principalId: string,
  action: DemoAction,
  legalEntityId: string,
  tenantId: string = demoTenantId,
): readonly DemoRelationship[] => {
  const scope = action.legalEntityScope === 'forbidden' ? { tenantId } : { legalEntityId, tenantId };
  const roleKey = demoPrincipalRoleKey(principalId);
  const roleId = toScopedRoleObjectId({ ...scope, roleKey });
  return [
    {
      relation: 'member',
      resourceId: roleId,
      resourceType: 'scoped_role',
      subjectId: principalId,
      subjectType: 'principal',
    },
    ...(action.legalEntityScope === 'forbidden' ? [roleRelationship('tenant', tenantId, 'context_role', roleId)] : []),
    ...scopedActionRoleBootstrapRelationships({ ...scope, action, roleKey }),
  ];
};

const roleContextPermissions = (role: DemoRole, moduleId: DemoModuleId, access: ModuleAccess): readonly string[] => {
  const restricted = (role.restrictedModules ?? []).includes(moduleId);
  const generic =
    contextPermissionModules.has(moduleId) && !restricted
      ? (access === 'write' ? (['read', 'write'] as const) : (['read'] as const)).map((level) =>
          contextPermissionKey(moduleId, level),
        )
      : [];
  return [
    ...generic,
    ...(restricted ? [] : moduleReadPermissions(moduleId)),
    ...(role.contextPermissions?.[moduleId] ?? []),
  ];
};

/** Every relationship one principal needs for its role. `actions` is the current discovered Action set. */
export const principalRelationships = (
  principalId: string,
  role: DemoRole,
  actions: readonly DemoAction[],
  legalEntityId: string = demoLegalEntityId,
  tenantId: string = demoTenantId,
): readonly DemoRelationship[] => {
  const result: DemoRelationship[] = [];
  const add = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
    result.push({ relation, resourceId, resourceType, subjectId, subjectType });
  const roleKey = demoPrincipalRoleKey(principalId);
  const companyRole = toScopedRoleObjectId({ legalEntityId, roleKey, tenantId });
  add('scoped_role', companyRole, 'member', 'principal', principalId);
  const grantAction = (descriptor: DemoAction) => {
    result.push(...scopedDemoActionRelationships(principalId, descriptor, legalEntityId, tenantId));
  };
  const grantContextPermission = (moduleId: DemoModuleId, permission: string) => {
    const objectId = toContextPermissionAccessObjectId(tenantId, legalEntityId, { moduleId, permission }) ?? '';
    add('context_permission', objectId, 'tenant', 'tenant', tenantId);
    add(
      'context_permission',
      objectId,
      'legal_entity',
      'legal_entity',
      toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '',
    );
    result.push({
      relation: 'role_grantee',
      resourceId: objectId,
      resourceType: 'context_permission',
      subjectId: companyRole,
      subjectRelation: 'member',
      subjectType: 'scoped_role',
    });
  };
  const legal = toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '';
  const moduleAccess = (moduleId: string) => toModuleAccessObjectId(tenantId, legalEntityId, moduleId) ?? '';
  add('legal_entity', legal, 'tenant', 'tenant', tenantId);
  add('tenant', tenantId, 'member', 'principal', principalId);
  add('legal_entity', legal, 'member', 'principal', principalId);
  for (const moduleId of ['core.shell']) {
    add('module_access', moduleAccess(moduleId), 'legal_entity', 'legal_entity', legal);
    result.push({
      relation: 'accessor_role',
      resourceId: moduleAccess(moduleId),
      resourceType: 'module_access',
      subjectId: companyRole,
      subjectRelation: 'member',
      subjectType: 'scoped_role',
    });
  }
  for (const moduleId of demoModuleIds) {
    const access = role.modules[moduleId];
    if (access === undefined) {
      continue;
    }
    add('module_access', moduleAccess(moduleId), 'legal_entity', 'legal_entity', legal);
    result.push({
      relation: 'accessor_role',
      resourceId: moduleAccess(moduleId),
      resourceType: 'module_access',
      subjectId: companyRole,
      subjectRelation: 'member',
      subjectType: 'scoped_role',
    });
    for (const permission of roleContextPermissions(role, moduleId, access)) {
      grantContextPermission(moduleId, permission);
    }
    if (moduleId === partyModule) {
      const relations = partyRelations(access);
      for (const relation of relations.tenant) {
        result.push(roleRelationship('tenant', tenantId, relation, companyRole));
      }
      for (const relation of relations.legalEntity) {
        result.push(roleRelationship('legal_entity', legal, relation, companyRole));
      }
    }
    const actionKeys = role.actionKeys?.[moduleId];
    for (const action of moduleActions(actions, moduleId)) {
      if (actionKeys === undefined ? access === 'write' : actionKeys.includes(action.actionKey)) {
        grantAction(action);
      }
    }
  }
  if (role.companyRole !== undefined) {
    const adminRole = toScopedRoleObjectId({ legalEntityId, roleKey: role.companyRole, tenantId });
    add('scoped_role', adminRole, 'member', 'principal', principalId);
    result.push(roleRelationship('legal_entity', legal, 'admin', adminRole));
  }
  if (role.tenantRole !== undefined) {
    const adminRole = toScopedRoleObjectId({ roleKey: role.tenantRole, tenantId });
    add('scoped_role', adminRole, 'member', 'principal', principalId);
    result.push(roleRelationship('tenant', tenantId, tenantSuperadminRole, adminRole));
  }
  return [...new Map(result.map((row) => [relationshipKey(row), row])).values()];
};

/** Rental capabilities are granted independently from the trading company's modules. */
export const rentalDemoRoles = {
  accountant: {
    label: 'Účetní pronájmů',
    modules: {
      [commerceModule]: 'read',
      'demo.tagging': 'read',
      'finance.billing': 'write',
      'legal.agreements': 'read',
      [partyModule]: 'read',
      // S10-03: the accountant opens the lease and sees the agreed rent and its contract.
      'property.leasing': 'read',
      'property.portfolio': 'read',
    },
  },
  agentBot: {
    label: 'Agent pronájmů',
    modules: {
      [commerceModule]: 'read',
      'demo.tagging': 'write',
      'finance.billing': 'read',
      'legal.agreements': 'read',
      [partyModule]: 'read',
      [pipelineModule]: 'write',
      'property.portfolio': 'read',
      'work.tasks': 'write',
      [workforceModule]: 'read',
    },
  },
  headOfSales: {
    companyRole: 'admin',
    label: 'Správce pronájmů',
    modules: {
      [commerceModule]: 'write',
      'demo.sales-insights': 'read',
      'demo.tagging': 'write',
      'finance.billing': 'write',
      'legal.agreements': 'write',
      [partyModule]: 'write',
      [pipelineModule]: 'write',
      'property.leasing': 'write',
      'property.portfolio': 'write',
      'work.tasks': 'write',
      [workforceModule]: 'read',
    },
  },
  salesRep: {
    label: 'Obchodník pronájmů',
    modules: {
      [commerceModule]: 'write',
      'demo.sales-insights': 'read',
      'demo.tagging': 'write',
      'finance.billing': 'read',
      'legal.agreements': 'write',
      [partyModule]: 'write',
      [pipelineModule]: 'write',
      [workforceModule]: 'read',
      // S01-02: the salesperson logs calls and moves the business case; Provoz books stays (S10).
      'property.leasing': 'write',
      'property.portfolio': 'read',
      'work.tasks': 'write',
    },
  },
} as const satisfies Readonly<Partial<Record<DemoRoleKey, DemoRole>>>;

/**
 * The original Siampark accounts (`scripts/siampark/fixtures.mts` demoAccounts, created by `pnpm demo:reset`) in the
 * Siampark company 0021, each with the `facility.operations` agendas. The external agent sees operational agendas only.
 */
const withFacilityOperations = (role: DemoRole): DemoRole => ({
  ...role,
  modules: { ...role.modules, [operationsModule]: 'write' },
});
export const siamparkRentalPersonas = [
  {
    email: 'management@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000021',
    // S00: Vedení keeps every CRM contact and entrusts chosen ones to the external salesperson (demo.crm.assign).
    role: (() => {
      const base = withFacilityOperations(rentalDemoRoles.headOfSales);
      return {
        ...base,
        contextPermissions: { 'demo.crm': ['demo.crm.read_all', 'demo.crm.write_all', 'demo.crm.assign'] },
        modules: { ...base.modules, 'demo.crm': 'write' },
      } satisfies DemoRole;
    })(),
  },
  {
    email: 'operations@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000022',
    role: withFacilityOperations(rentalDemoRoles.salesRep),
  },
  {
    email: 'finance@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000023',
    role: withFacilityOperations(rentalDemoRoles.accountant),
  },
  {
    email: 'external@siampark.demo',
    principalId: '72000000-0000-4000-8000-000000000024',
    // S00: reads only the CRM clients entrusted to him (`demo.crm.read_assigned`, no write, no read_all) and the
    // business cases entrusted to him: `demo.sales-pipeline` opened read-only WITHOUT `read_all`, so the owner's
    // governed records read returns only opportunities with a per-case reader grant (scripts/demo/
    // seed-siampark-cases.mts grants exactly the cases owned by his employee record). No write Action, no
    // billing/finance, agreements, occupancy or party registry. Siampark CRM data: scripts/demo/seed-siampark-crm.mts.
    role: {
      contextPermissions: {
        'demo.crm': ['demo.crm.read_assigned'],
        // S00: provoz read-only. Without read_all/write_all facility-operations returns only the calendar events assigned
        // to him and operational meter data; no agenda or meter write (the apply-command Action stays granted only
        // for his own inbox, preferences and export log). Live: scripts/demo/ops-operational-permissions.mts.
        [operationsModule]: ['facility.operations.read_operational'],
      },
      label: 'Externí partner',
      modules: { 'demo.crm': 'read', [operationsModule]: 'write', [pipelineModule]: 'read' },
      restrictedModules: ['demo.crm', pipelineModule, operationsModule],
    },
  },
] as const satisfies readonly { readonly email: string; readonly principalId: string; readonly role: DemoRole }[];

export const rentalPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => [
  ...demoHumanAccounts.flatMap((account) =>
    account.role === 'warehouse'
      ? []
      : principalRelationships(account.principalId, rentalDemoRoles[account.role], actions, rentalDemoLegalEntityId),
  ),
  ...principalRelationships(agentBotPrincipal.principalId, rentalDemoRoles.agentBot, actions, rentalDemoLegalEntityId),
  ...siamparkRentalPersonas.flatMap((persona) =>
    principalRelationships(persona.principalId, persona.role, actions, rentalDemoLegalEntityId),
  ),
];

/**
 * CRM company „Velkoobchod Hanák s.r.o.“ (0022). `demo.crm` is not a generic read_all/write_all module: managers
 * hold `demo.crm.read_all` + `demo.crm.write_all` + `demo.crm.assign`, sales reps only `demo.crm.read_assigned` +
 * `demo.crm.write_assigned`, and the crm owner filters clients by the assigned principal for them.
 */
const crmManagerPermissions = ['demo.crm.read_all', 'demo.crm.write_all', 'demo.crm.assign'] as const;
const crmRepPermissions = ['demo.crm.read_assigned', 'demo.crm.write_assigned'] as const;
export const crmDemoRoles = {
  crmAdmin: {
    companyRole: 'admin',
    contextPermissions: { 'demo.crm': crmManagerPermissions },
    label: 'Správce',
    modules: {
      [commerceModule]: 'write',
      'demo.crm': 'write',
      'demo.tagging': 'write',
      [partyModule]: 'write',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
  },
  crmManager: {
    contextPermissions: { 'demo.crm': crmManagerPermissions },
    label: commercialAdministratorLabel,
    modules: {
      [commerceModule]: 'read',
      'demo.crm': 'write',
      'demo.tagging': 'read',
      [partyModule]: 'read',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
  },
  crmRep: {
    contextPermissions: { 'demo.crm': crmRepPermissions },
    label: 'Obchodník',
    // No party.registry: its customer list is company-wide and would bypass the assigned-client filter.
    modules: { 'demo.crm': 'write', 'work.tasks': 'write', [workforceModule]: 'read' },
  },
} as const satisfies Readonly<Record<string, DemoRole>>;

/** E-shop company „Kavárna Doma s.r.o.“ (0023). */
export const eshopDemoRoles = {
  akrosAdmin: {
    actionKeys: {
      'privacy.core': ['privacy.core.create-processing-purpose', 'privacy.core.create-notice-version'],
    },
    companyRole: 'admin',
    contextPermissions: {
      'privacy.core': ['privacy.processing_catalog.read', 'privacy.notice.read'],
    },
    label: eshopAdministratorLabel,
    modules: {
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      [partyModule]: 'write',
      'privacy.core': 'read',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
  },
  akrosStorefront: {
    actionKeys: {
      [commerceModule]: [
        'commerce.customer-context.start-portal-enrollment',
        'commerce.customer-context.claim-portal-enrollment-transition',
      ],
    },
    contextPermissions: {
      [commerceModule]: [
        'customer.profile.read_own',
        'customer.profile.update_own',
        'customer.consent.read_own',
        'customer.consent.update_own',
      ],
    },
    label: 'AKROS storefront (API)',
    modules: { [commerceModule]: 'read', 'demo.merchandise': 'write', 'work.tasks': 'write' },
    restrictedModules: [commerceModule],
  },
  eshopAdmin: {
    companyRole: 'admin',
    label: eshopAdministratorLabel,
    modules: {
      [commerceModule]: 'read',
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      [partyModule]: 'write',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
  },
  fulfilment: { label: 'Expedice', modules: { 'demo.merchandise': 'write' } },
  /** Non-human storefront BFF: merchandise reads and the apply-command Action (PlaceStorefrontOrder). */
  storefront: { label: 'Storefront (API)', modules: { 'demo.merchandise': 'write' } },
} as const satisfies Readonly<Record<string, DemoRole>>;

type CompanyRoleKey = keyof typeof crmDemoRoles | keyof typeof eshopDemoRoles;
const companyRoles = { ...crmDemoRoles, ...eshopDemoRoles } satisfies Readonly<Record<CompanyRoleKey, DemoRole>>;

const persona = (key: string, email: string, displayName: string, legalEntityId: string, role: CompanyRoleKey) => ({
  authBindingId: demoId('core.auth-binding', key),
  authUserId: `demo-${key}`,
  displayName,
  email,
  legalEntityId,
  principalId: demoId(principalResource, key),
  role,
});

/** Existing AKROS human administrator: exact company-only Privacy catalog setup operator. */
export const privacyMarketingOperator = persona(
  'akros-eshop',
  'eshop@akros.demo',
  eshopAdministratorLabel,
  akrosDemoLegalEntityId,
  'akrosAdmin',
);

/** Human accounts of the CRM and e-shop companies (password `password1234`); each belongs to one company only. */
export const companyHumanAccounts = [
  persona('hanak-spravce', 'spravce@hanak.demo', 'Karel Hanák', crmDemoLegalEntityId, 'crmAdmin'),
  persona('hanak-vedouci', 'vedouci@hanak.demo', 'Lucie Dvořáková', crmDemoLegalEntityId, 'crmManager'),
  persona('hanak-obchodnik-a', 'obchodnik.a@hanak.demo', 'Jan Novák', crmDemoLegalEntityId, 'crmRep'),
  persona('hanak-obchodnik-b', 'obchodnik.b@hanak.demo', 'Petra Svobodová', crmDemoLegalEntityId, 'crmRep'),
  persona('kavarna-eshop', 'eshop@kavarna.demo', 'Tereza Malá', eshopDemoLegalEntityId, 'eshopAdmin'),
  privacyMarketingOperator,
  persona('akros-expedice', 'expedice@akros.demo', 'Expedice', akrosDemoLegalEntityId, 'fulfilment'),
  persona('kavarna-expedice', 'expedice@kavarna.demo', 'Ondřej Kříž', eshopDemoLegalEntityId, 'fulfilment'),
] as const;

/** Stable principal IDs of the CRM personas, e.g. for client assignments in the crm seed. */
export const crmPersonaPrincipalIds = {
  manager: demoId(principalResource, 'hanak-vedouci'),
  repA: demoId(principalResource, 'hanak-obchodnik-a'),
  repB: demoId(principalResource, 'hanak-obchodnik-b'),
  spravce: demoId(principalResource, 'hanak-spravce'),
} as const;

/** Service principal of the e-shop storefront BFF; its managed API key lands in `app/.env.demo.local`. */
export const storefrontPrincipal = {
  displayName: 'kavarna-storefront',
  kind: 'service',
  legalEntityId: eshopDemoLegalEntityId,
  principalId: demoId(principalResource, 'kavarna-storefront'),
  role: 'storefront',
} as const;

export const akrosStorefrontPrincipal = {
  displayName: 'akros-storefront',
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, 'akros-storefront'),
  role: 'akrosStorefront',
} as const;

export const companyPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => [
  ...companyHumanAccounts.flatMap((account) =>
    principalRelationships(account.principalId, companyRoles[account.role], actions, account.legalEntityId),
  ),
  ...principalRelationships(
    akrosStorefrontPrincipal.principalId,
    companyRoles[akrosStorefrontPrincipal.role],
    actions,
    akrosDemoLegalEntityId,
  ),
  ...principalRelationships(
    storefrontPrincipal.principalId,
    companyRoles[storefrontPrincipal.role],
    actions,
    storefrontPrincipal.legalEntityId,
  ),
];

/** Relationships for the four demo accounts and the bot, deduplicated. */
export const demoPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => {
  const all = [
    ...demoHumanAccounts.flatMap((account) =>
      principalRelationships(account.principalId, demoRoles[account.role], actions),
    ),
    ...principalRelationships(agentBotPrincipal.principalId, demoRoles[agentBotPrincipal.role], actions),
    ...rentalPermissionRelationships(actions),
    ...companyPermissionRelationships(actions),
  ];
  return [...new Map(all.map((relationship) => [relationshipKey(relationship), relationship])).values()];
};

/** Deliberate human affiliations only; role assignment never creates an SQL membership. */
export const demoCompanyMemberships = [
  ...demoHumanAccounts.map(({ principalId }) => ({
    affiliation: 'employee' as const,
    legalEntityId: demoLegalEntityId,
    principalId,
  })),
  ...[demoHumanAccounts[0], demoHumanAccounts[1], demoHumanAccounts[2]].map(({ principalId }) => ({
    affiliation: 'employee' as const,
    legalEntityId: rentalDemoLegalEntityId,
    principalId,
  })),
  ...companyHumanAccounts.map(({ legalEntityId, principalId }) => ({
    affiliation: 'employee' as const,
    legalEntityId,
    principalId,
  })),
  {
    affiliation: 'employee' as const,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: '72000000-0000-4000-8000-000000000021',
  },
  {
    affiliation: 'employee' as const,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: '72000000-0000-4000-8000-000000000022',
  },
  {
    affiliation: 'employee' as const,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: '72000000-0000-4000-8000-000000000023',
  },
  {
    affiliation: 'external' as const,
    legalEntityId: rentalDemoLegalEntityId,
    principalId: '72000000-0000-4000-8000-000000000024',
  },
] as const;
