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
import {
  companyMembershipAdmissionRelationships,
  scopedActionRoleBootstrapRelationships,
} from '../../packages/core-runtime/src/install/context-bootstrap-shared.ts';
import type { ActionAuthorizationProvisioningAction } from '../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { toIdentityNamespaceAccessObjectId } from '../../packages/core-runtime/src/permissions/context-access.ts';
import { toScopedRoleObjectId } from '../../packages/core-runtime/src/permissions/scoped-role.ts';
import { Effect, Schema } from 'effect';

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
const crmReadAll = 'demo.crm.read_all';
const crmWriteAll = 'demo.crm.write_all';
const eshopAdministratorLabel = 'Správce e-shopu';
const proposalLifecycleActionKey = 'core.identity.mutate-agent-proposals';

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
  /** Explicit company-scoped proposal lifecycle execution; target business rights remain independently required. */
  readonly proposalReview?: true;
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
    proposalReview: true,
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
    proposalReview: true,
    tenantRole: tenantSuperadminRole,
  },
  salesRep: {
    label: 'Obchodník',
    proposalReview: true,
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
    proposalReview: true,
  },
} as const satisfies Readonly<Record<string, DemoRole>>;
export type DemoRoleKey = keyof typeof demoRoles;

/** Explicit local developer authority, isolated from every sales-demo tenant. */
export const localDevelopmentAdministratorFixture = {
  affiliation: 'employee',
  legalEntityId: '71000000-0000-4000-8000-000000000010',
  principalId: '72000000-0000-4000-8000-000000000010',
  role: { label: 'Local User', modules: {}, tenantRole: tenantSuperadminRole },
  tenantId: '70000000-0000-4000-8000-000000000010',
} as const satisfies {
  readonly affiliation: 'employee';
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly role: DemoRole;
  readonly tenantId: string;
};

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
  human('obchod', 'Jana Nováková', 'headOfSales'),
  human('obchodnik', 'Petr Svoboda', 'salesRep'),
  human('ucetni', 'Eva Veselá', 'accountant'),
  human('sklad', 'Pavel Němec', 'warehouse'),
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

/** Fixture labels only: authorization remains entirely in the generated SpiceDB relationships.
 * CRM representatives share an identical profile. All other human profiles remain isolated,
 * including supplemental grants that address this same key. Company scope stays in role identity.
 */
export const demoPrincipalRoleKey = (principalId: string): string => {
  const humanProfiles = {
    'akros-eshop': 'eshop-administration',
    'akros-expedice': 'fulfilment',
    'hanak-obchodnik-a': 'crm-sales',
    'hanak-obchodnik-b': 'crm-sales',
    'hanak-spravce': 'crm-administration',
    'hanak-vedouci': 'crm-leadership',
    'kavarna-eshop': 'eshop-administration',
    'kavarna-expedice': 'fulfilment',
    obchod: 'sales-leadership',
    obchodnik: 'sales',
    sklad: 'warehouse',
    ucetni: 'accounting',
  };
  const literalProfiles = new Map(
    Object.entries({
      '72000000-0000-4000-8000-000000000010': 'development-administration',
      '72000000-0000-4000-8000-000000000021': 'management',
      '72000000-0000-4000-8000-000000000022': 'operations',
      '72000000-0000-4000-8000-000000000023': 'rental-accounting',
      '72000000-0000-4000-8000-000000000024': 'external-business',
      '72000000-0000-4000-8000-000000000090': 'connection-verification',
    }),
  );
  for (const [person, roleKey] of Object.entries(humanProfiles)) {
    if (principalId === demoId(principalResource, person)) {
      return roleKey;
    }
  }
  return literalProfiles.get(principalId) ?? `demo:${principalId}`;
};

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
  roleKey: string = demoPrincipalRoleKey(principalId),
): readonly DemoRelationship[] => {
  const scope = action.legalEntityScope === 'forbidden' ? { tenantId } : { legalEntityId, tenantId };
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

/** Admin already opens company modules and executes their Actions; named Workforce permissions remain explicit. */
export const companyAdministratorWorkforceRelationships = (
  legalEntityId: string,
  tenantId: string = demoTenantId,
): readonly DemoRelationship[] => {
  const roleId = toScopedRoleObjectId({ legalEntityId, roleKey: 'admin', tenantId });
  const legal = toLegalEntityAccessObjectId(tenantId, legalEntityId) ?? '';
  return (['read', 'write'] as const).flatMap((access) => {
    const resourceId =
      toContextPermissionAccessObjectId(tenantId, legalEntityId, {
        moduleId: workforceModule,
        permission: contextPermissionKey(workforceModule, access),
      }) ?? '';
    return [
      {
        relation: 'tenant',
        resourceId,
        resourceType: 'context_permission',
        subjectId: tenantId,
        subjectType: 'tenant',
      },
      {
        relation: 'legal_entity',
        resourceId,
        resourceType: 'context_permission',
        subjectId: legal,
        subjectType: 'legal_entity',
      },
      roleRelationship('context_permission', resourceId, 'role_grantee', roleId),
    ];
  });
};

const proposalReviewActions = (role: DemoRole, actions: readonly DemoAction[]): readonly DemoAction[] =>
  role.proposalReview === true
    ? actions.filter(
        (action) =>
          action.actionKey === proposalLifecycleActionKey &&
          action.owningModuleKey === 'core.identity' &&
          action.legalEntityScope === 'required' &&
          action.provisioning === 'explicit',
      )
    : [];

/** Every relationship one principal needs for its role. `actions` is the current discovered Action set. */
export const principalRelationships = (
  principalId: string,
  role: DemoRole,
  actions: readonly DemoAction[],
  legalEntityId: string = demoLegalEntityId,
  tenantId: string = demoTenantId,
  roleKey: string = demoPrincipalRoleKey(principalId),
): readonly DemoRelationship[] => {
  const result: DemoRelationship[] = [];
  const add = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
    result.push({ relation, resourceId, resourceType, subjectId, subjectType });
  const companyRole = toScopedRoleObjectId({ legalEntityId, roleKey, tenantId });
  add('scoped_role', companyRole, 'member', 'principal', principalId);
  const grantAction = (descriptor: DemoAction) => {
    result.push(...scopedDemoActionRelationships(principalId, descriptor, legalEntityId, tenantId, roleKey));
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
      if (
        action.actionKey !== proposalLifecycleActionKey &&
        (actionKeys === undefined ? access === 'write' : actionKeys.includes(action.actionKey))
      ) {
        grantAction(action);
      }
    }
  }
  for (const lifecycle of proposalReviewActions(role, actions)) {
    grantAction(lifecycle);
  }
  if (role.companyRole !== undefined) {
    const adminRole = toScopedRoleObjectId({ legalEntityId, roleKey: role.companyRole, tenantId });
    add('scoped_role', adminRole, 'member', 'principal', principalId);
    result.push(
      roleRelationship('legal_entity', legal, 'admin', adminRole),
      ...companyAdministratorWorkforceRelationships(legalEntityId, tenantId),
    );
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
    proposalReview: true,
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
    proposalReview: true,
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
    proposalReview: true,
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
        contextPermissions: { 'demo.crm': [crmReadAll, crmWriteAll, 'demo.crm.assign'] },
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
const crmManagerPermissions = [crmReadAll, crmWriteAll, 'demo.crm.assign'] as const;
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
    proposalReview: true,
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
    proposalReview: true,
  },
  crmRep: {
    contextPermissions: { 'demo.crm': crmRepPermissions },
    label: 'Obchodník',
    proposalReview: true,
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
    proposalReview: true,
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
    proposalReview: true,
  },
  fulfilment: { label: 'Expedice', modules: { 'demo.merchandise': 'write' }, proposalReview: true },
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
  'Správce e-shopu AKROS',
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
  persona('akros-expedice', 'expedice@akros.demo', 'Expedice AKROS', akrosDemoLegalEntityId, 'fulfilment'),
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

const COMMERCE_PORTAL = 'commerce-portal';

export const commercePortalPrincipal = {
  apiKeyName: COMMERCE_PORTAL,
  displayName: 'Commerce · zákaznický portál',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, COMMERCE_PORTAL),
} as const;

export const privacyConsentPrincipal = {
  apiKeyName: 'privacy-consent-authority',
  displayName: 'Privacy · Commerce consent authority reader',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, 'privacy-consent-authority'),
} as const;

export const COMMERCE_PORTAL_NAMESPACE = 'ontos.commerce.portal.better-auth.v1';
/** Exact company-scoped native reads; the Actions below are granted one by one. */
const commercePortalRole: DemoRole = {
  contextPermissions: { 'privacy.core': privacyReadContextPermissions },
  label: 'Commerce portal (service)',
  modules: { 'commerce.customer-context': 'read', 'party.registry': 'read', 'privacy.core': 'read' },
};

/** The Actions the enrollment owners run on behalf of a customer. */
export const commercePortalActionKeys: readonly string[] = [
  'core.identity.reserve-principal-binding',
  'core.identity.activate-principal-binding',
  'core.identity.change-principal-binding-status',
  'privacy.core.create-privacy-subject',
  'privacy.core.create-notice-version',
  'privacy.core.record-notice-provision',
  'privacy.core.consent-self-service',
  'party.registry.create-party',
  'party.registry.accept-retail-enrollment-evidence',
  'party.registry.counterparty-customer-onboard',
  'party.registry.add-contact-point',
  // Customer self-service: the owner bridge edits the customer's own Party and contact points.
  'party.registry.update-party',
  'party.registry.update-contact-point',
  'commerce.customer-context.ensure-retail-customer-profile',
  'commerce.customer-context.bind-retail-portal-profile',
  'commerce.customer-context.claim-portal-enrollment-transition',
  'commerce.customer-context.record-portal-enrollment-outcome',
];

export const commercePortalRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => {
  const { legalEntityId, principalId } = commercePortalPrincipal;
  const namespace = toIdentityNamespaceAccessObjectId(demoTenantId, COMMERCE_PORTAL_NAMESPACE) ?? '';
  const roleId = toScopedRoleObjectId({
    legalEntityId,
    roleKey: demoPrincipalRoleKey(principalId),
    tenantId: demoTenantId,
  });
  const relationships: DemoRelationship[] = [
    {
      relation: 'tenant',
      resourceId: namespace,
      resourceType: 'identity_namespace',
      subjectId: demoTenantId,
      subjectType: 'tenant',
    },
    roleRelationship('identity_namespace', namespace, 'provisioner', roleId),
    ...principalRelationships(principalId, commercePortalRole, actions, legalEntityId),
    // Business authority is independent of the exact Action executor allowlist below.
    // Keep module access read-only: a write role would automatically grant every Party Action.
    roleRelationship('tenant', demoTenantId, 'party_identity_manager', roleId),
    roleRelationship(
      'legal_entity',
      toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '',
      'counterparty_manager',
      roleId,
    ),
  ];
  for (const action of actions.filter(({ actionKey }) => commercePortalActionKeys.includes(actionKey))) {
    relationships.push(...scopedDemoActionRelationships(principalId, action, legalEntityId));
  }
  return [...new Map(relationships.map((relationship) => [relationshipKey(relationship), relationship])).values()];
};

/** Privacy can resolve only the two Commerce authority facts, not read customer groups or execute Actions. */
export const privacyConsentAuthorityRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] =>
  principalRelationships(
    privacyConsentPrincipal.principalId,
    {
      contextPermissions: {
        'commerce.customer-context': ['customer.consent.resolve_authority', 'customer.notice.resolve_authority'],
      },
      label: 'Privacy consent authority reader',
      modules: { 'commerce.customer-context': 'read' },
      restrictedModules: ['commerce.customer-context'],
    },
    actions,
    privacyConsentPrincipal.legalEntityId,
  );

const intakeName = 'crm-party-intake';

export const crmPartyIntakePrincipal = {
  apiKeyName: intakeName,
  displayName: 'CRM · zakládání klientů v Party Registry',
  envVar: 'ONTOS_CRM_PARTY_INTAKE_API_KEY',
  principalId: demoId(principalResource, intakeName),
} as const;

/** Companies whose CRM writes clients into the registry. */
export const crmIntakeLegalEntityIds: readonly string[] = [rentalDemoLegalEntityId, crmDemoLegalEntityId];

/**
 * The only Actions the intake runs: four registry Actions and the CRM apply-command, where the CRM command guard
 * lets this principal run `LinkClientParty` only (it reads the clients through demo.crm.read_all).
 */
export const crmIntakeActionKeys: readonly string[] = [
  'party.registry.create-party',
  'party.registry.resolve-duplicate-candidate-create',
  'party.registry.counterparty-customer-onboard',
  'party.registry.add-contact-point',
  'demo.crm.apply-command',
];
const crmIntakePermissions = [crmReadAll, crmWriteAll] as const;

export const crmIntakeRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => {
  const { principalId } = crmPartyIntakePrincipal;
  const relationships = crmIntakeLegalEntityIds.flatMap((legalEntityId) => {
    const roleId = toScopedRoleObjectId({
      legalEntityId,
      roleKey: demoPrincipalRoleKey(principalId),
      tenantId: demoTenantId,
    });
    return [
      ...principalRelationships(
        principalId,
        {
          contextPermissions: { 'demo.crm': crmIntakePermissions },
          label: 'CRM Party intake',
          modules: { 'demo.crm': 'read', 'party.registry': 'read' },
        },
        actions,
        legalEntityId,
      ),
      ...['party_identity_manager', 'party_identity_reviewer'].map((relation) =>
        roleRelationship('tenant', demoTenantId, relation, roleId),
      ),
      roleRelationship(
        'legal_entity',
        toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '',
        'counterparty_manager',
        roleId,
      ),
      ...actions
        .filter(({ actionKey }) => crmIntakeActionKeys.includes(actionKey))
        .flatMap((action) => scopedDemoActionRelationships(principalId, action, legalEntityId)),
    ];
  });
  return [...new Map(relationships.map((row) => [relationshipKey(row), row])).values()];
};

/** Relationships for the four demo accounts and the bot, deduplicated. */
export const demoPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => {
  const all = [
    ...demoHumanAccounts.flatMap((account) =>
      principalRelationships(account.principalId, demoRoles[account.role], actions),
    ),
    ...principalRelationships(agentBotPrincipal.principalId, demoRoles[agentBotPrincipal.role], actions),
    ...rentalPermissionRelationships(actions),
    ...companyPermissionRelationships(actions),
    ...commercePortalRelationships(actions),
    ...privacyConsentAuthorityRelationships(actions),
    ...crmIntakeRelationships(actions),
  ];
  return companyMembershipAdmissionRelationships(
    [...new Map(all.map((relationship) => [relationshipKey(relationship), relationship])).values()],
    demoCompanyMemberships.map(({ principalId }) => ({ principalId, tenantId: demoTenantId })),
  );
};

/** Reviewed live-only restoration: exact executors, no module or context-permission union. */
const ReviewedActionKeySchema = Schema.String.pipe(Schema.brand('ActionKey'));

export class ReviewedDemoActionMissing extends Schema.TaggedError<ReviewedDemoActionMissing>()(
  'ReviewedDemoActionMissing',
  { actionKey: ReviewedActionKeySchema, message: Schema.String },
) {}

export const reviewedHumanActionAddonRelationships = Effect.fn('DemoPermissions.reviewedHumanActionAddons')(
  function* reviewedHumanActionAddons(actions: readonly DemoAction[]) {
    const operationsKeys = [
      'crm.activities.apply-command',
      'demo.workforce.apply-command',
      'demo.merchandise.apply-command',
      'demo.sales-insights.apply-command',
      'finance.billing.apply-command',
      'property.portfolio.apply-command',
    ];
    const selected = (keys: readonly string[]) =>
      Effect.forEach(
        keys,
        (key) => {
          const action = actions.find((candidate) => candidate.actionKey === key);
          if (action === undefined) {
            return Effect.fail(
              new ReviewedDemoActionMissing({
                actionKey: ReviewedActionKeySchema.make(key),
                message: `Reviewed Action missing: ${key}`,
              }),
            );
          }
          return Effect.succeed(action);
        },
        { concurrency: 1 },
      );
    return [
      ...(yield* selected(operationsKeys)).flatMap((action) =>
        scopedDemoActionRelationships(
          siamparkRentalPersonas[1].principalId,
          action,
          rentalDemoLegalEntityId,
          demoTenantId,
          'operations-execution',
        ),
      ),
      ...(yield* selected(['property.leasing.apply-command'])).flatMap((action) =>
        scopedDemoActionRelationships(
          demoHumanAccounts[1].principalId,
          action,
          demoLegalEntityId,
          demoTenantId,
          'rental-sales-execution',
        ),
      ),
    ];
  },
);
