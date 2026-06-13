import { defineVerticalManifest, moduleFederationRemoteSpecifier } from '@mvp/shared-contracts';
import type { ModuleFederationComponentLocator, VerticalManifest } from '@mvp/shared-contracts';
import { createDraftEntryAction } from './actions/create-draft-entry.action';

export const accountingDraftEntryCardLocator = {
  exportName: 'AccountingDraftEntryCard',
  exposedModule: './AccountingDraftEntryCard',
  kind: 'module-federation',
  remote: 'accountingCore',
} satisfies ModuleFederationComponentLocator;

export const accountingDraftEntryCardSpecifier = moduleFederationRemoteSpecifier(
  accountingDraftEntryCardLocator,
);

export const accountingCoreManifest = defineVerticalManifest({
  actions: [createDraftEntryAction],
  dependencies: ['property.registry'],
  displayName: 'Accounting Core',
  folder: 'accounting-core',
  moduleId: 'accounting.core',
  publicComponents: [
    {
      key: 'AccountingDraftEntryCard',
      label: 'Accounting draft entry card',
      moduleFederation: accountingDraftEntryCardLocator,
      resourceKey: 'accounting.draft_entry',
    },
  ],
  reports: [
    {
      key: 'accounting.draft_entry.summary',
      label: 'Draft entry summary',
      resourceKey: 'accounting.draft_entry',
    },
  ],
  resources: [
    {
      key: 'accounting.draft_entry',
      label: 'Draft accounting entry',
      ownedByModuleId: 'accounting.core',
    },
  ],
  search: [
    {
      key: 'accounting.draft_entry.search_result',
      label: 'Draft entry search result',
      resourceKey: 'accounting.draft_entry',
    },
  ],
} satisfies VerticalManifest);

export default accountingCoreManifest;
