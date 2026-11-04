import { afterAll, beforeAll, expect, it, rstest } from 'effect-rstest';
import { Effect, Result, Schema } from 'effect';
import { createElement } from 'react';
import type ReactRuntime from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import { RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-consumer.ts';
import { employeesData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { usePageData } from '../../src/runtime/use-page-data.ts';

rstest.mock('../../src/api/records-consumer.ts');
// Renders the real `usePageData` snapshot without React's client subscription: the probe shows what the page's
// `loadStateOf` turns into rows (`ready`) or into the forbidden empty state (`failed`).
rstest.mock('react', () => ({
  ...rstest.requireActual<typeof ReactRuntime>('react'),
  useSyncExternalStore: <Value>(_subscribe: (listener: () => void) => () => void, snapshot: () => Value) => snapshot(),
}));

const events = new EventTarget();
const browserGlobals = {
  addEventListener: events.addEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
  document: {},
  removeEventListener: events.removeEventListener.bind(events),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(browserGlobals)) {
    Reflect.set(globalThis, name, value);
  }
});

afterAll(() => {
  for (const name of Object.keys(browserGlobals)) {
    Reflect.deleteProperty(globalThis, name);
  }
});

/**
 * The candidate: the employees entry is keyed by the legal entity alone, and a denied revalidation keeps the old
 * rows on screen.
 *
 * Reachability: the Shell ends the session scope and reloads the document on every sign-in, sign-out, tenant,
 * legal-entity and context switch (`use-shell-controls.ts`, `session-scope.ts`, `live-changes.ts`), and the sign-in
 * page opens as a fresh document (`sign-in-return.ts`), so another principal never reads this document's entry; a
 * cross-principal cache assertion would pin a state the architecture cannot reach. What is reachable in one
 * document is the same company's mounted list revalidating after access narrows: a committed change through the
 * live channel, or the page's own reload after a write. That revalidation must not leave the allowed reader's rows
 * on screen, which is what this test pins.
 */
const company = '20000000-0000-4000-8000-000000000001';

const allowed = Schema.decodeUnknownSync(RecordsResponseSchema)({
  actorPrincipalRef: {
    principalId: '30000000-0000-4000-8000-000000000001',
    tenantId: '10000000-0000-4000-8000-000000000001',
  },
  availablePrincipals: [],
  canWrite: false,
  indicators: {
    active: 1,
    byDepartment: [{ count: 1, department: 'Obchod' }],
    byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 1, SUPPORT: 0, WAREHOUSE: 0 },
    total: 1,
  },
  items: [
    {
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      department: 'Obchod',
      email: 'jana.prvni@example.test',
      fullName: 'Jana První',
      id: '50000000-0000-4000-8000-000000000001',
      role: 'SALES_REP',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  revision: 7,
});

const denied = Schema.decodeUnknownSync(RecordsForbiddenProblemSchema)({
  _tag: 'RecordsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:denied',
});

const EmployeesProbe = () => createElement('output', null, usePageData(employeesData, company).state);

it.effect('a denied revalidation clears the rows the allowed read left on the same company', () =>
  Effect.gen(function* deniedRevalidation() {
    rstest.mocked(executeRecords).mockReturnValue(Effect.succeed(allowed));
    yield* employeesData.read(company);
    expect(employeesData.snapshot(company)).toEqual({ refreshing: false, state: 'ready', value: allowed });
    expect(renderToStaticMarkup(createElement(EmployeesProbe))).toBe('<output>ready</output>');

    // The page is shown: its hook keeps the entry mounted while the live channel announces a committed change.
    const unmount = employeesData.subscribe(() => {
      employeesData.snapshot(company);
    }, company);
    try {
      rstest.mocked(executeRecords).mockReturnValue(Effect.fail(denied));
      globalThis.dispatchEvent(new Event(moduleChangeEvent));
      // Await the revalidation the mounted list started; the strict read path already propagates the denial.
      expect(yield* Effect.result(employeesData.read(company))).toEqual(Result.fail('forbidden'));
      // The rows must not survive it: the page shows the forbidden state, never the previous reader's list.
      expect(employeesData.snapshot(company)).toEqual({ error: 'forbidden', refreshing: false, state: 'failed' });
      expect(renderToStaticMarkup(createElement(EmployeesProbe))).toBe('<output>failed</output>');
    } finally {
      unmount();
    }
  }),
);
