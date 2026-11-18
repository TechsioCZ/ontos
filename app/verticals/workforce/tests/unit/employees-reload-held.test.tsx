// @rstest-environment happy-dom
// The employees list while it reloads in the background (a live change, the 20 s freshness window, a settled write).
// The strict employees store reads `pending` during such a reload; the page's reader must keep the last ready list,
// so an open employee panel keeps its write access, its account choices and the revision its save goes out against.
// A refused reload still replaces the list at once.
import { acted, settle, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsForbiddenProblemSchema, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsRequest, RecordsResponse } from '../../shared/apis/records.ts';
import { employeesData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { usePageData } from '../../src/runtime/use-page-data.ts';
import { mountInRoute } from '../support/module-ui.ts';

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

let answer: Effect.Effect<RecordsResponse, typeof RecordsForbiddenProblemSchema.Type> = Effect.succeed(recordsAt(7));
const reads: RecordsRequest[] = [];
const OwnerRecordsApi = RecordsApi.prefix('/workforce-api');
const workforceOwner = HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
  group.handle('execute', ({ payload }) =>
    Effect.suspend(() => {
      reads.push(payload);
      return answer;
    }),
  ),
);
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(OwnerRecordsApi, workforceOwner),
);

/** What the page derives from the list: its state, write access and the revision a save goes out against. */
const Probe = () => {
  const snapshot = usePageData(employeesData, company);
  return (
    <output>
      {snapshot.state === 'ready' ? `ready:${snapshot.value.canWrite}:${snapshot.value.revision}` : snapshot.state}
    </output>
  );
};

const shown = () => document.querySelector('output')?.textContent ?? '';
const mount = Effect.gen(function* mountProbe() {
  yield* pinTestDocument;
  yield* mountInRoute(<Probe />, { url: '/cs/prodej/zamestnanci' });
  yield* waitUntil(() => shown() === 'ready:true:7');
});

beforeEach(() => {
  reads.length = 0;
  answer = Effect.succeed(recordsAt(7));
  employeesData.invalidate();
});

afterEach(unmountAll);

describe('employees list across a background reload', () => {
  it.live('keeps the last ready list, its write access and revision while the same list reloads', () =>
    Effect.gen(function* held() {
      yield* mount;
      const arrived = yield* Deferred.make<true>();
      const gate = yield* Deferred.make<RecordsResponse>();
      answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(gate)));
      yield* acted(() => employeesData.invalidate());
      yield* Deferred.await(arrived);
      expect(reads.length).toBeGreaterThanOrEqual(2);
      yield* settle;
      expect(shown()).toBe('ready:true:7');
      yield* Deferred.succeed(gate, recordsAt(8));
      yield* waitUntil(() => shown() === 'ready:true:8');
    }).pipe(Effect.provide(network)),
  );

  it.live('a refused reload replaces the list at once', () =>
    Effect.gen(function* refusedReload() {
      yield* mount;
      answer = Effect.fail(refused);
      yield* acted(() => employeesData.invalidate());
      yield* waitUntil(() => shown() === 'failed');
    }).pipe(Effect.provide(network)),
  );
});
