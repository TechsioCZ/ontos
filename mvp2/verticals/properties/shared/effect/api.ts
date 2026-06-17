import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const unitCreatePayloadSchema = Schema.Struct({});

export const unitCreateResultSchema = Schema.Struct({
  status: Schema.Literal('ok'),
});

export const operationContextAuthRequiredSchema = Schema.TaggedStruct(
  'OperationContextAuthRequired',
  {
    message: Schema.String,
  },
).pipe(HttpApiSchema.status(401));

export type OperationContextAuthRequired = typeof operationContextAuthRequiredSchema.Type;

export const createOperationContextAuthRequired = (
  message: string,
): OperationContextAuthRequired => ({
  _tag: 'OperationContextAuthRequired',
  message,
});

export const propertiesEffectApi = HttpApi.make('PropertiesEffectApi').add(
  HttpApiGroup.make('properties').add(
    HttpApiEndpoint.post('createUnit', '/effect/properties/unit', {
      error: operationContextAuthRequiredSchema,
      payload: unitCreatePayloadSchema,
      success: unitCreateResultSchema,
    }),
  ),
);

export const propertiesApiContract = {
  apiPrefix: '/properties-api',
  basePath: '/properties-api/effect/properties',
  ownerId: 'properties',
  readinessPath: '/properties-api/effect/properties/readiness',
} as const;
