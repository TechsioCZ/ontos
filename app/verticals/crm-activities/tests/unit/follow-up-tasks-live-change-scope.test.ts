// @rstest-environment happy-dom
import { waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModuleChangeDetail } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { RecordsApi, RecordsResponseSchema } from '@app/work-tasks/contracts/records';
import type { RecordsRequest } from '@app/work-tasks/contracts/records';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it } from 'effect-rstest';
import { followUpTasks } from '../../src/routes/[lang]/aktivity/page.tsx';

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
  followUpTasks.invalidate();
});

it.live('live changes of apps the follow-up tasks do not show read nothing', () =>
  Effect.gen(function* unrelatedChange() {
    yield* pinTestDocument;
    yield* followUpTasks.preload('company-a');
    yield* followUpTasks.read('company-a');
    const unsubscribe = followUpTasks.subscribe(() => {
      followUpTasks.snapshot('company-a');
    }, 'company-a');
    try {
      expect(reads).toHaveLength(1);
      dispatchChange(['party-registry']);
      yield* Effect.sleep('10 millis');
      expect(reads).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  }).pipe(Effect.provide(network)),
);

it.live('a live change of work-tasks reloads the mounted follow-up tasks', () =>
  Effect.gen(function* taskChange() {
    yield* pinTestDocument;
    yield* followUpTasks.preload('company-a');
    yield* followUpTasks.read('company-a');
    const unsubscribe = followUpTasks.subscribe(() => {
      followUpTasks.snapshot('company-a');
    }, 'company-a');
    try {
      dispatchChange(['work-tasks']);
      yield* waitUntil(() => reads.length >= 2);
      expect(reads).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  }).pipe(Effect.provide(network)),
);
