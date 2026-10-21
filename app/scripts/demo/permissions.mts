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
import { toSpiceDbActionObjectId } from '@app/core-runtime/actions/runtime-wiring';
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

/**
 * Module IDs as declared in each `vertical.manifest.ts`. Vertical directories: party-registry, work-tasks,
 * finance-billing, workforce, tagging, sales-pipeline, merchandise, sales-insights, commerce-customer-context.
 */
export const demoModuleIds = [
  'commerce.customer-context',
  'party.registry',
  'work.tasks',
  'finance.billing',
  'demo.workforce',
  'demo.tagging',
  'demo.sales-pipeline',
  'demo.merchandise',
  'demo.sales-insights',
  'property.portfolio',
  'property.leasing',
  'legal.agreements',
  'demo.crm',
  'facility.operations',
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
  'demo.sales-pipeline',
  'demo.tagging',
  'demo.workforce',
  'work.tasks',
  'facility.operations',
]);
export const contextPermissionKey = (moduleId: DemoModuleId, access: ModuleAccess) =>
  `${moduleId.replaceAll('-', '_')}.${access === 'read' ? 'read_all' : 'write_all'}`;

/**
 * Owner-declared context permissions granted with any access to the module. The customers page reads the
 * customer segments (commerce customer groups) with `customer.group.read`.
 */
const moduleReadPermissions = (moduleId: DemoModuleId): readonly string[] =>
  moduleId === 'commerce.customer-context' ? ['customer.group.read'] : [];

const everything = {
  'commerce.customer-context': 'write',
  'demo.merchandise': 'write',
  'demo.sales-insights': 'write',
  'demo.sales-pipeline': 'write',
  'demo.tagging': 'write',
  'demo.workforce': 'write',
  'party.registry': 'write',
  'legal.agreements': 'write',
  'finance.billing': 'write',
  'work.tasks': 'write',
} as const satisfies Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;

export interface DemoRole {
  /** Extra owner-declared context permissions (e.g. `demo.crm.read_assigned`) granted on top of module access. */
  readonly contextPermissions?: Readonly<Partial<Record<DemoModuleId, readonly string[]>>>;
  /** Tenant `identity_admin` plus the core identity Actions needed to create the bot and its API key. */
  readonly identityAdmin: boolean;
  readonly label: string;
  readonly modules: Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;
  /** Modules opened without the generic read_all/write_all grants (only `contextPermissions` apply). */
  readonly restrictedModules?: readonly DemoModuleId[];
}

export const demoRoles = {
  accountant: {
    identityAdmin: false,
    label: 'Účetní',
    modules: {
      'commerce.customer-context': 'read',
      // Invoice lines pick products; without this read the create form's product list fails to load.
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      // Customer lists show Štítky; without this read every tag cell fails to load for the accountant.
      'demo.tagging': 'read',
      'party.registry': 'read',
      'legal.agreements': 'read',
      'finance.billing': 'write',
    },
  },
  agentBot: {
    identityAdmin: false,
    label: 'Agent (bot)',
    modules: {
      'commerce.customer-context': 'read',
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      'demo.sales-pipeline': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'read',
      'party.registry': 'read',
      'legal.agreements': 'read',
      'finance.billing': 'read',
      'work.tasks': 'write',
    },
  },
  headOfSales: { identityAdmin: true, label: 'Vedoucí obchodu', modules: everything },
  salesRep: {
    identityAdmin: false,
    label: 'Obchodník',
    // Billing is visible but not writable: the rep cannot confirm or void invoices.
    modules: {
      'commerce.customer-context': 'write',
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      'demo.sales-pipeline': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'read',
      'party.registry': 'write',
      'legal.agreements': 'write',
      'finance.billing': 'read',
      'work.tasks': 'write',
    },
  },
  warehouse: {
    identityAdmin: false,
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
  principalId: demoId('core.principal', key),
  role,
});

/** Human demo accounts; password `password1234`. Principal IDs are stable for workforce `principalRef`s. */
export const demoHumanAccounts = [
  human('obchod', 'Vedoucí obchodu', 'headOfSales'),
  human('obchodnik', 'Obchodník', 'salesRep'),
  human('ucetni', 'Účetní', 'accountant'),
  human('sklad', 'Skladník', 'warehouse'),
] as const;

/** Service principal used by the agent MCP server through a managed API key. */
export const agentBotPrincipal = {
  displayName: 'agent-bot',
  kind: 'service',
  principalId: demoId('core.principal', 'agent-bot'),
  role: 'agentBot',
} as const;

/** Core identity Actions the identity administrator runs to create the bot and manage its API key. */
const identityAdminActionKeys = [
  'core.identity.bind-managed-api-key',
  'core.identity.create-non-human-principal',
  'core.identity.configure-demo-companies',
  'core.identity.manage-demo-account',
  'core.identity.set-managed-api-key-binding-status',
] as const;

export interface DemoAction {
  readonly actionKey: string;
  readonly provisioning: 'explicit' | 'tenant_membership_default';
}

export interface DemoRelationship {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

/** Action keys owned by a module (`party.registry.create-party`, `demo.tagging.apply-command`, ...). */
export const moduleActions = (actions: readonly DemoAction[], moduleId: string) =>
  actions.filter(({ actionKey }) => actionKey.startsWith(`${moduleId}.`));

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

const moduleAccessObject = (legalEntityId: string, moduleId: string) =>
  toModuleAccessObjectId(demoTenantId, legalEntityId, moduleId) ?? '';

/** Every relationship one principal needs for its role. `actions` is the current discovered Action set. */
export const principalRelationships = (
  principalId: string,
  role: DemoRole,
  actions: readonly DemoAction[],
  legalEntityId: string = demoLegalEntityId,
): readonly DemoRelationship[] => {
  const result: DemoRelationship[] = [];
  const add = (resourceType: string, resourceId: string, relation: string, subjectType: string, subjectId: string) =>
    result.push({ relation, resourceId, resourceType, subjectId, subjectType });
  const grantAction = ({ actionKey, provisioning }: DemoAction) => {
    const action = toSpiceDbActionObjectId(actionKey);
    if (provisioning === 'explicit') {
      add('action', action, 'restriction', 'action', action);
    }
    add('action', action, 'executor', 'principal', principalId);
  };
  const grantContextPermission = (moduleId: DemoModuleId, permission: string) => {
    const objectId = toContextPermissionAccessObjectId(demoTenantId, legalEntityId, { moduleId, permission }) ?? '';
    add('context_permission', objectId, 'tenant', 'tenant', demoTenantId);
    add('context_permission', objectId, 'grantee', 'principal', principalId);
  };
  const legal = toLegalEntityAccessObjectId(demoTenantId, legalEntityId) ?? '';
  const moduleAccess = (moduleId: string) => moduleAccessObject(legalEntityId, moduleId);
  add('legal_entity', legal, 'tenant', 'tenant', demoTenantId);
  add('tenant', demoTenantId, 'member', 'principal', principalId);
  add('legal_entity', legal, 'member', 'principal', principalId);
  for (const moduleId of ['core.shell', ...(role.identityAdmin ? ['core.identity'] : [])]) {
    add('module_access', moduleAccess(moduleId), 'legal_entity', 'legal_entity', legal);
    add('module_access', moduleAccess(moduleId), 'accessor', 'principal', principalId);
  }
  for (const moduleId of demoModuleIds) {
    const access = role.modules[moduleId];
    if (access === undefined) {
      continue;
    }
    add('module_access', moduleAccess(moduleId), 'legal_entity', 'legal_entity', legal);
    add('module_access', moduleAccess(moduleId), 'accessor', 'principal', principalId);
    if (contextPermissionModules.has(moduleId) && !(role.restrictedModules ?? []).includes(moduleId)) {
      for (const level of access === 'write' ? (['read', 'write'] as const) : (['read'] as const)) {
        grantContextPermission(moduleId, contextPermissionKey(moduleId, level));
      }
    }
    for (const permission of [...moduleReadPermissions(moduleId), ...(role.contextPermissions?.[moduleId] ?? [])]) {
      grantContextPermission(moduleId, permission);
    }
    if (moduleId === 'party.registry') {
      const relations = partyRelations(access);
      for (const relation of relations.tenant) {
        add('tenant', demoTenantId, relation, 'principal', principalId);
      }
      for (const relation of relations.legalEntity) {
        add('legal_entity', legal, relation, 'principal', principalId);
      }
    }
    if (access === 'write') {
      for (const action of moduleActions(actions, moduleId)) {
        grantAction(action);
      }
    }
  }
  if (role.identityAdmin) {
    add('tenant', demoTenantId, 'identity_admin', 'principal', principalId);
    for (const actionKey of identityAdminActionKeys) {
      const action = actions.find((candidate) => candidate.actionKey === actionKey);
      grantAction(action ?? { actionKey, provisioning: 'tenant_membership_default' });
    }
  }
  return result;
};

/** Rental capabilities are granted independently from the trading company's modules. */
export const rentalDemoRoles = {
  accountant: {
    identityAdmin: false,
    label: 'Účetní pronájmů',
    modules: {
      'commerce.customer-context': 'read',
      'demo.tagging': 'read',
      'party.registry': 'read',
      'legal.agreements': 'read',
      'finance.billing': 'write',
      // S10-03: the accountant opens the lease and sees the agreed rent and its contract.
      'property.leasing': 'read',
      'property.portfolio': 'read',
    },
  },
  agentBot: {
    identityAdmin: false,
    label: 'Agent pronájmů',
    modules: {
      'commerce.customer-context': 'read',
      'demo.sales-pipeline': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'read',
      'party.registry': 'read',
      'legal.agreements': 'read',
      'finance.billing': 'read',
      'property.portfolio': 'read',
      'work.tasks': 'write',
    },
  },
  headOfSales: {
    identityAdmin: true,
    label: 'Správce pronájmů',
    modules: {
      'commerce.customer-context': 'write',
      'demo.sales-insights': 'read',
      'demo.sales-pipeline': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'read',
      'party.registry': 'write',
      'legal.agreements': 'write',
      'finance.billing': 'write',
      'property.leasing': 'write',
      'property.portfolio': 'write',
      'work.tasks': 'write',
    },
  },
  salesRep: {
    identityAdmin: false,
    label: 'Obchodník pronájmů',
    modules: {
      'commerce.customer-context': 'write',
      'demo.sales-insights': 'read',
      'demo.sales-pipeline': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'read',
      'party.registry': 'write',
      'legal.agreements': 'write',
      'finance.billing': 'read',
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
  identityAdmin: false,
  modules: { ...role.modules, 'facility.operations': 'write' },
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
        'facility.operations': ['facility.operations.read_operational'],
      },
      identityAdmin: false,
      label: 'Externí partner',
      modules: { 'demo.crm': 'read', 'demo.sales-pipeline': 'read', 'facility.operations': 'write' },
      restrictedModules: ['demo.crm', 'demo.sales-pipeline', 'facility.operations'],
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
    contextPermissions: { 'demo.crm': crmManagerPermissions },
    identityAdmin: true,
    label: 'Správce',
    modules: {
      'commerce.customer-context': 'write',
      'demo.crm': 'write',
      'demo.tagging': 'write',
      'demo.workforce': 'write',
      'party.registry': 'write',
      'work.tasks': 'write',
    },
  },
  crmManager: {
    contextPermissions: { 'demo.crm': crmManagerPermissions },
    identityAdmin: false,
    label: 'Vedoucí obchodu',
    modules: {
      'commerce.customer-context': 'read',
      'demo.crm': 'write',
      'demo.tagging': 'read',
      'demo.workforce': 'write',
      'party.registry': 'read',
      'work.tasks': 'write',
    },
  },
  crmRep: {
    contextPermissions: { 'demo.crm': crmRepPermissions },
    identityAdmin: false,
    label: 'Obchodník',
    // No party.registry: its customer list is company-wide and would bypass the assigned-client filter.
    modules: { 'demo.crm': 'write', 'demo.workforce': 'read', 'work.tasks': 'write' },
  },
} as const satisfies Readonly<Record<string, DemoRole>>;

/** E-shop company „Kavárna Doma s.r.o.“ (0023). */
export const eshopDemoRoles = {
  akrosAdmin: {
    identityAdmin: true,
    label: 'Správce e-shopu',
    modules: {
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      'party.registry': 'write',
      'work.tasks': 'write',
      'demo.workforce': 'write',
    },
  },
  eshopAdmin: {
    identityAdmin: false,
    label: 'Správce e-shopu',
    modules: {
      'commerce.customer-context': 'read',
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      'demo.workforce': 'write',
      'party.registry': 'write',
      'work.tasks': 'write',
    },
  },
  fulfilment: { identityAdmin: false, label: 'Expedice', modules: { 'demo.merchandise': 'write' } },
  /** Non-human storefront BFF: merchandise reads and the apply-command Action (PlaceStorefrontOrder). */
  storefront: { identityAdmin: false, label: 'Storefront (API)', modules: { 'demo.merchandise': 'write' } },
} as const satisfies Readonly<Record<string, DemoRole>>;

type CompanyRoleKey = keyof typeof crmDemoRoles | keyof typeof eshopDemoRoles;
const companyRoles: Readonly<Record<CompanyRoleKey, DemoRole>> = { ...crmDemoRoles, ...eshopDemoRoles };

const persona = (key: string, email: string, displayName: string, legalEntityId: string, role: CompanyRoleKey) => ({
  authBindingId: demoId('core.auth-binding', key),
  authUserId: `demo-${key}`,
  displayName,
  email,
  legalEntityId,
  principalId: demoId('core.principal', key),
  role,
});

/** Human accounts of the CRM and e-shop companies (password `password1234`); each belongs to one company only. */
export const companyHumanAccounts = [
  persona('hanak-spravce', 'spravce@hanak.demo', 'Karel Hanák', crmDemoLegalEntityId, 'crmAdmin'),
  persona('hanak-vedouci', 'vedouci@hanak.demo', 'Lucie Dvořáková', crmDemoLegalEntityId, 'crmManager'),
  persona('hanak-obchodnik-a', 'obchodnik.a@hanak.demo', 'Jan Novák', crmDemoLegalEntityId, 'crmRep'),
  persona('hanak-obchodnik-b', 'obchodnik.b@hanak.demo', 'Petra Svobodová', crmDemoLegalEntityId, 'crmRep'),
  persona('kavarna-eshop', 'eshop@kavarna.demo', 'Tereza Malá', eshopDemoLegalEntityId, 'eshopAdmin'),
  persona('akros-eshop', 'eshop@akros.demo', 'Správce e-shopu', akrosDemoLegalEntityId, 'akrosAdmin'),
  persona('akros-expedice', 'expedice@akros.demo', 'Expedice', akrosDemoLegalEntityId, 'fulfilment'),
  persona('kavarna-expedice', 'expedice@kavarna.demo', 'Ondřej Kříž', eshopDemoLegalEntityId, 'fulfilment'),
] as const;

/** Stable principal IDs of the CRM personas, e.g. for client assignments in the crm seed. */
export const crmPersonaPrincipalIds = {
  manager: demoId('core.principal', 'hanak-vedouci'),
  repA: demoId('core.principal', 'hanak-obchodnik-a'),
  repB: demoId('core.principal', 'hanak-obchodnik-b'),
  spravce: demoId('core.principal', 'hanak-spravce'),
} as const;

/** Service principal of the e-shop storefront BFF; its managed API key lands in `app/.env.demo.local`. */
export const storefrontPrincipal = {
  displayName: 'kavarna-storefront',
  kind: 'service',
  legalEntityId: eshopDemoLegalEntityId,
  principalId: demoId('core.principal', 'kavarna-storefront'),
  role: 'storefront',
} as const;

export const akrosStorefrontPrincipal = {
  displayName: 'akros-storefront',
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId('core.principal', 'akros-storefront'),
  role: 'storefront',
} as const;

export const companyPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => [
  ...companyHumanAccounts.flatMap((account) =>
    principalRelationships(account.principalId, companyRoles[account.role], actions, account.legalEntityId),
  ),
  ...principalRelationships(
    akrosStorefrontPrincipal.principalId,
    companyRoles.storefront,
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

const relationshipKey = (relationship: DemoRelationship) =>
  [
    relationship.resourceType,
    relationship.resourceId,
    relationship.relation,
    relationship.subjectType,
    relationship.subjectId,
  ].join('|');

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
