import { defineVerticalRegistration, resolveVisibleVerticals } from '@mvp/shared-contracts';
import type {
  ModuleFederationComponentLocator,
  TenantModuleState,
  VerticalRuntimeRegistration,
} from '@mvp/shared-contracts';
import { createDraftEntryAction } from './src/actions/create-draft-entry.action.ts';
import { createDraftEntryHandler } from './src/actions/create-draft-entry.handler.ts';
import { accountingCoreManifest } from './vertical.manifest.ts';

const accountingDraftEntrySearchHandler = () => ({
  items: [],
  reason: 'Day 3 placeholder: no accounting search index is queried.',
  status: 'not_implemented',
});

const accountingDraftEntrySummaryHandler = () => ({
  canonicalRowsWritten: false,
  reason: 'Day 3 placeholder: no accounting report rows are read or written.',
  status: 'not_implemented',
});

export const accountingCoreRouteLocator = {
  exportName: 'default',
  exposedModule: './Route',
  kind: 'module-federation',
  remote: 'accountingCore',
} satisfies ModuleFederationComponentLocator;

export const accountingCoreRegistration = defineVerticalRegistration({
  boundaryMarker: 'verticalAccountingCore',
  handlers: {
    [createDraftEntryAction.key]: createDraftEntryHandler,
    'accounting.draft_entry.search_result': accountingDraftEntrySearchHandler,
    'accounting.draft_entry.summary': accountingDraftEntrySummaryHandler,
  },
  manifest: accountingCoreManifest,
  navigation: {
    label: 'Accounting Core',
    route: '/accounting-core',
  },
  routes: [
    {
      label: 'Accounting Core',
      moduleFederation: accountingCoreRouteLocator,
      path: '/accounting-core',
    },
  ],
} satisfies VerticalRuntimeRegistration);

export const accountingCoreTenantModuleState = {
  moduleId: 'accounting.core',
  state: 'active',
  tenantId: 'tenant.demo',
} satisfies TenantModuleState;

export const accountingCoreVisibleRegistrations = resolveVisibleVerticals(
  [accountingCoreRegistration],
  [accountingCoreTenantModuleState],
);

export default accountingCoreRegistration;
