/* eslint-disable oxc/no-barrel-file, sonarjs/no-wildcard-import -- The published client entrypoint aggregates generated governed operation clients; expires: 2027-03-31. */
import { Effect, makeEffectHttpApiClient } from '@modern-js/bff-effect/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/bff-effect/effect-client';

import { assortmentApiContract, assortmentApi, assortmentOperationContexts } from '../../shared/api';
import type { OperationContext, AssortmentReadiness } from '../../shared/api';

export { Effect, runEffectRequest } from '@modern-js/bff-effect/effect-client';

// <generated-action-http-client-exports>
export * from './create-applicability-binding-action-client.ts';
export * from './create-closed-assortment-boundary-action-client.ts';
export * from './create-rule-action-client.ts';
export * from './create-rule-revision-action-client.ts';
export * from './end-applicability-binding-action-client.ts';
export * from './end-closed-assortment-boundary-action-client.ts';
export * from './issue-assortment-commitment-confirmation-action-client.ts';
export * from './replace-applicability-binding-action-client.ts';
export * from './replace-closed-assortment-boundary-action-client.ts';
export * from './retire-rule-action-client.ts';
// </generated-action-http-client-exports>

export * from './configuration-client.ts';
export * from './decision-explanation-client.ts';
export * from './visibility-client.ts';
export * from './purchase-client.ts';

type AssortmentApiGroups = typeof assortmentApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type AssortmentClient = HttpApiClient.Client<Extract<AssortmentApiGroups, HttpApiGroup.Constraint>>;

export type AssortmentClientError = HttpClientError.HttpClientError | Schema.SchemaError;

export type AssortmentClientEffect<Success> = Effect.Effect<Success, AssortmentClientError>;

export interface AssortmentClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

export const createAssortmentClient = (
  options: AssortmentClientOptions = {},
): AssortmentClientEffect<AssortmentClient> =>
  Effect.gen(function* makeAssortmentClient() {
    const requestContext = {
      ...(options.locale === undefined ? undefined : { locale: options.locale }),
      ...(options.operationContext === undefined ? undefined : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? undefined : { traceparent: options.traceparent }),
    };
    return yield* makeEffectHttpApiClient(assortmentApi, {
      baseUrl: options.baseUrl ?? assortmentApiContract.apiPrefix,
      requestContext,
    });
  });

export const getAssortmentReadiness = (
  options: AssortmentClientOptions = {},
): AssortmentClientEffect<AssortmentReadiness> =>
  createAssortmentClient({
    ...options,
    operationContext: options.operationContext ?? assortmentOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.foundation.readiness({})));
