// @rstest-environment happy-dom
import { browserNetwork, serveApi, shellGatewayIssuer } from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { it } from 'effect-rstest';
import { assertLiveChangeReload } from '@app/shared-contracts/testing/live-change-reload';
import { PartyIdSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';

const input = {
  includeArchived: false,
  legalEntityId: 'company-a',
  partyId: Schema.decodeUnknownSync(PartyIdSchema)('10000000-0000-4000-8000-000000000001'),
};

/** Every records read the task owner received, in order. */
const reads: RecordsRequest[] = [];
const emptyList = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '20000000-0000-4000-8000-000000000002',
    tenantId: '20000000-0000-4000-8000-000000000001',
  },
  assignablePrincipals: [],
  canWrite: true,
  collection: {
    properties: {
      dueDate: { locked: true, type: 'DATE' },
      ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
      status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
      title: { locked: true, type: 'TEXT' },
    },
    ref: {
      moduleId: 'work.tasks',
      resourceId: 'default',
      resourceType: 'work.tasks.task-collection',
      tenantId: '20000000-0000-4000-8000-000000000001',
    },
    title: 'Tasks',
  },
  indicators: { open: 0, openByAssignee: [], overdue: 0 },
  items: [],
  lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
  principalNames: [],
  referenceDate: '2026-11-04',
  revision: 1,
});

const OwnerRecordsApi = RecordsApi.prefix('/work-tasks-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'work-tasks': '/work-tasks-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.sync(() => {
          reads.push(payload);
          return emptyList;
        }),
      ),
    ),
  ),
);

it.layer(network, { excludeTestServices: true })('store app contract', (suite) => {
  suite.effect('taskRecords reloads on a live change of the data it reads and ignores an unrelated app', () =>
    assertLiveChangeReload({
      ignores: 'tax',
      input,
      reads: () => reads.length,
      // 'shell' names Core identity changes; the owner's read includes assignable principals and their names.
      reloadsOn: ['work-tasks', 'shell'],
      store: taskRecords,
    }),
  );
});
