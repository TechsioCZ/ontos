// @rstest-environment happy-dom
import { acted, unmountAll, waitUntil } from '@app/admin-ui/testing/module-ui';
import {
  browserNetwork,
  networkIdle,
  networkQuietExcept,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Deferred, Effect, Schema } from 'effect';
import { afterEach, expect, it } from 'effect-rstest';
import { RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import type { RecordsResponse } from '../../shared/apis/records.ts';
import { employeesData } from '../../src/routes/[lang]/prodej/zamestnanci/employees-data.ts';
import { usePageData } from '../../src/runtime/use-page-data.ts';
import { mountInRoute } from '../support/module-ui.ts';

const company = '20000000-0000-4000-8000-000000000001';
const recordsAt = (revision: number, canWrite: boolean) =>
  Schema.decodeUnknownSync(RecordsResponseSchema)({
    actorPrincipalRef: {
      principalId: '30000000-0000-4000-8000-000000000001',
      tenantId: '10000000-0000-4000-8000-000000000001',
    },
    availablePrincipals: [],
    canWrite,
    indicators: {
      active: 0,
      byDepartment: [],
      byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
      total: 0,
    },
    items: [],
    revision,
  });

const EmployeeAccess = () => {
  const snapshot = usePageData(employeesData, company);
  return (
    <output>
      {snapshot.state === 'ready' ? `${snapshot.value.canWrite}:${snapshot.value.revision}` : snapshot.state}
    </output>
  );
};
const shown = () => document.querySelector('output')?.textContent;
let answer: Effect.Effect<RecordsResponse> = Effect.succeed(recordsAt(7, true));
const OwnerApi = RecordsApi.prefix('/workforce-api');
const network = browserNetwork(
  shellGatewayIssuer({ workforce: '/workforce-api' }).application,
  serveApi(
    OwnerApi,
    HttpApiBuilder.group(OwnerApi, 'records', (group) => group.handle('execute', () => Effect.suspend(() => answer))),
  ),
);

afterEach(unmountAll);

it.live('employee readers retain write access and revision while reloading, then adopt the new response', () =>
  Effect.gen(function* employeeRevalidation() {
    yield* pinTestDocument;
    employeesData.invalidate();
    answer = Effect.succeed(recordsAt(7, true));
    yield* mountInRoute(<EmployeeAccess />, { url: '/cs/prodej/zamestnanci' });
    yield* waitUntil(() => shown() === 'true:7');
    yield* networkIdle;

    const arrived = yield* Deferred.make<true>();
    const response = yield* Deferred.make<RecordsResponse>();
    answer = Deferred.succeed(arrived, true).pipe(Effect.andThen(Deferred.await(response)));
    yield* acted(() => employeesData.invalidate());
    yield* Deferred.await(arrived);
    yield* networkQuietExcept(1);
    expect(shown()).toBe('true:7');

    yield* Deferred.succeed(response, recordsAt(8, false));
    yield* waitUntil(() => shown()?.endsWith(':8') === true);
    yield* networkIdle;
    expect(shown()).toBe('false:8');
  }).pipe(Effect.provide(network)),
);
