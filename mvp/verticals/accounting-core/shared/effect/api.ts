import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';

export const accountingCoreMarkerSchema = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const accountingCoreItemSchema = Schema.Struct({
  id: Schema.String,
  marker: accountingCoreMarkerSchema,
  title: Schema.String,
});

export const accountingCoreReadinessSchema = Schema.Struct({
  checks: Schema.Struct({
    effectBff: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: accountingCoreMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const accountingCoreCreatePayloadSchema = Schema.Struct({
  title: Schema.String,
});

export class AccountingCoreNotFound extends Schema.TaggedErrorClass<AccountingCoreNotFound>()(
  'AccountingCoreNotFound',
  {
    id: Schema.String,
  },
) {}

export const accountingCoreNotFoundSchema = AccountingCoreNotFound.pipe(HttpApiSchema.status(404));

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: string;
  traceId?: string;
}

export const accountingCoreEffectApi = HttpApi.make('AccountingCoreEffectApi').add(
  HttpApiGroup.make('accountingCore')
    .add(
      HttpApiEndpoint.get('list', '/effect/accounting-core', {
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: Schema.Struct({
          items: Schema.Array(accountingCoreItemSchema),
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/effect/accounting-core/readiness', {
        success: accountingCoreReadinessSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('get', '/effect/accounting-core/:id', {
        error: accountingCoreNotFoundSchema,
        params: {
          id: Schema.String,
        },
        success: accountingCoreItemSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('create', '/effect/accounting-core', {
        payload: accountingCoreCreatePayloadSchema,
        success: Schema.Struct({
          item: accountingCoreItemSchema,
        }),
      }),
    ),
);

export const accountingCoreOperationContexts = {
  create: {
    method: 'POST',
    operationId: 'AccountingCoreEffectApi:accountingCore:create',
    routePath: '/effect/accounting-core',
    source: 'generated-client',
  },
  get: {
    method: 'GET',
    operationId: 'AccountingCoreEffectApi:accountingCore:get',
    routePath: '/effect/accounting-core/:id',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'AccountingCoreEffectApi:accountingCore:list',
    routePath: '/effect/accounting-core',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'AccountingCoreEffectApi:accountingCore:readiness',
    routePath: '/effect/accounting-core/readiness',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const accountingCoreApiContract = {
  apiPrefix: '/accounting-core-api',
  basePath: '/accounting-core-api/effect/accounting-core',
  ownerId: 'accounting-core',
  readinessPath: '/accounting-core-api/effect/accounting-core/readiness',
} as const;
