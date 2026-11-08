import type { DemoRole } from './permissions.mts';
import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';

/** Reviewed source facts, not request scope. AKROS includes its separately identified playground company. */
export const merchandiseRestrictedCompanyIds = [
  akrosDemoLegalEntityId,
  'c0c78a3e-6e2a-57e0-9d0d-86253499fee7',
] as const;
const merchandiseModule = 'demo.merchandise';
const merchandiseProposal = 'demo.merchandise.order-changes.propose';
const merchandiseOperationalActions = [
  'demo.merchandise.product-images.change',
  'demo.merchandise.stock-movement.record',
  'demo.merchandise.order-status.change',
] as const;
const merchandiseOrdinaryActions = [
  'demo.merchandise.apply-command.write',
  'demo.merchandise.catalog.manage',
  'demo.merchandise.order-changes.review',
  'demo.merchandise.storefront-order.place',
] as const;

/** Pin navigation and company-wide reads independently of writes. No new Action enters through module WRITE. */
const ownerReadCapabilities = {
  'demo.merchandise': [
    'demo.merchandise.api-agent-review.read',
    'demo.merchandise.api-media.read',
    'demo.merchandise.api-records.read',
    'demo.merchandise.navigation-orders.read',
    'demo.merchandise.navigation-records.read',
    'demo.merchandise.page-merchandise-home.read',
    'demo.merchandise.page-orders.read',
    'demo.merchandise.page-product-detail.read',
    'demo.merchandise.page-products.read',
    'demo.merchandise.search-orders.read',
    'demo.merchandise.search-products.read',
  ],
  'demo.sales-insights': [
    'demo.sales-insights.api-records.read',
    'demo.sales-insights.component-crm-dashboard.read',
    'demo.sales-insights.navigation-records.read',
    'demo.sales-insights.page-records.read',
    'demo.sales-insights.page-sales-insights-home.read',
  ],
  'demo.tagging': [
    'demo.tagging.api-records.read',
    'demo.tagging.navigation-records.read',
    'demo.tagging.page-records.read',
    'demo.tagging.page-tagging-home.read',
  ],
  'demo.workforce': [
    'demo.workforce.api-records.read',
    'demo.workforce.navigation-records.read',
    'demo.workforce.page-records.read',
    'demo.workforce.page-workforce-home.read',
    'demo.workforce.search-employees.read',
  ],
} as const;
const ownerModules = ['demo.merchandise', 'demo.sales-insights', 'demo.tagging', 'demo.workforce'] as const;

/** Parent-reviewed parity with immutable 71ac40f8's exact company context-write grants, not module WRITE. */
export const recoveredRecordActions = {
  'demo.sales-insights': [
    'demo.sales-insights.metric.update',
    'demo.sales-insights.metric.assign',
    'demo.sales-insights.metric-state.change',
  ],
  'demo.tagging': [
    'demo.tagging.tag.update',
    'demo.tagging.tag.delete',
    'demo.tagging.tag.assign',
    'demo.tagging.tag.unassign',
  ],
  'demo.workforce': ['demo.workforce.employee.update'],
} as const;
type RecordModule = keyof typeof recoveredRecordActions;
export interface ReviewedRoleSource {
  readonly principalId: string;
  readonly tenantId: string;
}
interface RecoveredContextGrant {
  readonly legalEntityId: string;
  readonly modules: readonly RecordModule[];
  readonly principalId: string;
  readonly workforceAdministrator?: true;
}
const workforceModule = 'demo.workforce';
const taggingModule = 'demo.tagging';
const insightsModule = 'demo.sales-insights';
const person = (key: string) => demoId('core.principal', key);
const management = '72000000-0000-4000-8000-000000000021';
const operations = '72000000-0000-4000-8000-000000000022';
const provoz = '72000000-0000-4000-8000-000000000025';
/**
 * permissions.mts at 71ac40f8:148-208,369-414,534-540,552-617,627-688,692-735,751-859.
 * reset-demo.mts:65-94 separately proves company020's operations/provoz grants. No inferred admin grants
 * for Tagging/Insights, no service identities, and no record IDs invented for resource-relation fallbacks.
 */
const recoveredContextGrants: readonly RecoveredContextGrant[] = [
  {
    legalEntityId: demoLegalEntityId,
    modules: [workforceModule, taggingModule, insightsModule],
    principalId: person('obchod'),
    workforceAdministrator: true,
  },
  { legalEntityId: demoLegalEntityId, modules: [taggingModule], principalId: person('obchodnik') },
  {
    legalEntityId: demoLegalEntityId,
    modules: [workforceModule, taggingModule, insightsModule],
    principalId: operations,
  },
  { legalEntityId: demoLegalEntityId, modules: [workforceModule, taggingModule, insightsModule], principalId: provoz },
  {
    legalEntityId: rentalDemoLegalEntityId,
    modules: [taggingModule],
    principalId: person('obchod'),
    workforceAdministrator: true,
  },
  { legalEntityId: rentalDemoLegalEntityId, modules: [taggingModule], principalId: person('obchodnik') },
  {
    legalEntityId: rentalDemoLegalEntityId,
    modules: [taggingModule],
    principalId: management,
    workforceAdministrator: true,
  },
  { legalEntityId: rentalDemoLegalEntityId, modules: [taggingModule], principalId: operations },
  { legalEntityId: rentalDemoLegalEntityId, modules: [taggingModule], principalId: provoz },
  {
    legalEntityId: crmDemoLegalEntityId,
    modules: [workforceModule, taggingModule],
    principalId: person('hanak-spravce'),
    workforceAdministrator: true,
  },
  { legalEntityId: crmDemoLegalEntityId, modules: [workforceModule], principalId: person('hanak-vedouci') },
  {
    legalEntityId: eshopDemoLegalEntityId,
    modules: [workforceModule],
    principalId: person('kavarna-eshop'),
    workforceAdministrator: true,
  },
  {
    legalEntityId: akrosDemoLegalEntityId,
    modules: [workforceModule],
    principalId: person('sroubarna-eshop'),
    workforceAdministrator: true,
  },
];

const recoveredActions = (
  role: DemoRole,
  moduleKey: RecordModule,
  legalEntityId: string | undefined,
  source: ReviewedRoleSource | undefined,
): readonly string[] => {
  if (source?.tenantId !== demoTenantId || role.actorKind === 'agent') {
    return [];
  }
  const evidence = recoveredContextGrants.find(
    (row) => row.legalEntityId === legalEntityId && row.principalId === source.principalId,
  );
  if (evidence === undefined) {
    return [];
  }
  if (moduleKey === workforceModule && evidence.workforceAdministrator === true && role.companyAdmin === true) {
    return recoveredRecordActions[moduleKey];
  }
  if (!evidence.modules.includes(moduleKey)) {
    return [];
  }
  const unrestrictedWriter = role.modules[moduleKey] === 'write' && !(role.restrictedModules ?? []).includes(moduleKey);
  // A second materialization keeps only already-explicit RUN/ALL cells with the same proven source grant.
  return recoveredRecordActions[moduleKey].filter(
    (key) =>
      unrestrictedWriter ||
      (role.capabilityKeys?.[moduleKey]?.includes(key) === true &&
        role.capabilityModes?.[key]?.length === 1 &&
        role.capabilityModes[key][0] === 'run' &&
        role.capabilitySelectors?.[key] === 'all'),
  );
};

const merchandiseActions = (role: DemoRole, legalEntityId: string | undefined): readonly string[] => {
  if (legalEntityId === undefined) {
    return [];
  }
  // AiProposeChanges was a reader operation. This RUN creates a business proposal, not a native Action proposal.
  const actions: string[] = [merchandiseProposal];
  if (role.modules[merchandiseModule] !== 'write') {
    return actions;
  }
  actions.push(...merchandiseOperationalActions);
  const restrictedCompany = merchandiseRestrictedCompanyIds.some((company) => company === legalEntityId);
  if (!restrictedCompany || role.tenantOwner === true) {
    actions.push(...merchandiseOrdinaryActions);
  }
  if (!restrictedCompany || role.tenantOwner === true || role.companyAdmin === true) {
    actions.push('demo.merchandise.markets.manage');
  }
  // The owner still checks ResetDemoData's exact company024 constraint inside the closed cleanup Action.
  if (role.tenantOwner === true) {
    actions.push('demo.merchandise.demo.cleanup');
  }
  return actions;
};

/**
 * Materialize an abstract demo recipe only in its trusted source company. Recovered exact-target cells use
 * reviewed source evidence, while maintenance stays absent. FullAccessRole is a separate Core recipe.
 * Human-only review checks and per-command constraints remain in the actual owner's native lifecycle.
 */
export const reviewedCompanyRole = (role: DemoRole, legalEntityId?: string, source?: ReviewedRoleSource): DemoRole => {
  const modules = ownerModules.filter((moduleKey) => role.modules[moduleKey] !== undefined);
  if (modules.length === 0) {
    return role;
  }
  const capabilityKeys = { ...role.capabilityKeys };
  const capabilitySelectors = { ...role.capabilitySelectors };
  const modeEntries = Object.entries(role.capabilityModes ?? {}).filter(
    ([key]) => !modules.some((moduleKey) => key.startsWith(`${moduleKey}.`)),
  );
  for (const moduleKey of modules) {
    let actions: readonly string[] = [];
    if (moduleKey === merchandiseModule) {
      actions = merchandiseActions(role, legalEntityId);
    } else if (
      role.modules[moduleKey] === 'write' &&
      legalEntityId !== undefined &&
      (!(role.restrictedModules ?? []).includes(moduleKey) ||
        role.capabilityKeys?.[moduleKey]?.includes(`${moduleKey}.apply-command.write`) === true)
    ) {
      actions = [`${moduleKey}.apply-command.write`];
    }
    if (moduleKey !== merchandiseModule) {
      const recovered = recoveredActions(role, moduleKey, legalEntityId, source);
      actions = [...actions, ...recovered];
      for (const key of recovered) {
        capabilitySelectors[key] = 'all';
      }
    }
    capabilityKeys[moduleKey] = [...ownerReadCapabilities[moduleKey], ...actions];
    // No native PROPOSE/APPROVE is inferred from a business verb or from proposalReview.
    for (const key of actions) {
      modeEntries.push([key, ['run']]);
    }
  }
  return {
    ...role,
    capabilityKeys,
    capabilityModes: Object.fromEntries(modeEntries),
    capabilitySelectors,
    restrictedModules: [...new Set([...(role.restrictedModules ?? []), ...modules])],
  };
};
