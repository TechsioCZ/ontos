import { moduleChangeEvent, pageDataWorkEvent } from '@app/shared-contracts/page-data';
import type { ModulePageProps, PageDataWork } from '@app/shared-contracts/page-data';
import { Deferred, Effect, Schema } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-client.ts';
import { preloadPage, RecordsPage } from '../../src/routes/[lang]/ukoly/page.tsx';

rstest.mock('../../src/api/records-client.ts');
rstest.mock('../../src/api/apply-command-action-client.ts');
rstest.mock('@app/party-registry/api/client', () => ({ listCustomers: rstest.fn() }));
rstest.mock('@app/sales-pipeline/clients/records', () => ({ executeRecords: rstest.fn() }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: rstest.fn() }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => {
  const state = { location: { href: '', searchStr: '' } };
  return {
    useNavigate: () => () => {},
    useRouterState: <Value>({ select }: { readonly select: (input: typeof state) => Value }) => select(state),
  };
});
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: React.ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));
// The page reads the store in its client renderer; the Node test has no React commit phase.
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof React>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  matchMedia: () => ({ addEventListener: () => {}, matches: false, removeEventListener: () => {} }),
  removeEventListener: events.removeEventListener.bind(events),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
  // The page-data store only asks whether `document` exists. Reading it as undefined keeps ui-kit overlays inline, as
  // in server rendering, because this Node render has no DOM to portal into.
  Object.defineProperty(globalThis, 'document', { configurable: true, get: () => globalThis.undefined });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

afterEach(() => {
  rstest.unstubAllGlobals();
});

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

const render = (props: ModulePageProps) => renderToStaticMarkup(createElement(RecordsPage, props));

beforeEach(() => {
  rstest.resetAllMocks();
  // This owner's Node-only rstest config compiles TSX with the classic React runtime.
  rstest.stubGlobal('React', React);
  rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(allowed));
});

it.live('renders the permitted task rows and write controls before revocation', () =>
  Effect.gen(function* permittedPage() {
    const props = propsFor('20000000-0000-4000-8000-000000000101');
    yield* Effect.promise(() => preloadPage(props));
    const html = render(props);
    expect({
      row: html.includes(taskTitle),
      writeControl: html.includes('work-tasks.pages.records.newTask'),
    }).toEqual({ row: true, writeControl: true });
    expect(executeRecords).toHaveBeenCalledTimes(1);
  }),
);

it.live('a denied revalidation does not keep showing the previous rows or write controls', () =>
  Effect.gen(function* deniedRevalidation() {
    const props = propsFor('20000000-0000-4000-8000-000000000102');
    yield* Effect.promise(() => preloadPage(props));
    expect(render(props)).toContain(taskTitle);

    const started = yield* Deferred.make<boolean>();
    const gate = yield* Deferred.make<typeof allowed, typeof denied>();
    const settled = yield* Deferred.make<boolean>();
    const observe = (event: CustomEvent<PageDataWork>): void => {
      event.detail.onSettled(() => {
        Deferred.doneUnsafe(settled, Effect.succeed(true));
      });
    };
    globalThis.addEventListener(pageDataWorkEvent, observe);
    rstest
      .mocked(executeRecords)
      .mockReturnValue(Deferred.succeed(started, true).pipe(Effect.andThen(Deferred.await(gate))));
    globalThis.dispatchEvent(new Event(moduleChangeEvent));
    const preloadDone = preloadPage(props);
    yield* Deferred.await(started);
    yield* Deferred.fail(gate, denied);
    yield* Effect.promise(() => preloadDone);
    yield* Deferred.await(settled).pipe(
      Effect.ensuring(Effect.sync(() => globalThis.removeEventListener(pageDataWorkEvent, observe))),
    );

    // Identity switches reload the Shell document; this covers a same-session permission revocation.
    expect(executeRecords).toHaveBeenCalledTimes(2);
    const html = render(props);
    expect({
      forbidden: html.includes('work-tasks.pages.records.forbidden'),
      row: html.includes(taskTitle),
      writeControl: html.includes('work-tasks.pages.records.newTask'),
    }).toEqual({ forbidden: true, row: false, writeControl: false });
  }),
);
