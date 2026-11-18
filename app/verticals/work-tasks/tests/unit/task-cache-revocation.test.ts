// @rstest-environment happy-dom
import { acted, settle, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { preloadPage, RecordsPage, taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const principalRef = { principalId: '20000000-0000-4000-8000-000000000002', tenantId };
const taskTitle = 'Visible after revocation?';
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
} as const;
const collection = {
  properties: {
    dueDate: { locked: true, type: 'DATE' },
    ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
    status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
    title: { locked: true, type: 'TEXT' },
  },
  ref: collectionRef,
  title: 'Tasks',
} as const;

const allowed = Schema.decodeSync(RecordsResponseSchema)({
  actorPrincipalRef: principalRef,
  assignablePrincipals: [],
  canWrite: true,
  collection,
  indicators: { open: 1, openByAssignee: [], overdue: 0 },
  items: [
    {
      collectionRef,
      contextRefs: [],
      createdAt: '2026-11-04T08:00:00Z',
      priority: 'NORMAL',
      ref: {
        moduleId: 'work.tasks',
        resourceId: '10000000-0000-4000-8000-000000000010',
        resourceType: 'work.tasks.task',
        tenantId,
      },
      state: 'NEW',
      title: taskTitle,
      updatedAt: '2026-11-04T08:00:00Z',
    },
  ],
  lookupAccess: { contracts: 'denied', customers: 'denied', opportunities: 'denied', properties: 'denied' },
  principalNames: [],
  referenceDate: '2026-11-04',
  revision: 1,
});
const denied = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'The task list permission was revoked.',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:records-forbidden',
});

const propsFor = (legalEntityId: string): ModulePageProps => ({
  context: { legalEntityId, principalId: principalRef.principalId, tenantId },
  routeParams: {},
  search: '',
});

const czech = moduleText('cs');
const copy = {
  forbidden: czech('work-tasks.pages.records.forbidden'),
  newTask: czech('work-tasks.pages.records.newTask'),
};

const reads: RecordsRequest[] = [];
let answer: Effect.Effect<RecordsResponse, typeof denied> = Effect.succeed(allowed);
const OwnerRecordsApi = RecordsApi.prefix('/work-tasks-api');
const network = browserNetwork(
  shellGatewayIssuer({ 'work-tasks': '/work-tasks-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', ({ payload }) =>
        Effect.suspend(() => {
          reads.push(payload);
          return answer;
        }),
      ),
    ),
  ),
);

beforeEach(() => {
  reads.length = 0;
  answer = Effect.succeed(allowed);
  taskRecords.invalidate();
});

afterEach(unmountAll);

it.live('renders the permitted task rows and write controls before revocation', () =>
  Effect.gen(function* permittedPage() {
    yield* pinTestDocument;
    const props = propsFor('20000000-0000-4000-8000-000000000101');
    yield* Effect.promise(() => preloadPage(props));
    yield* mountInRoute(createElement(RecordsPage, props), { url: '/cs/ukoly' });
    yield* waitUntil(() => text().includes(taskTitle));
    expect({
      row: text().includes(taskTitle),
      writeControl: text().includes(copy.newTask),
    }).toEqual({ row: true, writeControl: true });
    expect(reads).toHaveLength(1);
  }).pipe(Effect.provide(network)),
);

it.live('a denied revalidation does not keep showing the previous rows or write controls', () =>
  Effect.gen(function* deniedRevalidation() {
    yield* pinTestDocument;
    const props = propsFor('20000000-0000-4000-8000-000000000102');
    yield* Effect.promise(() => preloadPage(props));
    yield* mountInRoute(createElement(RecordsPage, props), { url: '/cs/ukoly' });
    yield* waitUntil(() => text().includes(taskTitle));
    expect(text()).toContain(taskTitle);

    const started = yield* Deferred.make<boolean>();
    const gate = yield* Deferred.make<typeof allowed, typeof denied>();
    answer = Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(gate)));
    yield* acted(() => {
      window.dispatchEvent(new Event(moduleChangeEvent));
    });
    const preloadDone = preloadPage(props);
    yield* Deferred.await(started);
    yield* Deferred.fail(gate, denied);
    yield* Effect.promise(() => preloadDone);
    yield* settle;
    yield* waitUntil(() => text().includes(copy.forbidden));

    // Identity switches reload the Shell document; this covers a same-session permission revocation.
    expect(reads).toHaveLength(2);
    expect({
      forbidden: text().includes(copy.forbidden),
      row: text().includes(taskTitle),
      writeControl: text().includes(copy.newTask),
    }).toEqual({ forbidden: true, row: false, writeControl: false });
  }).pipe(Effect.provide(network)),
);
