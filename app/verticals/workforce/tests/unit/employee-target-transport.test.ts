// @rstest-environment happy-dom
import {
  inProcessFetch,
  pinTestDocument,
  serveApi,
  shellGatewayIssuer,
  testCompositionRevision,
} from '@app/shared-contracts/testing/http-double';
import { HttpApiBuilder, HttpServerRequest } from '@modern-js/bff-effect/effect-edge';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { EmployeeIdSchema, RecordsApi, RecordsResponseSchema } from '../../shared/apis/records.ts';
import { executeRecords } from '../../src/api/records-client.ts';
import { executeFreshRecords } from '../../src/routes/[lang]/prodej/zamestnanci/employee-records.ts';

it.live(
  'the actual generated owner client forwards fresh-read transport policy without changing the request or ordinary reads',
  () =>
    Effect.gen(function* targetReadTransport() {
      yield* pinTestDocument;
      const employeeId = Schema.decodeUnknownSync(EmployeeIdSchema)('50000000-0000-4000-8000-000000000002');
      const response = Schema.decodeUnknownSync(RecordsResponseSchema)({
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
      });
      const requests: { readonly body: unknown; readonly headers: Headers; readonly url: string }[] = [];
      const issuer = shellGatewayIssuer({ workforce: '/workforce-api' });
      const OwnerRecordsApi = RecordsApi.prefix('/workforce-api');
      const owner = serveApi(
        OwnerRecordsApi,
        HttpApiBuilder.group(OwnerRecordsApi, 'records', (group) =>
          group.handle('execute', () =>
            Effect.gen(function* receiveRecords() {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const body = yield* request.json;
              requests.push({ body, headers: new Headers(request.headers), url: request.originalUrl });
              return response;
            }).pipe(Effect.orDie),
          ),
        ),
      );
      yield* Effect.gen(function* readEmployeeThroughGateway() {
        yield* executeRecords({ employeeId }, 'ordinary-record');
        yield* executeFreshRecords({ employeeId }, 'current-target');
      }).pipe(Effect.provide(inProcessFetch(issuer.application, owner)));
      expect(requests.map(({ headers }) => headers.get('cache-control'))).toEqual([null, 'no-store']);
      expect(requests.map(({ headers }) => headers.get('authorization'))).toEqual([
        'Bearer workforce-assertion-1',
        'Bearer workforce-assertion-2',
      ]);
      expect(requests.map(({ headers }) => headers.get('x-ontos-composition-revision'))).toEqual([
        testCompositionRevision,
        testCompositionRevision,
      ]);
      expect(requests.map(({ url }) => url)).toEqual([
        new URL('/workforce-api/reads/records', window.location.href).href,
        new URL('/workforce-api/reads/records', window.location.href).href,
      ]);
      for (const request of requests) {
        expect(request.body).toEqual({ employeeId });
      }
    }),
);
