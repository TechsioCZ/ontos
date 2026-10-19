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

import { demoId, demoLegalEntityId, demoTenantId, rentalDemoLegalEntityId } from './fixture-ids.mts';

/**
 * Module IDs as declared in each `vertical.manifest.ts`. Vertical directories: party-registry, siampark-work,
 * siampark-billing-finance, workforce, tagging, sales-pipeline, merchandise, sales-insights, commerce-customer-context.
 */
export const demoModuleIds = [
  'commerce.customer-context',
  'party.registry',
  'siampark.work',
  'siampark.billing-finance',
  'demo.workforce',
  'demo.tagging',
  'demo.sales-pipeline',
  'demo.merchandise',
  'demo.sales-insights',
  'siampark.property',
  'siampark.occupancy',
  'siampark.agreements',
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
  'siampark.work',
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
  'siampark.agreements': 'write',
  'siampark.billing-finance': 'write',
  'siampark.work': 'write',
} as const satisfies Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;

export interface DemoRole {
  /** Tenant `identity_admin` plus the core identity Actions needed to create the bot and its API key. */
  readonly identityAdmin: boolean;
  readonly label: string;
  readonly modules: Readonly<Partial<Record<DemoModuleId, ModuleAccess>>>;
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
      'siampark.agreements': 'read',
      'siampark.billing-finance': 'write',
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
      'siampark.agreements': 'read',
      'siampark.billing-finance': 'read',
      'siampark.work': 'write',
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
      'siampark.agreements': 'write',
      'siampark.billing-finance': 'read',
      'siampark.work': 'write',
    },
  },
  warehouse: {
    identityAdmin: false,
    label: 'Skladník',
    modules: { 'demo.merchandise': 'write', 'siampark.work': 'write' },
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
    if (contextPermissionModules.has(moduleId)) {
      for (const level of access === 'write' ? (['read', 'write'] as const) : (['read'] as const)) {
        grantContextPermission(moduleId, contextPermissionKey(moduleId, level));
      }
    }
    for (const permission of moduleReadPermissions(moduleId)) {
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
      'siampark.agreements': 'read',
      'siampark.billing-finance': 'write',
      // S10-03: the accountant opens the lease and sees the agreed rent and its contract.
      'siampark.occupancy': 'read',
      'siampark.property': 'read',
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
      'siampark.agreements': 'read',
      'siampark.billing-finance': 'read',
      'siampark.property': 'read',
      'siampark.work': 'write',
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
      'siampark.agreements': 'write',
      'siampark.billing-finance': 'write',
      'siampark.occupancy': 'write',
      'siampark.property': 'write',
      'siampark.work': 'write',
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
      'siampark.agreements': 'write',
      'siampark.billing-finance': 'read',
      'siampark.occupancy': 'read',
      'siampark.property': 'read',
      'siampark.work': 'write',
    },
  },
} as const satisfies Readonly<Partial<Record<DemoRoleKey, DemoRole>>>;

export const rentalPermissionRelationships = (actions: readonly DemoAction[]): readonly DemoRelationship[] => [
  ...demoHumanAccounts.flatMap((account) =>
    account.role === 'warehouse'
      ? []
      : principalRelationships(account.principalId, rentalDemoRoles[account.role], actions, rentalDemoLegalEntityId),
  ),
  ...principalRelationships(agentBotPrincipal.principalId, rentalDemoRoles.agentBot, actions, rentalDemoLegalEntityId),
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
  ];
  return [...new Map(all.map((relationship) => [relationshipKey(relationship), relationship])).values()];
};
