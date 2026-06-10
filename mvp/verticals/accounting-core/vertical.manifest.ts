import { defineVerticalManifest } from '@mvp/shared-contracts';
import { createDraftEntryAction } from './src/actions/create-draft-entry.action.ts';

export const accountingCoreManifest = defineVerticalManifest({
  actions: [createDraftEntryAction],
  activationDefault: 'inactive',
  components: [
    {
      displayName: 'Accounting draft entry card',
      id: 'AccountingDraftEntryCard',
    },
  ],
  dependencies: ['property.registry'],
  displayName: 'Accounting Core',
  id: 'accounting.core',
  kind: 'microvertical',
  reports: [
    {
      displayName: 'Accounting draft entry summary',
      id: 'accounting.draft_entry.summary',
    },
  ],
  resources: [
    {
      displayName: 'Accounting draft entry',
      id: 'accounting.draft_entry',
    },
  ],
  search: [
    {
      displayName: 'Accounting draft entry search result',
      id: 'accounting.draft_entry.search_result',
    },
  ],
});
