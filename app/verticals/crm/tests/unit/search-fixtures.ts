import { Schema } from 'effect';
import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { CrmStateSchema, withDefaultSlices } from '../../shared/domain/state.ts';
import type { SearchSnapshot } from '../../src/services/search-projection.service.ts';

export const tenantId = '10000000-0000-4000-8000-000000000001';
export const companyId = '20000000-0000-4000-8000-000000000001';
export const otherCompanyId = '20000000-0000-4000-8000-000000000002';
export const scope = {
  authContextRef: 'job:crm-search:test',
  authMethod: 'system',
  correlationId: 'crm-search',
  legalEntityId: companyId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
export const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'demo.crm',
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: 'demo.crm',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'demo.crm.search-changed.v1',
  workerKey: 'demo.crm.project-search',
});
export const rebuildContext = attestOutboxWorkerHandlerContext({
  ...context,
  legalEntityScope: 'forbidden',
  topic: 'demo.crm.search-rebuild-requested.v1',
  workerKey: 'demo.crm.rebuild-search',
});
const timestamps = {
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'person',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
export const state = Schema.decodeUnknownSync(CrmStateSchema)(
  withDefaultSlices({
    clients: {
      assignmentHistory: [],
      contacts: [
        {
          ...timestamps,
          clientId: 'client-1',
          email: 'private-contact@example.test',
          id: 'contact-1',
          name: 'Jiří Novotný',
          note: 'private contact note',
          phone: '+420987654321',
          status: 'active',
        },
      ],
      items: [
        {
          ...timestamps,
          email: 'secret-client@example.test',
          id: 'client-1',
          kind: 'organization',
          name: 'Železárny Hanák',
          note: 'private account note',
          phone: '+420123456789',
          regNo: '12345678',
          status: 'active',
        },
      ],
    },
  }),
);
export const snapshot: SearchSnapshot = {
  companies: [{ legalEntityId: companyId, state }],
  projectionVersion: '1',
  tenantId,
};
