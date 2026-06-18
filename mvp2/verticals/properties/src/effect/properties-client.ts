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

export interface CreateUnitOptions extends PropertiesClientOptions {
  idempotencyKey?: string;
  unitName: string;
}

interface CreateUnitResult {
  readonly status: 'ok';
}

interface ReadUnitResult {
  readonly createdAt: string;
  readonly name: string;
  readonly unitId: string;
}

type ReadUnitsResult = readonly ReadUnitResult[];

interface CreateUnitRequestFailed {
  readonly _tag: 'CreateUnitRequestFailed';
  readonly cause: unknown;
}

interface ReadUnitsRequestFailed {
  readonly _tag: 'ReadUnitsRequestFailed';
  readonly cause: unknown;
}

type CreateUnitEffect = Effect.Effect<CreateUnitResult, CreateUnitRequestFailed, never>;
type ReadUnitsEffect = Effect.Effect<ReadUnitsResult, ReadUnitsRequestFailed, never>;

const createUnitRequestFailed = (cause: unknown): CreateUnitRequestFailed => ({
  _tag: 'CreateUnitRequestFailed',
  cause,
});

const readUnitsRequestFailed = (cause: unknown): ReadUnitsRequestFailed => ({
  _tag: 'ReadUnitsRequestFailed',
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

export const createUnit = (options: CreateUnitOptions): CreateUnitEffect =>
  createPropertiesClient(options).pipe(
    Effect.flatMap((client) => {
      type CreateUnitRequest = Parameters<typeof client.properties.createUnit>[0];
      const request = {
        ...(options.idempotencyKey === undefined
          ? {}
          : { headers: { 'idempotency-key': options.idempotencyKey } }),
        payload: options.unitName,
      } as CreateUnitRequest;

      return client.properties.createUnit(request);
    }),
    Effect.mapError(createUnitRequestFailed),
  );

export const readUnits = (options: PropertiesClientOptions = {}): ReadUnitsEffect =>
  createPropertiesClient(options).pipe(
    Effect.flatMap((client) => client.properties.readUnits({})),
    Effect.mapError(readUnitsRequestFailed),
  );
