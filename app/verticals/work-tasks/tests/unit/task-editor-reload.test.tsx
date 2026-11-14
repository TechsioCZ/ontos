// @rstest-environment happy-dom
// The task editor while the task list reloads in the background (a live change, the 20 s freshness window, a settled
// write). The strict task store reads `pending` during such a reload; the open editor must stay editable: its fields,
// Uložit, the unsaved status and the assignee name stay as they were. A refused reload still takes write access away.
import { saveLabelsFor } from '@app/admin-ui';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { constVoid } from 'effect/Function';
import { Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage, taskRecords } from '../../src/routes/[lang]/ukoly/page.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';

const mocks = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@app/party-registry/api/client', () => ({ listCustomers: () => Effect.never }));
rstest.mock('@app/sales-pipeline/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/property-portfolio/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => {
  const state = { location: { href: '', searchStr: '' } };
  return {
    useBlocker: () => ({ status: 'idle' }),
    useNavigate: () => () => Promise.resolve(),
    useRouterState: <Value,>({ select }: { readonly select: (input: typeof state) => Value }) => select(state),
  };
});
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const copy = {
  edit: 'work-tasks.pages.records.edit',
  outsideList: 'Účet mimo seznam',
  readOnly: 'work-tasks.pages.records.readOnly',
  title: 'task-title',
  typed: 'typed-title',
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

/** Lets running reads take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 400) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const render = acted(() => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ container, root });
  root.render(<RecordsPage context={context} />);
});

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (found) => found.textContent?.trim() === label || found.getAttribute('aria-label') === label,
  );
const field = () => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${copy.title}"]`));
const text = () => document.body.textContent ?? '';
const type = (typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(field());
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

/** Opens the page with the list at revision 4 and opens the task's editor through its row action. */
const openEdit = Effect.gen(function* open() {
  yield* render;
  yield* waitUntil(() => buttons(copy.edit).length > 0);
  yield* acted(() => buttons(copy.edit)[0]?.click());
  yield* waitUntil(() => Option.isSome(field()));
});

/** Asserts the editor is writable: an enabled title, Uložit present and the assignee named. */
const expectEditable = () => {
  expect(Option.getOrThrow(field()).disabled).toBe(false);
  expect(text()).not.toContain(copy.readOnly);
  expect(buttons(labels.save)).toHaveLength(1);
  expect(text()).toContain(colleagueName);
  expect(text()).not.toContain(copy.outsideList);
};

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(recordsAt(4)));
  mocks.apply.mockReset();
  taskRecords.invalidate();
});

afterEach(() => {
  for (const { container, root } of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  rstest.unstubAllGlobals();
});

describe('task editor across a background reload', () => {
  it.live('stays editable with its typed input, Uložit and the assignee name while the list reloads', () =>
    Effect.gen(function* editable() {
      yield* openEdit;
      yield* type(copy.typed);
      expect(text()).toContain(labels.unsaved);
      expectEditable();

      const gate = yield* Deferred.make<RecordsResponse>();
      mocks.records.mockReturnValue(Deferred.await(gate));
      yield* acted(() => taskRecords.invalidate());
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2);
      expectEditable();
      expect(Option.getOrThrow(field()).value).toBe(copy.typed);
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(5));
      yield* settle;
      expectEditable();
      expect(Option.getOrThrow(field()).value).toBe(copy.typed);
    }),
  );

  it.live('a refused reload takes write access away at once', () =>
    Effect.gen(function* refusedReload() {
      yield* openEdit;
      mocks.records.mockReturnValue(Effect.fail(refused));
      yield* acted(() => taskRecords.invalidate());
      yield* waitUntil(() => buttons(labels.save).length === 0);
      expect(text()).toContain(copy.readOnly);
    }),
  );
});
