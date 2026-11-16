// @rstest-environment happy-dom
// The employees list while it reloads in the background (a live change, the 20 s freshness window, a settled write).
// The strict employees store reads `pending` during such a reload; the page's reader must keep the last ready list,
// so an open employee panel keeps its write access, its account choices and the revision its save goes out against.
// A refused reload still replaces the list at once.
import { constVoid } from 'effect/Function';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it, rstest } from 'effect-rstest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { employeesData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { browserRuntime } from '../../src/runtime/browser-effect-runtime.ts';
import { usePageData } from '../../src/runtime/use-page-data.ts';

const mocks = rstest.hoisted(() => ({ records: rstest.fn() }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: mocks.records }));

const company = '20000000-0000-4000-8000-000000000001';
const tenantId = '10000000-0000-4000-8000-000000000001';
const recordsAt = (revision: number): RecordsResponse =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: { principalId: '30000000-0000-4000-8000-000000000001', tenantId },
    availablePrincipals: [],
    canWrite: true,
    indicators: {
      active: 1,
      byDepartment: [{ count: 1, department: 'sales' }],
      byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 1, SUPPORT: 0, WAREHOUSE: 0 },
      total: 1,
    },
    items: [
      {
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        department: 'sales',
        email: 'first@example.test',
        fullName: 'first-employee',
        id: '50000000-0000-4000-8000-000000000001',
        role: 'SALES_REP',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    revision,
  });
const refused = Schema.decodeUnknownSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'refused',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:refused',
});

/** What the page derives from the list: its state, write access and the revision a save goes out against. */
const Probe = () => {
  const snapshot = usePageData(employeesData, company);
  return createElement(
    'output',
    null,
    snapshot.state === 'ready' ? `ready:${snapshot.value.canWrite}:${snapshot.value.revision}` : snapshot.state,
  );
};

const settle: Effect.Effect<void> = Effect.promise(() => browserRuntime.runPromise(Effect.yieldNow)).pipe(
  Effect.andThen(
    Effect.sync(() => {
      act(constVoid);
    }),
  ),
);
const shown = () => document.querySelector('output')?.textContent ?? '';
const waitUntil = (condition: () => boolean, attempt = 0): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (condition() || attempt >= 200) {
      return Effect.sync(() => {
        expect(condition()).toBe(true);
      });
    }
    return settle.pipe(Effect.andThen(waitUntil(condition, attempt + 1)));
  });

const roots: { readonly container: HTMLElement; readonly root: Root }[] = [];
const mount = Effect.sync(() => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ container, root });
  act(() => {
    root.render(createElement(Probe));
  });
}).pipe(Effect.andThen(waitUntil(() => shown() === 'ready:true:7')));

beforeEach(() => {
  rstest.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.records.mockReset();
  mocks.records.mockImplementation(() => Effect.succeed(recordsAt(7)));
  employeesData.invalidate();
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

describe('employees list across a background reload', () => {
  it.live('keeps the last ready list, its write access and revision while the same list reloads', () =>
    Effect.gen(function* held() {
      yield* mount;
      const gate = yield* Deferred.make<RecordsResponse>();
      mocks.records.mockReturnValue(Deferred.await(gate));
      act(() => {
        employeesData.invalidate();
      });
      yield* waitUntil(() => mocks.records.mock.calls.length >= 2);
      expect(shown()).toBe('ready:true:7');
      yield* Deferred.succeed(gate, recordsAt(8));
      yield* waitUntil(() => shown() === 'ready:true:8');
    }),
  );

  it.live('a refused reload replaces the list at once', () =>
    Effect.gen(function* refusedReload() {
      yield* mount;
      mocks.records.mockReturnValue(Effect.fail(refused));
      act(() => {
        employeesData.invalidate();
      });
      yield* waitUntil(() => shown() === 'failed');
    }),
  );
});
