import {
  akrosDemoLegalEntityId,
  crmDemoLegalEntityId,
  demoId,
  demoLegalEntityId,
  eshopDemoLegalEntityId,
  rentalDemoLegalEntityId,
} from './fixture-ids.mts';
import type { DemoRole } from './permissions.mts';

const salesReads = {
  'commerce.customer-context': 'read',
  'crm.activities': 'read',
  'demo.merchandise': 'read',
  'demo.sales-insights': 'read',
  'demo.sales-pipeline': 'read',
  'demo.tagging': 'read',
  'demo.workforce': 'read',
  'finance.billing': 'read',
  'legal.agreements': 'read',
  'party.registry': 'read',
  'work.tasks': 'read',
} as const;
const privacyReads = [
  'privacy.processing_catalog.read',
  'privacy.notice.read',
  'privacy.subjects.read',
  'privacy.consent.read',
];

/** Independent read-only roles. Never copy administrator membership or Action grants to a warm-up identity. */
export const warmupProfiles = [
  {
    company: 'obchod',
    legalEntityId: demoLegalEntityId,
    role: { label: 'Warm-up sales reader', modules: salesReads },
  },
  {
    company: 'najempark',
    legalEntityId: rentalDemoLegalEntityId,
    role: {
      contextPermissions: { 'demo.crm': ['demo.crm.read_all'] },
      label: 'Warm-up rental reader',
      modules: {
        ...salesReads,
        'demo.crm': 'read',
        'facility.operations': 'read',
        'property.leasing': 'read',
        'property.portfolio': 'read',
      },
    },
  },
  {
    company: 'hanak',
    legalEntityId: crmDemoLegalEntityId,
    role: {
      contextPermissions: { 'demo.crm': ['demo.crm.read_all'] },
      label: 'Warm-up CRM reader',
      modules: {
        'commerce.customer-context': 'read',
        'demo.crm': 'read',
        'demo.tagging': 'read',
        'demo.workforce': 'read',
        'party.registry': 'read',
        'work.tasks': 'read',
      },
    },
  },
  ...[
    { company: 'kavarna', legalEntityId: eshopDemoLegalEntityId },
    { company: 'akros', legalEntityId: akrosDemoLegalEntityId },
  ].map((company) => ({
    ...company,
    role: {
      contextPermissions: { 'privacy.core': privacyReads },
      label: 'Warm-up commerce reader',
      modules: {
        'commerce.customer-context': 'read',
        'demo.merchandise': 'read',
        'demo.tagging': 'read',
        'demo.workforce': 'read',
        'party.registry': 'read',
        'privacy.core': 'read',
        'work.tasks': 'read',
      },
    } satisfies DemoRole,
  })),
] as const satisfies readonly { readonly company: string; readonly legalEntityId: string; readonly role: DemoRole }[];

/** Fixed synthetic seed accounts. Each has membership in exactly one existing demo company. */
export const warmupAccounts = warmupProfiles.map((profile) => ({
  ...profile,
  authBindingId: demoId('core.auth-binding', `warmup-${profile.company}`),
  authUserId: `demo-warmup-${profile.company}`,
  displayName: `Stage warm-up (read only) · ${profile.company}`,
  email: `warmup@${profile.company}.demo`,
  principalId: demoId('core.principal', `warmup-${profile.company}`),
  roleKey: `warmup-${profile.company}-reader`,
}));
