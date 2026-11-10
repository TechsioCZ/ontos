// @rstest-environment happy-dom
// The edit dialog of a building while the register reloads in the background (a live change, the 20 s freshness
// window, a settled write). The strict register store reads `pending` during such a reload; the open dialog must stay
// mounted: typed input, its unsaved status and the leave question survive, a save goes out against the revision the
// draft was read at, and a draft with nothing typed takes the reloaded building.
import { saveLabelsFor } from '@app/admin-ui';
import { EmployeeIdSchema } from '@app/workforce/resources/employee';
import type { ModulePageProps } from '@app/shared-contracts/page-data';
import { constVoid } from 'effect/Function';
import { Deferred, Effect, Option, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { RecordsPage } from '../../src/routes/[lang]/nemovitosti/page.tsx';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { propertyRecords } from '../../src/routes/[lang]/nemovitosti/property-summary.ts';

/** The part of the router state the page reads. */
interface TestRouterState {
  readonly location: { readonly search: { readonly resourceId?: string }; readonly searchStr: string };
}
const mocks = rstest.hoisted(() => ({
  apply: rstest.fn(),
  employees: rstest.fn(),
  records: rstest.fn(),
  search: { resourceId: '' },
}));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));
rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: mocks.apply }));
rstest.mock('@app/workforce/clients/records', () => ({ listEmployees: mocks.employees }));
rstest.mock('@app/legal-agreements/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/property-leasing/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/finance-billing/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/work-tasks/clients/records', () => ({ executeRecords: () => Effect.never }));
rstest.mock('@app/facility-operations/ui/record-discussion', () => ({
  PropertyEquipment: () => null,
  RecordDiscussion: () => null,
}));
rstest.mock('@modern-js/plugin-tanstack/runtime', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => () => Promise.resolve(),
  useRouterState: <Selected,>(options?: { readonly select?: (state: TestRouterState) => Selected }) => {
    const state: TestRouterState = { location: { search: mocks.search, searchStr: '' } };
    return options?.select === undefined ? state : options.select(state);
  },
}));
rstest.mock('../../src/routes/ultramodern-route-head', () => ({ UltramodernRouteHead: () => null }));
rstest.mock('@modern-js/plugin-i18n/runtime', () => ({
  FederatedI18nBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useModernI18n: () => ({ language: 'cs', t: (key: string) => key }),
}));

const labels = saveLabelsFor('cs');
const tenantId = '70000000-0000-4000-8000-000000000020';
const employeeId = '75000000-0000-4000-8000-000000000001';
const firstId = '76000000-0000-4000-8000-000000000001';
const secondId = '76000000-0000-4000-8000-000000000002';
const propertyOf = (resourceId: string, address: string) => ({
  address,
  code: resourceId === firstId ? 'PROPERTY-01' : 'PROPERTY-02',
  createdAt: '2026-10-27T09:00:00.000Z',
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: '71000000-0000-4000-8000-000000000020',
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  lifecycleState: 'ACTIVE',
  name: resourceId === firstId ? 'server-name' : 'second-name',
  note: null,
  propertyRef: {
    moduleId: 'property.portfolio',
    resourceId,
    resourceType: 'property.portfolio.property',
    tenantId,
  },
  propertyType: 'Residential',
  responsibleEmployeeIds: [employeeId],
  updatedAt: '2026-10-27T09:00:00.000Z',
});
/** The register at `revision`; every read is a new object, as a reload returns. */
const recordsAt = (revision: number, address: string): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    assets: [],
    properties: [propertyOf(firstId, address), propertyOf(secondId, 'second-address')],
    revision,
    units: [],
  });

const context: ModulePageProps['context'] = { legalEntityId: 'company-a', principalId: 'manager-a', tenantId };

const name = 'property-name';
const address = 'property-address';
const edit = 'property-portfolio.pages.records.editor.edit';
const close = 'property-portfolio.pages.records.editor.close';

/** Lets running reads and saves take a step, then flushes React's updates. */
const settle: Effect.Effect<void> = Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
/** Runs `step` inside React's act, then lets what it started settle. */
const acted = (step: () => void): Effect.Effect<void> =>
  Effect.sync(() => {
    act(() => {
      step();
    });
  }).pipe(Effect.andThen(settle));
/** Lets the page work until `condition` holds; fails the test when it never does. */
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
const render = (resourceId: string) =>
  acted(() => {
    mocks.search.resourceId = resourceId;
    const [existing] = roots;
    if (existing === undefined) {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      roots.push({ container, root });
      root.render(<RecordsPage context={context} />);
    } else {
      existing.root.render(<RecordsPage context={{ ...context }} />);
    }
  });

const buttons = (label: string): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent?.trim() === label);
const button = (label: string): HTMLButtonElement => {
  const [found] = buttons(label);
  expect(found).toBeDefined();
  return found ?? document.createElement('button');
};
const maybeField = (id: string) => Option.fromNullOr(document.querySelector<HTMLInputElement>(`input[id="${id}"]`));
const value = (id: string) =>
  maybeField(id).pipe(
    Option.map((input) => input.value),
    Option.getOrUndefined,
  );
const text = () => document.body.textContent ?? '';
const type = (id: string, typed: string) =>
  acted(() => {
    const input = Option.getOrThrow(maybeField(id));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const click = (label: string) => acted(() => button(label).click());

/** Opens the page on `resourceId` with the register at revision 4 and opens its edit dialog. */
const openEdit = (resourceId: string) =>
  Effect.gen(function* open() {
    yield* render(resourceId);
    yield* waitUntil(() => buttons(edit).length === 1 && !button(edit).disabled);
    yield* click(edit);
    yield* waitUntil(() => Option.isSome(maybeField(name)));
  });

/** A background reload of the register that answers once `gate` opens, with someone else's address. */
const reloadThrough = (gate: Deferred.Deferred<RecordsResponse>) =>
  Effect.gen(function* reload() {
    mocks.records.mockReturnValue(Deferred.await(gate));
    yield* acted(() => propertyRecords.invalidate());
  });

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(recordsAt(4, 'server-address')));
  mocks.employees.mockReset();
  mocks.employees.mockReturnValue(
    Effect.succeed([{ active: true, fullName: 'Jana', id: Schema.decodeUnknownSync(EmployeeIdSchema)(employeeId) }]),
  );
  mocks.apply.mockReset();
  mocks.apply.mockReturnValue(Effect.succeed({ resourceRef: { resourceId: firstId }, revision: 6 }));
  propertyRecords.invalidate();
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

describe('property edit dialog across a background reload', () => {
  it.live('keeps typed input, its status and the leave question; Save sends it against the old revision', () =>
    Effect.gen(function* typedSurvives() {
      yield* openEdit(firstId);
      yield* type(name, 'typed-name');
      expect(text()).toContain(labels.unsaved);

      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      // While the register reads `pending`, the dialog and the typed value stay on screen.
      expect(value(name)).toBe('typed-name');
      expect(text()).toContain(labels.unsaved);

      yield* Deferred.succeed(gate, recordsAt(5, 'someone-else-address'));
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2 && text().includes('someone-else-address'));
      expect(value(name)).toBe('typed-name');
      // A dirty draft keeps its whole input, not just the typed field.
      expect(value(address)).toBe('server-address');
      expect(text()).toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(false);

      yield* click(close);
      expect(buttons(labels.stay)).toHaveLength(1);
      yield* click(labels.stay);
      yield* waitUntil(() => buttons(labels.stay).length === 0);
      expect(value(name)).toBe('typed-name');

      mocks.records.mockImplementation(() => Effect.succeed(recordsAt(5, 'someone-else-address')));
      yield* click(labels.save);
      yield* waitUntil(() => mocks.apply.mock.calls.length > 0);
      expect(mocks.apply.mock.calls[0]?.[0]).toMatchObject({
        command: { name: 'typed-name' },
        expectedRevision: 4,
      });
    }),
  );

  it.live('a draft with nothing typed takes the reloaded building', () =>
    Effect.gen(function* cleanFollows() {
      yield* openEdit(firstId);
      expect(value(address)).toBe('server-address');
      const gate = yield* Deferred.make<RecordsResponse>();
      yield* reloadThrough(gate);
      expect(value(address)).toBe('server-address');
      yield* Deferred.succeed(gate, recordsAt(5, 'someone-else-address'));
      yield* waitUntil(() => value(address) === 'someone-else-address');
      expect(text()).not.toContain(labels.unsaved);
      expect(button(labels.save).disabled).toBe(true);
    }),
  );

  it.live('another building never shows the draft typed for this one', () =>
    Effect.gen(function* otherBuilding() {
      yield* openEdit(firstId);
      yield* type(name, 'typed-name');
      yield* click(close);
      yield* click(labels.discard);
      yield* waitUntil(() => Option.isNone(maybeField(name)));
      yield* render(secondId);
      yield* waitUntil(() => buttons(edit).length === 1);
      yield* click(edit);
      yield* waitUntil(() => Option.isSome(maybeField(name)));
      expect(value(name)).toBe('second-name');
      expect(text()).not.toContain('typed-name');
    }),
  );
});
