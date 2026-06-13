import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const propertyRegistryMarkerSchema = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const propertyRegistryItemSchema = Schema.Struct({
  id: Schema.String,
  marker: propertyRegistryMarkerSchema,
  title: Schema.String,
});

export const propertyRegistryReadinessSchema = Schema.Struct({
  checks: Schema.Struct({
    effectBff: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: propertyRegistryMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const propertyRegistryCreatePayloadSchema = Schema.Struct({
  title: Schema.String,
});

export class PropertyRegistryNotFound extends Schema.TaggedErrorClass<PropertyRegistryNotFound>()(
  'PropertyRegistryNotFound',
  {
    id: Schema.String,
  },
) {}

export const propertyRegistryNotFoundSchema = PropertyRegistryNotFound.pipe(
  HttpApiSchema.status(404),
);

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: string;
  traceId?: string;
}

export const propertyRegistryEffectApi = HttpApi.make('PropertyRegistryEffectApi').add(
  HttpApiGroup.make('propertyRegistry')
    .add(
      HttpApiEndpoint.get('list', '/effect/property-registry', {
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: Schema.Struct({
          items: Schema.Array(propertyRegistryItemSchema),
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/effect/property-registry/readiness', {
        success: propertyRegistryReadinessSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('get', '/effect/property-registry/:id', {
        error: propertyRegistryNotFoundSchema,
        params: {
          id: Schema.String,
        },
        success: propertyRegistryItemSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('create', '/effect/property-registry', {
        payload: propertyRegistryCreatePayloadSchema,
        success: Schema.Struct({
          item: propertyRegistryItemSchema,
        }),
      }),
    ),
);

export const propertyRegistryOperationContexts = {
  create: {
    method: 'POST',
    operationId: 'PropertyRegistryEffectApi:propertyRegistry:create',
    routePath: '/effect/property-registry',
    source: 'generated-client',
  },
  get: {
    method: 'GET',
    operationId: 'PropertyRegistryEffectApi:propertyRegistry:get',
    routePath: '/effect/property-registry/:id',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'PropertyRegistryEffectApi:propertyRegistry:list',
    routePath: '/effect/property-registry',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'PropertyRegistryEffectApi:propertyRegistry:readiness',
    routePath: '/effect/property-registry/readiness',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const propertyRegistryApiContract = {
  apiPrefix: '/property-registry-api',
  basePath: '/property-registry-api/effect/property-registry',
  ownerId: 'property-registry',
  readinessPath: '/property-registry-api/effect/property-registry/readiness',
} as const;
