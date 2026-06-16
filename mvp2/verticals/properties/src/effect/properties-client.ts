import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import {
  propertiesApiContract,
  propertiesEffectApi,
  propertiesOperationContexts,
} from '../../shared/effect/api';
import type { OperationContext } from '../../shared/effect/api';

export { Effect, runEffectRequest };

export interface PropertiesClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

interface CreateUnitResult {
  readonly status: 'ok';
}
type CreateUnitEffect = Effect.Effect<CreateUnitResult, Error, never>;

const defaultPropertiesApiBaseUrl =
  typeof ULTRAMODERN_PROPERTIES_API_URL === 'string'
    ? ULTRAMODERN_PROPERTIES_API_URL
    : propertiesApiContract.apiPrefix;

const createPropertiesClient = (options: PropertiesClientOptions = {}) =>
  makeEffectHttpApiClient(propertiesEffectApi, {
    baseUrl: options.baseUrl ?? defaultPropertiesApiBaseUrl,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const createUnit = (options: PropertiesClientOptions = {}): CreateUnitEffect =>
  createPropertiesClient({
    ...options,
    operationContext: options.operationContext ?? propertiesOperationContexts.createUnit,
  }).pipe(
    Effect.flatMap((client) => client.properties.createUnit({ payload: {} })),
  ) as CreateUnitEffect;
