import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const unitCreatePayloadSchema = Schema.Struct({});

export const unitCreateResultSchema = Schema.Struct({
  status: Schema.Literal('ok'),
});

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

export const propertiesEffectApi = HttpApi.make('PropertiesEffectApi').add(
  HttpApiGroup.make('properties').add(
    HttpApiEndpoint.post('createUnit', '/effect/properties/unit', {
      payload: unitCreatePayloadSchema,
      success: unitCreateResultSchema,
    }),
  ),
);

export const propertiesOperationContexts = {
  createUnit: {
    method: 'POST',
    operationId: 'PropertiesEffectApi:properties:createUnit',
    routePath: '/effect/properties/unit',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const propertiesApiContract = {
  apiPrefix: '/properties-api',
  basePath: '/properties-api/effect/properties',
  ownerId: 'properties',
  readinessPath: '/properties-api/effect/properties/readiness',
} as const;
