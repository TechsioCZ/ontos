import {
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
  getVerticalRuntimeOutboxWorkers,
} from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { financeBillingManifest as manifest } from '../../vertical.manifest.ts';
import { financeBillingRegistration as registration } from '../../vertical.registration.ts';
import {
  financeBillingBackendRegistration as backendRegistration,
  financeBillingRuntimeDeclaration as declaration,
} from '../../vertical.runtime-declaration.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { leaseInvoicesRead } from '../../src/api/lease-invoices.read.ts';
import { recordsRead } from '../../src/api/records.read.ts';
import { vatChoicesRead } from '../../src/api/vat-choices.read.ts';
import { documentResourceDescriptor } from '../../shared/resources/document.ts';
import { financialPlanEntryResourceDescriptor } from '../../shared/resources/financial-plan-entry.ts';
import { invoiceResourceDescriptor } from '../../shared/resources/invoice.ts';
import { rebuildSearchWorker } from '../../src/workers/rebuild-search.worker.ts';
import { draftInvoiceFromWonOpportunityWorker } from '../../src/workers/draft-invoice-from-won-opportunity.worker.ts';
import { projectSearchWorker } from '../../src/workers/project-search.worker.ts';
import { financeBillingMcpContribution } from '../../shared/mcp/contribution.ts';

describe('finance.billing backend and full publication boundary', () => {
  it('shares genuine Action, Read and Worker registrations across both views', () => {
    const expectedActions = [applyCommandAction, requestSearchRebuildAction];
    expect(getVerticalRuntimeActions(backendRegistration)).toEqual(expectedActions);
    expect(getVerticalRuntimeActions(registration)).toEqual(expectedActions);
    for (const [index, action] of getVerticalRuntimeActions(backendRegistration).entries()) {
      expect(action).toBe(getVerticalRuntimeActions(registration)[index]);
      expect(action).toBe(manifest.publicSurface.actions[index]);
    }
    const expectedReads = [leaseInvoicesRead, recordsRead, vatChoicesRead];
    expect(declaration.reads).toEqual(expectedReads);
    for (const [index, read] of expectedReads.entries()) {
      expect(declaration.reads?.[index]).toBe(read);
    }
    const expectedWorkers = [draftInvoiceFromWonOpportunityWorker, projectSearchWorker, rebuildSearchWorker];
    expect(getVerticalRuntimeOutboxWorkers(backendRegistration)).toEqual(expectedWorkers);
    expect(getVerticalRuntimeOutboxWorkers(registration)).toEqual(expectedWorkers);
    for (const [index, worker] of getVerticalRuntimeOutboxWorkers(backendRegistration).entries()) {
      expect(worker).toBe(getVerticalRuntimeOutboxWorkers(registration)[index]);
    }
    for (const binding of declaration.manifest.publicSurface.operationContracts ?? []) {
      expect([...declaration.actions, ...(declaration.reads ?? [])]).toContain(binding.registration);
    }
    expect(extractVerticalRuntimeSafeDescriptors(backendRegistration)).toEqual(
      extractVerticalRuntimeSafeDescriptors(registration),
    );
    expect(declaration.manifest.requirements).toEqual(manifest.requirements);
    expect(declaration.manifest.publicSurface.shellContributions).toEqual(manifest.publicSurface.shellContributions);
  });

  it('keeps the complete frontend publication while the backend has no loaders', () => {
    const backendEntrypoints = getVerticalRuntimeEntrypoints(backendRegistration);
    for (const loaders of Object.values(backendEntrypoints)) {
      expect(Object.keys(loaders)).toHaveLength(0);
    }
    expect(manifest.module.id).toBe('finance.billing');
    expect(manifest.activation.defaultState).toBe('inactive');
    expect(manifest.activation.preservesHistoryWhenInactive).toBe(true);
    expect(new Set(Object.keys(manifest.publicSurface))).toEqual(
      new Set([
        'actions',
        'api',
        'businessPermissions',
        'components',
        'events',
        'mcp',
        'operationContracts',
        'reports',
        'resourceTypes',
        'search',
        'shellContributions',
      ]),
    );
    expect(manifest.publicSurface.resourceTypes).toEqual([
      documentResourceDescriptor,
      financialPlanEntryResourceDescriptor,
      invoiceResourceDescriptor,
    ]);
    expect(manifest.publicSurface.mcp).toEqual(financeBillingMcpContribution);
    expect(Object.keys(manifest.publicSurface.components)).toEqual(['page-records']);
    expect(manifest.publicSurface.components['page-records']).toBeTypeOf('function');
    const fullEntrypoints = getVerticalRuntimeEntrypoints(registration);
    expect(fullEntrypoints.pages['page-records']).toBeTypeOf('function');
    for (const key of Object.keys(manifest.publicSurface.api)) {
      expect(fullEntrypoints.api[key]).toBeTypeOf('function');
    }
    expect(manifest.publicSurface.api).toEqual(declaration.manifest.publicSurface.api);
    expect(manifest.publicSurface.operationContracts).toEqual(declaration.manifest.publicSurface.operationContracts);
  });
});
