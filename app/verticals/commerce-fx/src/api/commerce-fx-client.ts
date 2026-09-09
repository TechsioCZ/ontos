import { Effect, makeEffectHttpApiClient } from '@modern-js/plugin-bff/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

import {
  commerceFxApiContract,
  commerceFxApi,
  commerceFxOperationContexts,
} from '../../shared/api.ts';
import type { OperationContext, CommerceFxReadiness } from '../../shared/api.ts';

export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
// <generated-action-http-client-exports>
export * from './change-manual-commercial-rate-policy-action-client.ts';
// </generated-action-http-client-exports>
export {
  executeCommercialFxConversion,
  executeCommercialFxConversionWithAuthorization,
} from './commercial-fx-conversion-client.ts';
export type { CommercialFxConversionClientOptions } from './commercial-fx-conversion-client.ts';
export {
  CommercialFxConversionRequestSchema,
  CommercialFxConversionResponseSchema,
} from '../../shared/api.ts';
export type {
  CommercialFxConversionRequest,
  CommercialFxConversionResponse,
} from '../../shared/api.ts';

type CommerceFxApiGroups =
  typeof commerceFxApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type CommerceFxClient = HttpApiClient.Client<
  Extract<CommerceFxApiGroups, HttpApiGroup.Constraint>,
  never,
  never
>;

export type CommerceFxClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type CommerceFxClientEffect<Success> = Effect.Effect<Success, CommerceFxClientError, never>;

export interface CommerceFxClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createCommerceFxClient = (
  options: CommerceFxClientOptions = {},
): CommerceFxClientEffect<CommerceFxClient> =>
  makeEffectHttpApiClient(commerceFxApi, {
    baseUrl: options.baseUrl ?? commerceFxApiContract.apiPrefix,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const getCommerceFxReadiness = (
  options: CommerceFxClientOptions = {},
): CommerceFxClientEffect<CommerceFxReadiness> =>
  createCommerceFxClient({
    ...options,
    operationContext: options.operationContext ?? commerceFxOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
