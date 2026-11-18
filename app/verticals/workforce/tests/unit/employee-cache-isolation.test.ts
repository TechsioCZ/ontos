// @rstest-environment happy-dom
import { acted, settle, unmountAll } from '@app/admin-ui/testing/module-ui';
import { moduleChangeEvent } from '@app/shared-contracts/page-data';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Effect, Result, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { createElement } from 'react';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { employeesData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { usePageData } from '../../src/runtime/use-page-data.ts';
import { mountInRoute } from '../support/module-ui.ts';

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

let answer: Effect.Effect<typeof allowed, typeof denied> = Effect.succeed(allowed);
const OwnerRecordsApi = RecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(
    OwnerRecordsApi,
    HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
      group.handle('execute', () => Effect.suspend(() => answer)),
    ),
  ),
);

afterEach(unmountAll);

it.live('a denied revalidation clears the rows the allowed read left on the same company', () =>
  Effect.gen(function* deniedRevalidation() {
    yield* pinTestDocument;
    answer = Effect.succeed(allowed);
    yield* employeesData.read(company);
    expect(employeesData.snapshot(company)).toEqual({ refreshing: false, state: 'ready', value: allowed });
    yield* mountInRoute(createElement(EmployeesProbe), { url: '/cs/prodej/zamestnanci' });
    expect(document.querySelector('output')?.outerHTML).toBe('<output>ready</output>');

    // The real hook keeps the list mounted while the live channel announces a committed change.
    answer = Effect.fail(denied);
    yield* acted(() => {
      window.dispatchEvent(new Event(moduleChangeEvent));
    });
    // Await the revalidation the mounted list started; the strict read path propagates the denial.
    expect(yield* Effect.result(employeesData.read(company))).toEqual(Result.fail('forbidden'));
    // The rows must not survive it: the page shows the forbidden state, never the previous reader's list.
    expect(employeesData.snapshot(company)).toEqual({ error: 'forbidden', refreshing: false, state: 'failed' });
    yield* settle;
    expect(document.querySelector('output')?.outerHTML).toBe('<output>failed</output>');
  }).pipe(Effect.provide(network)),
);
