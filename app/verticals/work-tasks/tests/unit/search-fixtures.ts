import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import { Schema } from 'effect';
import { TaskRefSchema } from '../../shared/resources/task.ts';
import type { SearchSnapshot } from '../../src/services/search-source.ts';

const moduleId = 'work.tasks';
export const tenantId = '10000000-0000-4000-8000-000000000001';
export const company = '20000000-0000-4000-8000-000000000001';
export const otherCompany = '20000000-0000-4000-8000-000000000002';
export const otherTenant = '10000000-0000-4000-8000-000000000002';
export const scope = {
  authContextRef: 'job:search:test',
  authMethod: 'system',
  correlationId: 'search-test',
  legalEntityId: company,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;
export const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleId,
  deliveryId: 'delivery',
  domainEventId: 'event',
  messageId: 'message',
  producerModuleKey: moduleId,
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'work.tasks.search-refresh-requested.v1',
  workerKey: 'work.tasks.refresh-search',
});
export const ref = Schema.decodeSync(TaskRefSchema)({
  moduleId,
  resourceId: '40000000-0000-4000-8000-000000000001',
  resourceType: 'work.tasks.task',
  tenantId,
});
export const snapshot: SearchSnapshot = {
  projectionVersion: '1',
  records: [
    {
      archived: false,
      legalEntityId: company,
      ref,
      title: 'Čerstvá káva pro kancelář',
    },
  ],
  tenantId,
};
