import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import type { FacilitySearchSnapshot } from '../../src/services/facility-search-source.ts';

export const tenantId = '10000000-0000-4000-8000-000000000001';
export const company = '20000000-0000-4000-8000-000000000002';
export const otherCompany = '20000000-0000-4000-8000-000000000003';
export const scope = {
  authBindingId: '60000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:facility-search-test',
  authMethod: 'session',
  correlationId: 'facility-search-test',
  legalEntityId: company,
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
export const workerContext = (kind: 'refresh' | 'rebuild') =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'claim',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'facility.operations',
    deliveryId: 'delivery',
    domainEventId: 'event',
    messageId: 'message',
    producerModuleKey: 'facility.operations',
    tenantId,
    tenantSequenceNo: 1n,
    topic: `facility.operations.search-${kind}-requested.v1`,
    workerKey: `facility.operations.${kind}-search`,
  });
export const snapshot: FacilitySearchSnapshot = {
  projectionVersion: '1',
  rows: [
    {
      archived: false,
      id: 'asset-1',
      legalEntityId: company,
      tenantId,
      text: ['Čerpadlo', 'INV-01', 'Technologie'],
      title: 'Čerpadlo',
      type: 'asset',
    },
    {
      archived: false,
      id: 'device-1',
      legalEntityId: company,
      tenantId,
      text: ['Vstupní kamera', 'SN-01'],
      title: 'Vstupní kamera',
      type: 'device',
    },
    {
      archived: false,
      id: 'document-1',
      legalEntityId: company,
      tenantId,
      text: ['Revizní protokol', 'revision'],
      title: 'Revizní protokol',
      type: 'document',
    },
  ],
  tenantId,
};
