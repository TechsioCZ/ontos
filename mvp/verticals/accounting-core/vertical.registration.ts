import { defineVerticalRegistration } from '@mvp/shared-contracts';
import { createDraftEntryHandler } from './src/actions/create-draft-entry.handler.ts';
import { accountingCoreBoundaryMarker } from './src/boundary-marker.ts';
import { accountingCoreManifest } from './vertical.manifest.ts';

const notImplemented = () => {
  throw new Error('accounting.core runtime implementation is not available in Day 1/2.');
};

export const accountingCoreRegistration = defineVerticalRegistration({
  actions: {
    'accounting.core.createDraftEntry': createDraftEntryHandler,
  },
  handlers: {},
  manifest: accountingCoreManifest,
  migrations: [],
  reportHandlers: {
    'accounting.draft_entry.summary': notImplemented,
  },
  route: {
    boundaryMarker: accountingCoreBoundaryMarker,
    navigationLabel: 'Accounting Core',
    path: '/accounting-core',
  },
  searchHandlers: {
    'accounting.draft_entry.search_result': notImplemented,
  },
});
