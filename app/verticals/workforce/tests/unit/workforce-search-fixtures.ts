import { attestOutboxWorkerHandlerContext } from '@app/core-runtime/testing/outbox';
import type { ContextAccessService } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { WorkforceSearchRequestIdSchema } from '../../shared/actions/request-search-rebuild.ts';
import { EmployeeIdSchema, EmployeeSchema } from '../../shared/apis/records.ts';
import type { WorkforceSearchSnapshot } from '../../src/services/workforce-search-source.ts';

// Bound owner services must not trigger a second permission lookup outside Core's tested Action gates.
const unexpectedAccess = () => Effect.die('Bound Workforce Action services must not access ContextAccess');
export const unexpectedContextAccess: ContextAccessService = {
  legalEntities: unexpectedAccess,
  modules: unexpectedAccess,
  resources: unexpectedAccess,
  tenants: unexpectedAccess,
};
export const searchRequestId = WorkforceSearchRequestIdSchema.make('60000000-0000-4000-8000-000000000001');

export const tenantId = '10000000-0000-4000-8000-000000000001';
export const companyId = '20000000-0000-4000-8000-000000000001';
export const otherCompanyId = '20000000-0000-4000-8000-000000000002';
export const employeeId = Schema.decodeSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000001');
export const otherEmployeeId = Schema.decodeSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000002');
export const scope = {
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:workforce-projection-test',
  authMethod: 'session',
  correlationId: 'workforce-projection-test',
  legalEntityId: companyId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
} as const;

export const workerContext = (kind: 'refresh' | 'rebuild' = 'refresh') =>
  attestOutboxWorkerHandlerContext({
    attemptNumber: 1,
    claimId: 'workforce-claim',
    compositionRevision: 'a'.repeat(64),
    consumerModuleKey: 'demo.workforce',
    deliveryId: 'workforce-delivery',
    domainEventId: 'workforce-event',
    legalEntityScope: 'forbidden',
    messageId: 'workforce-message',
    producerModuleKey: 'demo.workforce',
    tenantId,
    tenantSequenceNo: 1n,
    topic: `demo.workforce.search-${kind}-requested.v1`,
    workerKey: `demo.workforce.${kind}-search`,
  });

export const employee = Schema.decodeSync(EmployeeSchema)({
  active: true,
  createdAt: '2026-11-04T00:00:00.000Z',
  department: 'Účetní oddělení',
  email: 'private-employee@example.test',
  fullName: 'Jiří Novotný',
  id: employeeId,
  phone: '+420777111222',
  principalRef: { principalId: scope.principalId, tenantId },
  role: 'ACCOUNTANT',
  updatedAt: '2026-11-04T00:00:00.000Z',
});

export const snapshot: WorkforceSearchSnapshot = {
  employees: [
    {
      active: true,
      department: 'Účetní oddělení',
      fullName: 'Jiří Novotný',
      id: employeeId,
      legalEntityId: companyId,
      role: 'ACCOUNTANT',
      tenantId,
    },
    {
      active: true,
      department: 'Sklad',
      fullName: 'Jana Malá',
      id: otherEmployeeId,
      legalEntityId: otherCompanyId,
      role: 'WAREHOUSE',
      tenantId,
    },
  ],
  projectionVersion: '1',
  tenantId,
};
