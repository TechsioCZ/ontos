import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const accountingMarkerSchema = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const accountingItemSchema = Schema.Struct({
  id: Schema.String,
  marker: accountingMarkerSchema,
  title: Schema.String,
});

export const accountingReadinessSchema = Schema.Struct({
  checks: Schema.Struct({
    effectBff: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: accountingMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const accountingCreatePayloadSchema = Schema.Struct({
  title: Schema.String,
});

export const accountingNotFoundSchema = Schema.TaggedStruct('AccountingNotFound', {
  id: Schema.String,
}).pipe(HttpApiSchema.status(404));

export type AccountingNotFound = typeof accountingNotFoundSchema.Type;

export const createAccountingNotFound = (id: string): AccountingNotFound => ({
  _tag: 'AccountingNotFound',
  id,
});

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

export const accountingEffectApi = HttpApi.make('AccountingEffectApi').add(
  HttpApiGroup.make('accounting')
    .add(
      HttpApiEndpoint.get('list', '/effect/accounting', {
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: Schema.Struct({
          items: Schema.Array(accountingItemSchema),
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/effect/accounting/readiness', {
        success: accountingReadinessSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('get', '/effect/accounting/:id', {
        error: accountingNotFoundSchema,
        params: {
          id: Schema.String,
        },
        success: accountingItemSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('create', '/effect/accounting', {
        payload: accountingCreatePayloadSchema,
        success: Schema.Struct({
          item: accountingItemSchema,
        }),
      }),
    ),
);

export const accountingOperationContexts = {
  create: {
    method: 'POST',
    operationId: 'AccountingEffectApi:accounting:create',
    routePath: '/effect/accounting',
    source: 'generated-client',
  },
  get: {
    method: 'GET',
    operationId: 'AccountingEffectApi:accounting:get',
    routePath: '/effect/accounting/:id',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'AccountingEffectApi:accounting:list',
    routePath: '/effect/accounting',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'AccountingEffectApi:accounting:readiness',
    routePath: '/effect/accounting/readiness',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const accountingApiContract = {
  apiPrefix: '/accounting-api',
  basePath: '/accounting-api/effect/accounting',
  ownerId: 'accounting',
  readinessPath: '/accounting-api/effect/accounting/readiness',
} as const;
