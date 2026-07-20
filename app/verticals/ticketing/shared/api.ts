import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  createTaskActionHeadersSchema,
  createTaskActionFailureSchemas,
  createTaskActionOutcomeSchema,
  createTaskActionPayloadSchema,
} from './actions/create-task';
import {
  createTaskCollectionActionHeadersSchema,
  createTaskCollectionActionFailureSchemas,
  createTaskCollectionActionOutcomeSchema,
  createTaskCollectionActionPayloadSchema,
} from './actions/create-task-collection';
import {
  coreSdkOperationFailureSchemas,
  operationContextHeadersSchema,
} from './core-sdk-operation';
import { taskCollectionAggregateSchema } from './task-collection';

export type {
  CreateTaskActionFailure,
  CreateTaskActionOutcome,
  CreateTaskActionPayload,
  CreateTaskActionResponse,
} from './actions/create-task';
export type {
  CreateTaskCollectionActionFailure,
  CreateTaskCollectionActionOutcome,
  CreateTaskCollectionActionPayload,
  CreateTaskCollectionActionResponse,
} from './actions/create-task-collection';
export type { TaskCollectionAggregate } from './task-collection';

export interface TicketingMarker {
  readonly appId: string;
  readonly build: string;
  readonly deployProfile: string;
  readonly packageName: string;
  readonly surface: string;
  readonly version: string;
}

export interface TicketingItem {
  readonly id: string;
  readonly marker: TicketingMarker;
  readonly title: string;
}

export interface TicketingReadiness {
  readonly checks: {
    readonly api: 'ready';
    readonly moduleFederation: 'ready';
    readonly ssr: 'ready';
    readonly translations: 'ready';
  };
  readonly marker: TicketingMarker;
  readonly status: 'ready';
  readonly versionSkew: 'none';
}

export interface TicketingListResponse {
  readonly items: readonly TicketingItem[];
}

export interface TicketingNotFound {
  readonly _tag: 'TicketingNotFound';
  readonly id: string;
}

export const ticketingMarkerSchema: Schema.Codec<TicketingMarker> = Schema.Struct({
  appId: Schema.String,
  build: Schema.String,
  deployProfile: Schema.String,
  packageName: Schema.String,
  surface: Schema.String,
  version: Schema.String,
});

export const ticketingItemSchema: Schema.Codec<TicketingItem> = Schema.Struct({
  id: Schema.String,
  marker: ticketingMarkerSchema,
  title: Schema.String,
});

export const ticketingReadinessSchema: Schema.Codec<TicketingReadiness> = Schema.Struct({
  checks: Schema.Struct({
    api: Schema.Literal('ready'),
    moduleFederation: Schema.Literal('ready'),
    ssr: Schema.Literal('ready'),
    translations: Schema.Literal('ready'),
  }),
  marker: ticketingMarkerSchema,
  status: Schema.Literal('ready'),
  versionSkew: Schema.Literal('none'),
});

export const ticketingNotFoundSchema: Schema.Codec<TicketingNotFound> = Schema.TaggedStruct(
  'TicketingNotFound',
  {
    id: Schema.String,
  },
).pipe(HttpApiSchema.status(404));

export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}

export const ticketingApi = HttpApi.make('TicketingApi').add(
  HttpApiGroup.make('ticketing')
    .add(
      HttpApiEndpoint.get('list', '/ticketing', {
        query: {
          limit: Schema.optional(Schema.FiniteFromString),
        },
        success: Schema.Struct({
          items: Schema.Array(ticketingItemSchema),
        }),
      }),
    )
    .add(
      HttpApiEndpoint.get('readiness', '/ticketing/readiness', {
        success: ticketingReadinessSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('get', '/ticketing/:id', {
        error: ticketingNotFoundSchema,
        params: {
          id: Schema.String,
        },
        success: ticketingItemSchema,
      }),
    )
    .add(
      HttpApiEndpoint.get('getTaskCollection', '/ticketing/task-collections/:collectionId', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        params: {
          collectionId: Schema.String,
        },
        success: taskCollectionAggregateSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'createTaskCollectionAction',
        '/ticketing/actions/create-task-collection',
        {
          error: createTaskCollectionActionFailureSchemas,
          headers: createTaskCollectionActionHeadersSchema,
          payload: createTaskCollectionActionPayloadSchema,
          success: createTaskCollectionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createTaskAction', '/ticketing/actions/create-task', {
        error: createTaskActionFailureSchemas,
        headers: createTaskActionHeadersSchema,
        payload: createTaskActionPayloadSchema,
        success: createTaskActionOutcomeSchema,
      }),
    ),
);

export const ticketingOperationContexts = {
  createTaskAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTaskAction',
    routePath: '/ticketing/actions/create-task',
    source: 'generated-client',
  },
  createTaskCollectionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTaskCollectionAction',
    routePath: '/ticketing/actions/create-task-collection',
    source: 'generated-client',
  },
  get: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:get',
    routePath: '/ticketing/:id',
    source: 'generated-client',
  },
  getTaskCollection: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskCollection',
    routePath: '/ticketing/task-collections/:collectionId',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:list',
    routePath: '/ticketing',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:readiness',
    routePath: '/ticketing/readiness',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const ticketingApiContract = {
  apiPrefix: '/ticketing-api',
  basePath: '/ticketing-api/ticketing',
  ownerId: 'ticketing',
  readinessPath: '/ticketing-api/ticketing/readiness',
} as const;
