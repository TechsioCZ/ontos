// @rstest-environment happy-dom
// The task list store's live-change scope: a change of an app the list does not show reads nothing, a Core identity
// change reloads the mounted list. Changes arrive as real window events; the records client runs for real against
// the Shell's gateway issuer and the task owner's records endpoint, served in process.
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest } from '../../shared/apis/records.ts';
import { taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';

type TaskListInput = Parameters<typeof taskRecords.preload>[0];
// The task list input has no party filter. The key is left out of the literal; the helper fills the
// required `partyId` slot from the optional one, so no assertion or literal `undefined` is needed.
const taskListInput = ({
  partyId,
  ...rest
}: Omit<TaskListInput, 'partyId'> & Partial<Pick<TaskListInput, 'partyId'>>): TaskListInput => ({
  ...rest,
  partyId,
});
const input = taskListInput({ includeArchived: false, legalEntityId: 'company-a' });

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

const dispatchChange = (apps: ModuleChangeDetail['apps']) => {
  window.dispatchEvent(new CustomEvent<ModuleChangeDetail>(moduleChangeEvent, { detail: { apps } }));
};

beforeEach(() => {
  reads.length = 0;
  taskRecords.invalidate();
});

it.live('live changes of apps the task list does not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    yield* taskRecords.preload(input);
    const unsubscribe = taskRecords.subscribe(() => {
      taskRecords.snapshot(input);
    }, input);
    expect(reads).toHaveLength(1);
    dispatchChange(['merchandise']);
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(1);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);

// The read includes assignable principals and principal names, which Core identity changes ('shell') alter.
it.live('a Core identity change reloads the mounted task list at once', () =>
  Effect.gen(function* identityChange() {
    yield* pinTestDocument;
    yield* taskRecords.preload(input);
    const unsubscribe = taskRecords.subscribe(() => {
      taskRecords.snapshot(input);
    }, input);
    dispatchChange(['shell']);
    yield* Effect.sleep('10 millis');
    expect(reads).toHaveLength(2);
    unsubscribe();
  }).pipe(Effect.provide(network)),
);
