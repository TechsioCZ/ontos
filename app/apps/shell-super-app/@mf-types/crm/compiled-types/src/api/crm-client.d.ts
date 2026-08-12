import { Effect } from '@modern-js/plugin-bff/effect-client';
import type { HttpClientError, HttpApi, HttpApiClient, HttpApiGroup, Schema } from '@modern-js/plugin-bff/effect-client';
import { crmApi } from '../../shared/api';
import type { CrmReadiness, OperationContext } from '../../shared/api';
export { Effect, runEffectRequest } from '@modern-js/plugin-bff/effect-client';
type CrmApiGroups = typeof crmApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;
export type CrmClient = HttpApiClient.Client<Extract<CrmApiGroups, HttpApiGroup.Any>, never, never>;
export type CrmClientError = HttpClientError.HttpClientError | Schema.SchemaError;
export type CrmClientEffect<Success> = Effect.Effect<Success, CrmClientError, never>;
export interface CrmClientOptions {
    baseUrl?: string | URL;
    locale?: string;
    operationContext?: OperationContext;
    traceparent?: string;
}
export declare const createCrmClient: (options?: CrmClientOptions) => CrmClientEffect<CrmClient>;
export declare const getCrmReadiness: (options?: CrmClientOptions) => CrmClientEffect<CrmReadiness>;
