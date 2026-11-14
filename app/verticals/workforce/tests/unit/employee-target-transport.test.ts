import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it, rstest } from 'effect-rstest';

import { executeRecords } from '../../src/api/records-client.ts';
import { executeFreshRecords } from '../../src/routes/[lang]/prodej/zamestnanci/employee-records.ts';
import { EmployeeIdSchema } from '../../shared/apis/records.ts';

rstest.mock('../../src/api/action-gateway.ts', () => ({
  operationGateway: {
    invoke: <Success, Failure>(
      attempt: (
        authorization: string,
        target: { readonly apiBaseUrl: string; readonly compositionRevision: string },
      ) => Effect.Effect<Success, Failure>,
    ) =>
      attempt('Bearer test-transport-credential', {
        apiBaseUrl: 'https://owner.example/workforce-api',
        compositionRevision: 'a'.repeat(64),
      }),
  },
}));

it.effect(
  'the actual generated owner client forwards fresh-read transport policy without changing the request or ordinary reads',
  () =>
    Effect.gen(function* targetReadTransport() {
      const employeeId = Schema.decodeUnknownSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000002');
      const requests: Request[] = [];
      const fakeFetch: typeof fetch = (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          Response.json({
            actorPrincipalRef: {
              principalId: '30000000-0000-4000-8000-000000000001',
              tenantId: '10000000-0000-4000-8000-000000000001',
            },
            availablePrincipals: [],
            canWrite: false,
            indicators: {
              active: 0,
              byDepartment: [],
              byRole: { ACCOUNTANT: 0, SALES_HEAD: 0, SALES_REP: 0, SUPPORT: 0, WAREHOUSE: 0 },
              total: 0,
            },
            items: [],
            revision: 7,
          }),
        );
      };
      yield* executeRecords({ employeeId }, 'ordinary-record').pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
      yield* executeFreshRecords({ employeeId }, 'current-target').pipe(
        Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      );
      expect(requests.map(({ headers }) => headers.get('cache-control'))).toEqual([null, 'no-store']);
      expect(requests.map(({ headers }) => headers.get('authorization'))).toEqual([
        'Bearer test-transport-credential',
        'Bearer test-transport-credential',
      ]);
      expect(requests.map(({ headers }) => headers.get('x-ontos-composition-revision'))).toEqual([
        'a'.repeat(64),
        'a'.repeat(64),
      ]);
      expect(requests.map(({ url }) => url)).toEqual([
        'https://owner.example/workforce-api/reads/records',
        'https://owner.example/workforce-api/reads/records',
      ]);
      for (const request of requests) {
        expect(yield* Effect.promise(() => request.json())).toEqual({ employeeId });
      }
    }),
);
