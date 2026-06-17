import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import { propertiesApiContract, propertiesEffectApi } from '../../shared/effect/api';

export { Effect, runEffectRequest };

export interface PropertiesClientOptions {
  baseUrl?: string | URL;
  locale?: string;
  traceparent?: string;
}

interface CreateUnitResult {
  readonly status: 'ok';
}

interface CreateUnitRequestFailed {
  readonly _tag: 'CreateUnitRequestFailed';
  readonly cause: unknown;
}

type CreateUnitEffect = Effect.Effect<CreateUnitResult, CreateUnitRequestFailed, never>;

const createUnitRequestFailed = (cause: unknown): CreateUnitRequestFailed => ({
  _tag: 'CreateUnitRequestFailed',
  cause,
});

const defaultPropertiesApiBaseUrl =
  typeof ULTRAMODERN_PROPERTIES_API_URL === 'string'
    ? ULTRAMODERN_PROPERTIES_API_URL
    : propertiesApiContract.apiPrefix;

const createPropertiesClient = (options: PropertiesClientOptions = {}) =>
  makeEffectHttpApiClient(propertiesEffectApi, {
    baseUrl: options.baseUrl ?? defaultPropertiesApiBaseUrl,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const createUnit = (options: PropertiesClientOptions = {}): CreateUnitEffect =>
  createPropertiesClient(options).pipe(
    Effect.flatMap((client) => client.properties.createUnit({ payload: {} })),
    Effect.mapError(createUnitRequestFailed),
  );
