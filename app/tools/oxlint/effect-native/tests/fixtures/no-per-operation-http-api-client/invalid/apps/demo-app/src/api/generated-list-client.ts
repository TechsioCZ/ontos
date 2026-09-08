// expect-count: 2
// A8/A9: the generated `execute*WithAuthorization` helper shape.
import { Effect } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import { CustomerListApi } from './api.ts';
import { operationGateway } from './gateway.ts';

export const executeCustomerListWithAuthorization = (
  payload: { readonly page: number },
  authorization: string,
  correlationId: string,
) =>
  makeEffectHttpApiClient(CustomerListApi, {
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.setHeaders({ authorization, 'x-correlation-id': correlationId }),
    ),
  }).pipe(Effect.flatMap((client) => client.customerList.getCustomerList({ payload })));

export const executeCustomerList = (payload: { readonly page: number }, correlationId: string) =>
  operationGateway.invoke((authorization: string) =>
    executeCustomerListWithAuthorization(payload, authorization, correlationId),
  );
