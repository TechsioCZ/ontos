// @rstest-environment happy-dom
// A denied task reload removes write controls from an already open editor.
import { saveLabelsFor } from '@app/admin-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  networkIdle,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage, taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';
import { acted, buttons, text, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import { moduleText, mountInRoute } from '../support/module-ui.ts';

const labels = saveLabelsFor('cs');
const czech = moduleText('cs');
const copy = {
  edit: czech('work-tasks.pages.records.edit'),
  readOnly: czech('work-tasks.pages.records.readOnly'),
  title: 'task-title',
} as const;
const tenantId = '20000000-0000-4000-8000-000000000001';
const principalRef = { principalId: '20000000-0000-4000-8000-000000000002', tenantId };
const colleagueRef = { principalId: '20000000-0000-4000-8000-000000000003', tenantId };
const colleagueName = 'colleague-name';
const collectionRef = {
  moduleId: 'work.tasks',
  resourceId: 'default',
  resourceType: 'work.tasks.task-collection',
  tenantId,
} as const;
const taskTitle = 'server-title';

/** The task list at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: principalRef,
    assignablePrincipals: [
      { displayName: 'actor-name', principalRef },
      { displayName: colleagueName, principalRef: colleagueRef },
    ],
    canWrite: true,
    collection: {
      properties: {
        dueDate: { locked: true, type: 'DATE' },
        ownerPrincipalRef: { locked: true, type: 'PRINCIPAL' },
        status: { groups: ['NOT_STARTED', 'IN_PROGRESS', 'DONE'], locked: true, type: 'STATUS' },
        title: { locked: true, type: 'TEXT' },
      },
      ref: collectionRef,
      title: 'Tasks',
    },
    indicators: { open: 1, openByAssignee: [], overdue: 0 },
    items: [
      {
        collectionRef,
        contextRefs: [],
        createdAt: '2026-11-04T08:00:00Z',
        ownerPrincipalRef: colleagueRef,
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
    principalNames: [
      { displayName: 'actor-name', principalRef },
      { displayName: colleagueName, principalRef: colleagueRef },
    ],
    referenceDate: '2026-11-04',
    revision,
  });
const refused = Schema.decodeSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'refused',
  status: 403,
  title: 'Forbidden',
  type: 'urn:ontos:test:records-forbidden',
});

const context: ModulePageProps['context'] = {
  legalEntityId: 'company-a',
  principalId: principalRef.principalId,
  tenantId,
};

/** What the task owner answers the next records read with; each test scripts it. */
let answer: Effect.Effect<RecordsResponse, typeof RecordsForbiddenProblemSchema.Type> = Effect.succeed(recordsAt(4));
/** Every records read the owner received, in order. */

/** The task owner's records endpoint, where the browser client sends it. */
const OwnerRecordsApi = RecordsApi.prefix('/work-tasks-api');
const taskOwner = HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
  group.handle('execute', () => Effect.suspend(() => answer)),
);
const network = browserNetwork(
  shellGatewayIssuer({ 'work-tasks': '/work-tasks-api' }).application,
  serveApi(OwnerRecordsApi, taskOwner),
);

const field = () => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${copy.title}"]`));
/** Opens the page with the list at revision 4 and opens the task's editor through its row action. */
const openEdit = Effect.gen(function* open() {
  yield* pinTestDocument;
  yield* mountInRoute(<RecordsPage context={context} />, { url: '/cs/ukoly' });
  yield* waitUntil(() => buttons(copy.edit).length > 0);
  yield* acted(() => buttons(copy.edit)[0]?.click());
  yield* waitUntil(() => Option.isSome(field()));
});

beforeEach(() => {
  answer = Effect.succeed(recordsAt(4));
  taskRecords.invalidate();
});

afterEach(unmountAll);

it.layer(network, { excludeTestServices: true })('task editor across a background reload', (suite) => {
  suite.effect('a refused reload takes write access away at once', () =>
    Effect.gen(function* refusedReload() {
      yield* openEdit;
      answer = Effect.fail(refused);
      yield* acted(() => taskRecords.invalidate());
      yield* networkIdle;
      expect(buttons(labels.save)).toHaveLength(0);
      expect(text()).toContain(copy.readOnly);
    }),
  );
});
