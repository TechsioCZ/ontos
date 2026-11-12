/**
 * Reviewed demo identity, Role and company assignment intent. reset-permissions.mts compiles these
 * cells against the generated catalog and applies them through Core's canonical bootstrap.
 * Restricted modules name their data and field capabilities explicitly, independent of navigation.
 */
import type { ModuleAccess, PolicyActorKind, PolicyRole } from './access-policy.mts';
import { reviewedCompanyRole } from './reviewed-owner-role.mts';

import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  demoTenantId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';

export type { ModuleAccess } from './access-policy.mts';

const commerceModule = 'commerce.customer-context';
const partyModule = 'party.registry';
const workforceModule = 'demo.workforce';
const operationsModule = 'facility.operations';
const marketModule = 'commerce.market-catalog';
const storefrontRegistryModule = 'commerce.storefront-registry';
const crmModule = 'demo.crm';
const pipelineModule = 'demo.sales-pipeline';
const principalResource = 'core.principal';
const taxModule = 'commerce.tax';

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
  crmModule,
  'crm.activities',
  operationsModule,
  marketModule,
  storefrontRegistryModule,
  taxModule,
] as const;
export type DemoModuleId = (typeof demoModuleIds)[number];

/**
 * One reviewed demo role. Its vocabulary is the reviewed matrix's own: which modules a person reaches, at
 * read or write, which capabilities are named explicitly, which modules stay restricted to exactly those,
 * whether the person reviews proposals, and whether the person is a company administrator or the tenant owner.
 */
export interface DemoRole {
  /** The person runs; an agent proposes the sensitive and critical work and runs only the routine. */
  readonly actorKind?: PolicyActorKind;
  /** Explicit capability keys a role names on top of its module access, by module. */
  readonly capabilityKeys?: PolicyRole['capabilityKeys'];
  readonly capabilityModes?: PolicyRole['capabilityModes'];
  readonly capabilitySelectors?: PolicyRole['capabilitySelectors'];
  /** Company administration: `access_admin` in the company scope, on top of the role's own cells. */
  readonly companyAdmin?: true;
  readonly label: string;
  readonly modules: Readonly<Record<string, ModuleAccess>>;
  /** The one reviewed capability a proposal reviewer approves, at its declared `approve` mode. */
  readonly proposalReview?: true;
  /** Modules opened without their generic capability set: only `capabilityKeys` apply. */
  readonly restrictedModules?: readonly string[];
  /** Tenant ownership: the `owner` membership in the tenant-context scope. */
  readonly tenantOwner?: true;
}

export const pipelineReadCapability = 'demo.sales-pipeline.api-records.read';
export const pipelineWriteCapability = 'demo.sales-pipeline.apply-command.write';
export const pipelineEntrustCapability = 'demo.sales-pipeline.opportunity-entrust.assign';
export const pipelineSearchCapability = 'demo.sales-pipeline.search-opportunities.read';
/** Navigation alone never grants records or entrustment administration. */
export const pipelineRecordNavigationKeys = [
  'demo.sales-pipeline.page-sales-pipeline-home.read',
  'demo.sales-pipeline.navigation-records.read',
  'demo.sales-pipeline.page-records.read',
];
/** Ordinary writers retain their existing agenda, AI page and search, but cannot reassign entrustment. */
export const pipelineWriterKeys = [
  ...pipelineRecordNavigationKeys,
  'demo.sales-pipeline.navigation-ai.read',
  'demo.sales-pipeline.page-ai.read',
  pipelineReadCapability,
  pipelineWriteCapability,
  pipelineSearchCapability,
];

/** Reviewed existing human Party reads. CRM workload-purpose reads are deliberately absent. */
export const partyHumanReaderKeys = [
  'party.registry.ares-subject.lookup',
  'party.registry.contact-point-value.list',
  'party.registry.contact-point-value.read',
  'party.registry.contact-point.list',
  'party.registry.contact-point.read',
  'party.registry.contacts-page.open',
  'party.registry.counterparty-identity.read',
  'party.registry.counterparty-role.read-history',
  'party.registry.counterparty-search-identity.read',
  'party.registry.counterparty.read',
  'party.registry.counterparty.search',
  'party.registry.customer-detail-page.open',
  'party.registry.customer.list',
  'party.registry.customers-page.open',
  'party.registry.duplicate-candidate.list',
  'party.registry.duplicate-candidate.read',
  'party.registry.guest-party.resolve',
  'party.registry.identity-review-evidence.read',
  'party.registry.official-identifier-value.read',
  'party.registry.official-identifier-value.read-history',
  'party.registry.official-identifier.read',
  'party.registry.official-identifier.read-history',
  'party.registry.organization-engagement.read',
  'party.registry.owned-command-result.read',
  'party.registry.party-correction-authority.read',
  'party.registry.party-correction-evidence.read',
  'party.registry.party-correction.read',
  'party.registry.party-identity-page.open',
  'party.registry.party-identity.read',
  'party.registry.party-match-decision-evidence.read',
  'party.registry.party-match.preview',
  'party.registry.party-match.read',
  'party.registry.party-merge.read-readiness',
  'party.registry.party-relationship.read',
  'party.registry.party-search-identity.read',
  'party.registry.party.read',
  'party.registry.party.search',
  'party.registry.person-engagement.read',
  'party.registry.privacy-measure.read-receipt',
  'party.registry.search-label-value.read',
  'party.registry.search-label.read',
] as const;
/** Reviewed existing human Party capabilities. The new CRM workload purposes are deliberately absent. */
export const partyHumanWriterKeys = [
  'party.registry.ares-subject.lookup',
  'party.registry.contact-point-value.list',
  'party.registry.contact-point-value.read',
  'party.registry.contact-point.add',
  'party.registry.contact-point.end',
  'party.registry.contact-point.list',
  'party.registry.contact-point.read',
  'party.registry.contact-point.update',
  'party.registry.contacts-page.open',
  'party.registry.counterparty-identity.read',
  'party.registry.counterparty-role.add',
  'party.registry.counterparty-role.end',
  'party.registry.counterparty-role.read-history',
  'party.registry.counterparty-search-identity.read',
  'party.registry.counterparty.create',
  'party.registry.counterparty.onboard',
  'party.registry.counterparty.read',
  'party.registry.counterparty.search',
  'party.registry.customer-detail-page.open',
  'party.registry.customer.list',
  'party.registry.customers-page.open',
  'party.registry.duplicate-candidate.confirm',
  'party.registry.duplicate-candidate.dismiss',
  'party.registry.duplicate-candidate.list',
  'party.registry.duplicate-candidate.read',
  'party.registry.duplicate-candidate.request-evidence',
  'party.registry.duplicate-candidate.resolve-create',
  'party.registry.duplicate-candidate.resolve-match',
  'party.registry.guest-party.resolve',
  'party.registry.identity-review-evidence.read',
  'party.registry.official-identifier-value.read',
  'party.registry.official-identifier-value.read-history',
  'party.registry.official-identifier.add',
  'party.registry.official-identifier.end',
  'party.registry.official-identifier.read',
  'party.registry.official-identifier.read-history',
  'party.registry.official-identifier.update',
  'party.registry.organization-engagement.archive',
  'party.registry.organization-engagement.attach',
  'party.registry.organization-engagement.read',
  'party.registry.organization-engagement.unarchive',
  'party.registry.owned-command-result.read',
  'party.registry.party-correction-authority.read',
  'party.registry.party-correction-evidence.read',
  'party.registry.party-correction.read',
  'party.registry.party-fact.correct',
  'party.registry.party-identity-page.open',
  'party.registry.party-identity.read',
  'party.registry.party-match-decision-evidence.read',
  'party.registry.party-match.preview',
  'party.registry.party-match.read',
  'party.registry.party-match.record',
  'party.registry.party-merge.read-readiness',
  'party.registry.party-relationship.create',
  'party.registry.party-relationship.end',
  'party.registry.party-relationship.read',
  'party.registry.party-relationship.update',
  'party.registry.party-search-identity.read',
  'party.registry.party.archive',
  'party.registry.party.create',
  'party.registry.party.read',
  'party.registry.party.search',
  'party.registry.party.unarchive',
  'party.registry.party.update',
  'party.registry.person-engagement.archive',
  'party.registry.person-engagement.attach',
  'party.registry.person-engagement.read',
  'party.registry.person-engagement.unarchive',
  'party.registry.privacy-measure.execute',
  'party.registry.privacy-measure.read-receipt',
  'party.registry.search-index.rebuild',
  'party.registry.search-label-value.read',
  'party.registry.search-label.read',
] as const;

/**
 * VAT reads for people who pick a VAT classification (products, order lines): which rules apply and whether the
 * company is a VAT payer. Nothing about order-tax evidence or the privacy coverage of tax data.
 */
export const taxReaderKeys = [
  'commerce.tax.seller-vat-regime.read-at-instant',
  'commerce.tax.tax-rule-set.read',
] as const;
/**
 * VAT administration of the accountant: the rules and the seller's VAT regime, with their histories. Order-tax
 * finalization is a service call of commerce-order and the regime import is a migration tool; neither is here.
 */
export const taxManagerKeys = [
  ...taxReaderKeys,
  'commerce.tax.seller-vat-regime-declaration.declare',
  'commerce.tax.seller-vat-regime-declaration.read-history',
  'commerce.tax.tax-rule-revision.correct',
  'commerce.tax.tax-rule-revision.create',
  'commerce.tax.tax-rule-revision.end',
  'commerce.tax.tax-rule.create',
  'commerce.tax.tax-rule.read-history',
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
} as const satisfies Readonly<Record<string, ModuleAccess>>;

export const demoRoles = {
  accountant: {
    capabilityKeys: { [partyModule]: partyHumanReaderKeys, [taxModule]: taxManagerKeys },
    label: 'Účetní',
    modules: {
      [commerceModule]: 'read',
      // Rates and the seller's VAT regime: read and manage, through the explicit tax keys only.
      [taxModule]: 'write',
      // Invoice lines pick products; without this read the create form's product list fails to load.
      'demo.merchandise': 'read',
      'demo.sales-insights': 'read',
      // Customer lists show Štítky; without this read every tag cell fails to load for the accountant.
      'demo.tagging': 'read',
      'finance.billing': 'write',
      'legal.agreements': 'read',
      [partyModule]: 'read',
      // Tasks assigned to her must be workable: every task command needs work.tasks.apply-command.write.
      'work.tasks': 'write',
    },
    proposalReview: true,
    restrictedModules: [partyModule, taxModule],
  },
  headOfSales: {
    capabilityKeys: { [partyModule]: partyHumanWriterKeys },
    companyAdmin: true,
    label: 'Vedoucí obchodu',
    modules: { ...everything, 'privacy.core': 'write' },
    proposalReview: true,
    restrictedModules: [partyModule],
    tenantOwner: true,
  },
  salesRep: {
    capabilityKeys: {
      [partyModule]: partyHumanWriterKeys,
      [pipelineModule]: pipelineWriterKeys,
      [taxModule]: taxReaderKeys,
    },
    label: 'Obchodník',
    proposalReview: true,
    restrictedModules: [pipelineModule, partyModule, taxModule],
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
      // Products carry a VAT classification: the rep reads which rates exist.
      [taxModule]: 'read',
      'work.tasks': 'write',
      [workforceModule]: 'read',
    },
  },
  warehouse: {
    capabilityKeys: { [taxModule]: taxReaderKeys },
    label: 'Skladník',
    // Product edits pick a VAT classification: the warehouse reads which rates exist.
    modules: { 'demo.merchandise': 'write', [taxModule]: 'read', 'work.tasks': 'write' },
    proposalReview: true,
    restrictedModules: [taxModule],
  },
} as const satisfies Readonly<Record<string, DemoRole>>;
export type DemoRoleKey = keyof typeof demoRoles;

/** Explicit local developer authority, isolated from every sales-demo tenant. */
export const localDevelopmentAdministratorFixture = {
  affiliation: 'employee',
  legalEntityId: '71000000-0000-4000-8000-000000000010',
  principalId: '72000000-0000-4000-8000-000000000010',
  role: { label: 'Local User', modules: {}, tenantOwner: true } satisfies DemoRole,
  tenantId: '70000000-0000-4000-8000-000000000010',
} as const;

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

/**
 * Service principal used by the agent MCP server through a managed API key. It holds **no** v2 Role: the
 * MCP bot is admitted by the gateway-delegation protocol (its key mints a single-use assertion for the
 * audience it calls), not by a grant. A reviewed Role for a machine identity would be the retired
 * scoped-role model under a new name (ADR-0030).
 */
export const agentBotPrincipal = {
  displayName: 'agent-bot',
  kind: 'service',
  principalId: demoId(principalResource, 'agent-bot'),
} as const;

/**
 * The reviewed Role key of one demo principal. Fixture labels only: authority stays entirely in the
 * Role's compiled cells. CRM representatives share one profile; every other human profile stays isolated.
 */
export const demoPrincipalRoleKey = (principalId: string): string => {
  const humanProfiles = {
    'hanak-obchodnik-a': 'crm-sales',
    'hanak-obchodnik-b': 'crm-sales',
    'hanak-spravce': 'crm-administration',
    'hanak-vedouci': 'crm-leadership',
    'kavarna-eshop': 'eshop-administration',
    'kavarna-expedice': 'fulfilment',
    obchod: 'sales-leadership',
    obchodnik: 'sales',
    sklad: 'warehouse',
    'sroubarna-eshop': 'eshop-administration',
    'sroubarna-expedice': 'fulfilment',
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

export const crmReadCapability = 'demo.crm.api-records.read';
export const crmWriteCapability = 'demo.crm.apply-command.write';
export const crmAssignCapability = 'demo.crm.client-owner.assign';
/** Navigation does not grant the underlying records or field groups. */
export const crmNavigationKeys = [
  ...['clients', 'visits', 'plan', 'imports', 'pairing', 'reports', 'ai'].flatMap((page) => [
    `demo.crm.navigation-${page}.read`,
    `demo.crm.page-${page}.read`,
  ]),
  'demo.crm.component-home-summary.read',
  'demo.crm.page-crm-home.read',
  'demo.crm.search-clients.read',
  'demo.crm.search-contacts.read',
];
const crmManagerKeys = [...crmNavigationKeys, crmReadCapability, crmWriteCapability, crmAssignCapability];
const crmRepKeys = [...crmNavigationKeys, crmReadCapability, crmWriteCapability];

/** Rental capabilities are granted independently from the trading company's modules. */
export const rentalDemoRoles = {
  accountant: {
    capabilityKeys: { [partyModule]: partyHumanReaderKeys },
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
    restrictedModules: [partyModule],
  },
  headOfSales: {
    capabilityKeys: { [partyModule]: partyHumanWriterKeys },
    companyAdmin: true,
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
    restrictedModules: [partyModule],
  },
  salesRep: {
    capabilityKeys: { [partyModule]: partyHumanWriterKeys, [pipelineModule]: pipelineWriterKeys },
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
    restrictedModules: [pipelineModule, partyModule],
  },
} as const satisfies Readonly<Partial<Record<DemoRoleKey, DemoRole>>>;

/**
 * The original Nájempark accounts (`scripts/siampark/fixtures.mts` demoAccounts, created by `pnpm demo:reset`) in
 * the Nájempark company 0021, each with the `facility.operations` agendas. The external agent sees operational
 * agendas only.
 */
export const facilityOperationalKeys = [
  'facility.operations.api-records.read',
  'facility.operations.api-overview.read',
  'facility.operations.page-facility-operations-home.read',
  ...['overview', 'agenda'].flatMap((page) => [
    `facility.operations.navigation-${page}.read`,
    `facility.operations.page-${page}.read`,
  ]),
];
/** The owner-declared, own-recipient/own-preferences Action, never the broad facility command. */
export const facilityPersonalAgendaCapability = 'facility.operations.personal-agenda.update';
export const facilityFullReaderKeys = [
  ...facilityOperationalKeys,
  'facility.operations.records-restricted.read',
  'facility.operations.apply-command.write',
  facilityPersonalAgendaCapability,
  ...['assets', 'meters', 'purchasing', 'security', 'documents'].flatMap((page) => [
    `facility.operations.navigation-${page}.read`,
    `facility.operations.page-${page}.read`,
  ]),
  ...['assets', 'devices', 'documents', 'meters'].map((resource) => `facility.operations.search-${resource}.read`),
];
const withFacilityOperations = (role: DemoRole): DemoRole => ({
  ...role,
  capabilityKeys: {
    ...role.capabilityKeys,
    [operationsModule]: facilityFullReaderKeys,
  },
  modules: { ...role.modules, [operationsModule]: 'write' },
  restrictedModules: [...(role.restrictedModules ?? []), operationsModule],
});
export const siamparkRentalPersonas = [
  {
    email: 'management@najempark.demo',
    principalId: '72000000-0000-4000-8000-000000000021',
    // S00: Vedení keeps every CRM contact and entrusts chosen ones to the external salesperson (demo.crm.client-owner.assign).
    role: (() => {
      const base = withFacilityOperations(rentalDemoRoles.headOfSales);
      return {
        ...base,
        capabilityKeys: { ...base.capabilityKeys, [crmModule]: crmManagerKeys },
        capabilitySelectors: { [crmReadCapability]: 'all' },
        modules: { ...base.modules, 'crm.activities': 'write', [crmModule]: 'write' },
        restrictedModules: [...(base.restrictedModules ?? []), crmModule],
      } satisfies DemoRole;
    })(),
  },
  {
    email: 'operations@najempark.demo',
    principalId: '72000000-0000-4000-8000-000000000022',
    role: withFacilityOperations(rentalDemoRoles.salesRep),
  },
  {
    email: 'finance@najempark.demo',
    principalId: '72000000-0000-4000-8000-000000000023',
    role: withFacilityOperations(rentalDemoRoles.accountant),
  },
  {
    email: 'external@najempark.demo',
    principalId: '72000000-0000-4000-8000-000000000024',
    // External partners read entrusted CRM records and update only their own facility inbox/preferences.
    role: {
      capabilityKeys: {
        [crmModule]: [...crmNavigationKeys, crmReadCapability],
        [operationsModule]: [...facilityOperationalKeys, facilityPersonalAgendaCapability],
        [pipelineModule]: [...pipelineRecordNavigationKeys, pipelineReadCapability],
      },
      capabilityModes: { [facilityPersonalAgendaCapability]: ['run'] },
      capabilitySelectors: { [crmReadCapability]: 'entrusted', [pipelineReadCapability]: 'entrusted' },
      label: 'Externí partner',
      modules: { [crmModule]: 'read', [operationsModule]: 'read', [pipelineModule]: 'read' },
      restrictedModules: [crmModule, operationsModule, pipelineModule],
    },
  },
  {
    // Second Provoz login: the same role and grants as operations@ (index 1), applied through the index-4
    // entries in `scripts/siampark/reset-demo.mts` and the operations-execution grants.
    email: 'provoz@najempark.demo',
    principalId: '72000000-0000-4000-8000-000000000025',
    role: withFacilityOperations(rentalDemoRoles.salesRep),
  },
] as const satisfies readonly { readonly email: string; readonly principalId: string; readonly role: DemoRole }[];

/**
 * CRM company „Velkoobchod Hanák s.r.o.“ (0022). `demo.crm` is not a generic read_all/write_all module: managers
 * hold read + write over every client, sales reps read and write only their assigned clients.
 */
export const crmDemoRoles = {
  crmAdmin: {
    capabilityKeys: { [crmModule]: crmManagerKeys, [partyModule]: partyHumanWriterKeys },
    capabilitySelectors: { [crmReadCapability]: 'all' },
    companyAdmin: true,
    label: 'Správce',
    modules: {
      [commerceModule]: 'write',
      [crmModule]: 'write',
      'demo.tagging': 'write',
      [partyModule]: 'write',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
    proposalReview: true,
    restrictedModules: [crmModule, partyModule],
  },
  crmManager: {
    capabilityKeys: { [crmModule]: crmManagerKeys, [partyModule]: partyHumanReaderKeys },
    capabilitySelectors: { [crmReadCapability]: 'all' },
    label: 'Vedoucí obchodu',
    modules: {
      [commerceModule]: 'read',
      [crmModule]: 'write',
      'demo.tagging': 'read',
      [partyModule]: 'read',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
    proposalReview: true,
    restrictedModules: [crmModule, partyModule],
  },
  crmRep: {
    capabilityKeys: { [crmModule]: crmRepKeys },
    capabilitySelectors: { [crmReadCapability]: 'assigned' },
    label: 'Obchodník',
    proposalReview: true,
    // No party.registry: its customer list is company-wide and would bypass the assigned-client filter.
    modules: { [crmModule]: 'write', 'work.tasks': 'write', [workforceModule]: 'read' },
    restrictedModules: [crmModule],
  },
} as const satisfies Readonly<Record<string, DemoRole>>;

/**
 * Staff operator capabilities over customer portal enrollment and portal bindings. Nothing but a company
 * administrator runs them (the storefront and Commerce workloads hold only their own journey capabilities),
 * so every e-shop administrator preset carries them: a right no role can be granted is a defect.
 */
export const commerceEnrollmentOperatorActionKeys: readonly string[] = [
  'commerce.customer-context.portal-enrollment.terminate',
  'commerce.customer-context.profile-reconciliation.open',
  'commerce.customer-context.profile-reconciliation.resolve',
  'commerce.customer-context.retail-portal-profile-binding.recover',
  'commerce.customer-context.retail-portal-profile-binding.revoke',
];

/** E-shop company „Kavárna Doma s.r.o.“ (0023). */
export const eshopDemoRoles = {
  akrosAdmin: {
    capabilityKeys: {
      [commerceModule]: [`${commerceModule}.market-use.assess`, ...commerceEnrollmentOperatorActionKeys],
      [partyModule]: partyHumanWriterKeys,
      'privacy.core': ['privacy.core.processing-purpose.create', 'privacy.core.notice-version.create'],
      [taxModule]: taxReaderKeys,
    },
    companyAdmin: true,
    label: 'Správce e-shopu',
    modules: {
      // Like the Kavárna e-shop administrator: the customer list shows each customer's groups.
      [commerceModule]: 'read',
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      // E-shops and their markets: the company administrator manages markets, associations and registrations.
      [marketModule]: 'write',
      [partyModule]: 'write',
      'privacy.core': 'read',
      [storefrontRegistryModule]: 'write',
      // Products carry a VAT classification: the administrator reads which rates exist.
      [taxModule]: 'read',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
    proposalReview: true,
    restrictedModules: [partyModule, taxModule],
  },
  eshopAdmin: {
    capabilityKeys: {
      [commerceModule]: [`${commerceModule}.market-use.assess`, ...commerceEnrollmentOperatorActionKeys],
      [partyModule]: partyHumanWriterKeys,
      [taxModule]: taxReaderKeys,
    },
    companyAdmin: true,
    label: 'Správce e-shopu',
    modules: {
      [commerceModule]: 'read',
      'demo.merchandise': 'write',
      'demo.tagging': 'read',
      [marketModule]: 'write',
      [partyModule]: 'write',
      [storefrontRegistryModule]: 'write',
      [taxModule]: 'read',
      'work.tasks': 'write',
      [workforceModule]: 'write',
    },
    proposalReview: true,
    restrictedModules: [partyModule, taxModule],
  },
  fulfilment: {
    label: 'Expedice',
    // Read-only view of the e-shops and markets the orders come from.
    modules: { 'demo.merchandise': 'write', [marketModule]: 'read', [storefrontRegistryModule]: 'read' },
    proposalReview: true,
  },
} as const satisfies Readonly<Record<string, DemoRole>>;

export type CompanyRoleKey = keyof typeof crmDemoRoles | keyof typeof eshopDemoRoles;
export const companyRoles = { ...crmDemoRoles, ...eshopDemoRoles } satisfies Readonly<Record<CompanyRoleKey, DemoRole>>;

const persona = (key: string, email: string, displayName: string, legalEntityId: string, role: CompanyRoleKey) => ({
  authBindingId: demoId('core.auth-binding', key),
  authUserId: `demo-${key}`,
  displayName,
  email,
  legalEntityId,
  principalId: demoId(principalResource, key),
  role,
});

/** Pseudonymous human administrator: exact company-only Privacy catalog setup operator. */
export const privacyMarketingOperator = persona(
  'sroubarna-eshop',
  'eshop@sroubarna.demo',
  'Správce e-shopu ŠroubShop',
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
  persona('sroubarna-expedice', 'expedice@sroubarna.demo', 'Expedice ŠroubShop', akrosDemoLegalEntityId, 'fulfilment'),
  persona('kavarna-expedice', 'expedice@kavarna.demo', 'Ondřej Kříž', eshopDemoLegalEntityId, 'fulfilment'),
] as const;

/** Stable principal IDs of the CRM personas, e.g. for client assignments in the crm seed. */
export const crmPersonaPrincipalIds = {
  manager: demoId(principalResource, 'hanak-vedouci'),
  repA: demoId(principalResource, 'hanak-obchodnik-a'),
  repB: demoId(principalResource, 'hanak-obchodnik-b'),
  spravce: demoId(principalResource, 'hanak-spravce'),
} as const;

/**
 * Service principal of the e-shop storefront BFF; its managed API key lands in `app/.env.demo.local`.
 *
 * It holds no v2 Role. The storefront's merchandise access is guarded by merchandise's own native service
 * key protocol (`akrosServiceKeyGuard`), and its customer-portal journey runs as the declared
 * `commerce.storefront-client` workload below.
 */
export const storefrontPrincipal = {
  displayName: 'kavarna-storefront',
  kind: 'service',
  legalEntityId: eshopDemoLegalEntityId,
  principalId: demoId(principalResource, 'kavarna-storefront'),
} as const;

/** ŠroubShop's storefront BFF (the pseudonym cutover moved it off the legacy `akros-storefront` identity). */
export const akrosStorefrontPrincipal = {
  displayName: 'sroubshop-storefront',
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, 'sroubshop-storefront'),
} as const;

/** The declared workload of the shared Storefront client (O73). */
export const STOREFRONT_CLIENT_WORKLOAD = 'commerce.storefront-client';
/** The declared workload of a storefront that reads the merchandise catalog and places its orders (O73). */
export const STOREFRONT_MERCHANDISE_WORKLOAD = 'demo.storefront-client';
/** The declared workload of a storefront that files customer inquiries as Work Tasks (O73). */
export const STOREFRONT_INQUIRY_WORKLOAD = 'work.storefront-client';
/** The declared workload of the external identity provider that reserves and activates bindings (O73). */
export const IDENTITY_PROVIDER_WORKLOAD = 'core.identity-provider';
/** Exact owner-declared purpose key shared by CRM intake and its delegated Party calls. */
export const CRM_PARTY_INTAKE_WORKLOAD = 'demo.crm.party-intake';

/**
 * One registered machine workload (O73): a principal of the tenant and one `<module>.<workload-name>` key a
 * carrier declares. A service principal is admitted **only** on a carrier that declares one of these keys,
 * and only while Core holds this active binding; the kind alone grants nothing.
 */
export interface ReviewedWorkloadBinding {
  /** The one company the workload acts for (D6); its company-scoped calls are admitted only there. */
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly workloadKey: string;
}

/** A storefront acts for its own company only, exactly as the stage registrations name it. */
const storefrontBinding = (
  principal: { readonly legalEntityId: string; readonly principalId: string },
  workloadKey: string,
): ReviewedWorkloadBinding => ({
  legalEntityId: principal.legalEntityId,
  principalId: principal.principalId,
  workloadKey,
});

/**
 * The reviewed workload bindings of the demo tenant. Every entry names a key a carrier in this release
 * declares and a principal whose live caller runs that carrier:
 *
 * - the two storefront BFFs and the Commerce customer portal run the portal-enrollment journey
 *   (`commerce.customer-context.start-portal-enrollment`, `…-transition.claim`, and the delegated
 *   `party.registry.party.create` / `ensure-retail-customer-profile` / `bind-retail-portal-profile`
 *   subjects) — all of which declare `commerce.storefront-client`;
 * - both storefront BFFs read the merchandise catalog and media (`demo.merchandise` records and media reads) and
 *   place their guest orders (`demo.merchandise.place-storefront-order`), which declare `demo.storefront-client`;
 * - ŠroubShop's storefront files its contact and product-question form as `work.tasks.submit-storefront-inquiry`,
 *   which declares `work.storefront-client` (Kavárna's storefront has no inquiry form, so it is not bound);
 * - each storefront binding is registered for the storefront's own company (D6), as on stage, so a
 *   company-scoped storefront call is admitted in that company and nowhere else;
 * - the Commerce customer portal is also the external identity provider that reserves and activates
 *   principal bindings (`core.identity.reserve-principal-binding`, `…-binding.activate` and the
 *   `core.identity` external-identity reads), which declare `core.identity-provider`.
 *
 * CRM intake runs only its slim read/link Action and delegated Party purpose as demo.crm.party-intake.
 * No other reviewed service principal is bound: a key that no carrier of this release declares would be an
 * invented grant, and a principal admitted on a declaration carrier would be a service cast as a person.
 */
/** Deliberate human affiliations only; a Role assignment never creates an SQL membership. */
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
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, COMMERCE_PORTAL),
} as const;

export const privacyConsentPrincipal = {
  apiKeyName: 'privacy-consent-authority',
  displayName: 'Privacy · Commerce consent authority reader',
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, 'privacy-consent-authority'),
} as const;

export const marketRetirementPrincipal = {
  apiKeyName: 'market-retirement-authority',
  displayName: 'Market · retirement authority',
  kind: 'service',
  legalEntityId: akrosDemoLegalEntityId,
  principalId: demoId(principalResource, 'market-retirement-authority'),
} as const;

/**
 * Kavárna's Market owner gateway: API keys are bound to one company, so Kavárna's markets validate their storefront
 * (and reserve their retirement) through their own key (`ONTOS_COMMERCE_MARKET_CATALOG_COMPANY_GATEWAY_API_KEYS`).
 */
export const kavarnaMarketAuthorityPrincipal = {
  apiKeyName: 'kavarna-market-authority',
  displayName: 'Market · Kavárna owner gateway',
  kind: 'service',
  legalEntityId: eshopDemoLegalEntityId,
  principalId: demoId(principalResource, 'kavarna-market-authority'),
} as const;

export const COMMERCE_PORTAL_NAMESPACE = 'ontos.commerce.portal.better-auth.v1';

/**
 * One Tenant's Commerce portal workload. API keys resolve to one Principal and a Principal belongs to one Tenant, so
 * every Tenant that runs customer self-enrollment has its own service Principal, key and grants.
 */
export interface CommercePortalWorkload {
  readonly apiKeyName: string;
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly roleKey: string;
  readonly tenantId: string;
}

const intakeName = 'crm-party-intake';

export const crmPartyIntakePrincipal = {
  apiKeyName: intakeName,
  displayName: 'CRM · zakládání klientů v Party Registry',
  envVar: 'ONTOS_CRM_PARTY_INTAKE_API_KEY',
  kind: 'service',
  principalId: demoId(principalResource, intakeName),
} as const;

/** Exact reviewed bindings. Topology caller `crm` does not rename producer workload `demo.crm.party-intake`. */
export const reviewedWorkloadBindings = (): readonly ReviewedWorkloadBinding[] => [
  storefrontBinding(storefrontPrincipal, STOREFRONT_CLIENT_WORKLOAD),
  storefrontBinding(storefrontPrincipal, STOREFRONT_MERCHANDISE_WORKLOAD),
  storefrontBinding(akrosStorefrontPrincipal, STOREFRONT_CLIENT_WORKLOAD),
  storefrontBinding(akrosStorefrontPrincipal, STOREFRONT_MERCHANDISE_WORKLOAD),
  storefrontBinding(akrosStorefrontPrincipal, STOREFRONT_INQUIRY_WORKLOAD),
  { principalId: commercePortalPrincipal.principalId, workloadKey: STOREFRONT_CLIENT_WORKLOAD },
  { principalId: commercePortalPrincipal.principalId, workloadKey: IDENTITY_PROVIDER_WORKLOAD },
  { principalId: crmPartyIntakePrincipal.principalId, workloadKey: CRM_PARTY_INTAKE_WORKLOAD },
];

/**
 * Tenant superadmin (obchod@demo.ontos): administrators can do everything, so in every company that uses the CRM
 * (Obchodní firma, Nájempark, Velkoobchod Hanák) it opens `demo.crm` with the CRM manager capabilities and its write
 * capabilities. Additive only: no SQL membership and no Tenant or company membership edge.
 */
export const tenantAdministratorCrmLegalEntityIds: readonly string[] = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
];
export const tenantAdministratorCrmRole: DemoRole = {
  capabilityKeys: { [crmModule]: crmManagerKeys },
  capabilitySelectors: { [crmReadCapability]: 'all' },
  label: 'Správce tenantu',
  modules: { [crmModule]: 'read' },
  restrictedModules: [crmModule],
};
/** The tenant administrator's explicit company-local pipeline overlay, not a tenant-wide record grant. */
export const tenantAdministratorPipelineRole: DemoRole = {
  capabilityKeys: { [pipelineModule]: [...pipelineWriterKeys, pipelineEntrustCapability] },
  capabilitySelectors: { [pipelineReadCapability]: 'all' },
  label: 'Správce příležitostí tenantu',
  modules: { [pipelineModule]: 'write' },
  proposalReview: true,
  restrictedModules: [pipelineModule],
};

/**
 * One reviewed assignment of the demo tenant: a person, one Role key, and the company scope the Role and its
 * cells belong to. `undefined` names the tenant context (tenant-level roles). A machine identity is never
 * assigned a human Role: workloads need registered bindings; agents need canonical role/connection authority,
 * never their display profile.
 */
export interface ReviewedDemoAssignment {
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly role: DemoRole;
  readonly roleKey: string;
}

const assignment = (
  principalId: string,
  roleKey: string,
  role: DemoRole,
  legalEntityId?: string,
): ReviewedDemoAssignment =>
  legalEntityId === undefined
    ? { principalId, role: reviewedCompanyRole(role), roleKey }
    : {
        legalEntityId,
        principalId,
        role: reviewedCompanyRole(role, legalEntityId, { principalId, tenantId: demoTenantId }),
        roleKey,
      };

export const demoShellRoutingRoleKey = 'demo-shell-routing';
export const tenantModuleTargetCapability = 'core.shell.tenant-module-target.resolve';
/** Routing resolves a page target; the target page and its data still require their own cells. */
export const demoShellRoutingRole: DemoRole = {
  capabilityKeys: { 'core.shell': [tenantModuleTargetCapability] },
  label: 'Směrování demo prostředí',
  modules: { 'core.shell': 'read' },
  restrictedModules: ['core.shell'],
};

/** Explicit tenant access membership for the reviewed people, never a service identity or warmup phantom. */
export const demoTenantMemberships = [
  ...new Set(
    [...demoHumanAccounts, ...companyHumanAccounts, ...siamparkRentalPersonas].map(({ principalId }) => principalId),
  ),
].map((principalId) => ({ kind: 'member' as const, principalId }));

export const companyAgentKeyAdministratorRole: DemoRole = {
  capabilityKeys: {
    'core.identity': [
      'core.identity.company-agent-key.list-managed',
      'core.identity.company-agent-key.read-personal-data',
      'core.identity.company-agent-key.read-authentication-metadata',
    ],
  },
  label: 'Správa klíčů firemních agentů',
  modules: { 'core.identity': 'read' },
  restrictedModules: ['core.identity'],
};

/**
 * Every reviewed **person** assignment of the demo tenant, as canonical source: the four Obchodní-firma
 * accounts, the Nájempark baseline personas, the CRM and e-shop company personas, and
 * the tenant administrator's CRM overlay.
 *
 * A Role key must be unique inside the tenant, so each company's profile is namespaced by its company key.
 */
export const reviewedDemoAssignments = (): readonly ReviewedDemoAssignment[] => {
  const [headOfSales, salesRep, accountant] = demoHumanAccounts;
  const people: ReviewedDemoAssignment[] = [
    assignment(headOfSales.principalId, 'sales-leadership', demoRoles.headOfSales, demoLegalEntityId),
    assignment(salesRep.principalId, 'sales', demoRoles.salesRep, demoLegalEntityId),
    assignment(accountant.principalId, 'accounting', demoRoles.accountant, demoLegalEntityId),
    assignment(demoHumanAccounts[3].principalId, 'warehouse', demoRoles.warehouse, demoLegalEntityId),
    ...siamparkRentalPersonas.map(({ principalId, role }) =>
      assignment(principalId, demoPrincipalRoleKey(principalId), role, rentalDemoLegalEntityId),
    ),
    ...companyHumanAccounts.map(({ legalEntityId, principalId, role }) =>
      // The company is part of the Role key: two companies may review the same job name with different
      // rights (Kavárna's e-shop administrator vs ŠroubShop's), and one key must name exactly one policy.
      assignment(
        principalId,
        `company-${legalEntityId.slice(-4)}-${demoPrincipalRoleKey(principalId)}`,
        companyRoles[role],
        legalEntityId,
      ),
    ),
    ...tenantAdministratorCrmLegalEntityIds.map((legalEntityId) =>
      assignment(
        headOfSales.principalId,
        `tenant-administrator-crm-${legalEntityId.slice(-4)}`,
        tenantAdministratorCrmRole,
        legalEntityId,
      ),
    ),
    ...[demoLegalEntityId, rentalDemoLegalEntityId].map((legalEntityId) =>
      assignment(
        headOfSales.principalId,
        `tenant-administrator-pipeline-${legalEntityId.slice(-4)}`,
        tenantAdministratorPipelineRole,
        legalEntityId,
      ),
    ),
  ];
  return [
    ...people,
    ...demoTenantMemberships.map(({ principalId }) =>
      assignment(principalId, demoShellRoutingRoleKey, demoShellRoutingRole),
    ),
    ...people.flatMap(({ legalEntityId, principalId, role }) =>
      legalEntityId === undefined || role.companyAdmin !== true
        ? []
        : [
            assignment(
              principalId,
              `company-agent-keys-${legalEntityId.slice(-4)}`,
              companyAgentKeyAdministratorRole,
              legalEntityId,
            ),
          ],
    ),
  ];
};

/**
 * The reviewed machine identities that have **no** v2 authority in this release, with the exact carrier gap
 * that blocks each one. None is granted anything: a service principal admitted on a declaration carrier
 * would be a service cast as a person, and a key no carrier declares would be an invented grant.
 *
 * Each is a genuine blocker for the owner of the carrier, not a decision to take here.
 */
export const unmappedServicePrincipals = [
  {
    carrier: 'commerce.customer-context (no declared consent-authority read)',
    principalId: privacyConsentPrincipal.principalId,
    reason:
      'The legacy customer.consent.resolve_authority / customer.notice.resolve_authority context permissions have no declared v2 capability.',
  },
  {
    carrier:
      'commerce.customer-context.market-retirement.reserve (accessActor.callers=[commerce-market-catalog], subject=rights)',
    principalId: marketRetirementPrincipal.principalId,
    reason:
      "The carrier delegates to the acting principal's rights, and the gateway principal is a service: it is refused on a rights carrier and declares no accessWorkload.",
  },
  {
    carrier:
      'commerce.customer-context.market-retirement.reserve (accessActor.callers=[commerce-market-catalog], subject=rights)',
    principalId: kavarnaMarketAuthorityPrincipal.principalId,
    reason:
      "Same rights-delegated carrier as the AKROS market authority; Kavárna's gateway principal declares no accessWorkload either.",
  },
] as const;

/**
 * The service identities whose legacy Roles are gone with their callers, and why. Removing the Role is the
 * point: an inert reviewed Role that nothing writes is exactly the retired scoped-role model under a new
 * name, and a service principal admitted on a declaration carrier would be a service cast as a person.
 */
export const retiredServiceRoles = [
  {
    reason:
      'The CRM intake is a service bound only to demo.crm.party-intake; its slim read, link-only Action and composed crm-to-Party calls replace the broad CRM/Party human Role.',
    role: 'CRM Party intake (legacy broad CRM / Party permissions)',
  },
  {
    reason:
      "The storefront BFFs are admitted by merchandise's own native service-key protocol (akrosServiceKeyGuard) and by the registered commerce.storefront-client workload, not by a Role.",
    role: 'storefront / akrosStorefront (demo.merchandise)',
  },
  {
    reason:
      'The customer portal runs the enrollment journey as the declared commerce.storefront-client workload, and reserves and activates bindings as the declared core.identity-provider workload; its read narrowing (party.registry, privacy.core) is not a carrier of this release.',
    role: 'commerce-portal (core.identity / party.registry / privacy.core reads)',
  },
] as const;

/**
 * Every reviewed machine identity that needs a principal row in the demo tenant. A row is identity, not
 * authority: the MCP bot, the storefront BFFs and the customer portal are admitted by the gateway protocol
 * and the registered workload bindings, and the principals listed in `unmappedServicePrincipals` reach
 * nothing until their carrier declares a workload key.
 */
export const reviewedMachinePrincipals = [
  agentBotPrincipal,
  storefrontPrincipal,
  akrosStorefrontPrincipal,
  commercePortalPrincipal,
  privacyConsentPrincipal,
  marketRetirementPrincipal,
  kavarnaMarketAuthorityPrincipal,
  crmPartyIntakePrincipal,
] as const satisfies readonly {
  readonly displayName: string;
  readonly kind: string;
  readonly principalId: string;
}[];

/** The legal entities the demo tenant installs; a role in one of them never reaches another. */
export const demoLegalEntityIds: readonly string[] = [
  demoLegalEntityId,
  rentalDemoLegalEntityId,
  crmDemoLegalEntityId,
  eshopDemoLegalEntityId,
  akrosDemoLegalEntityId,
];
