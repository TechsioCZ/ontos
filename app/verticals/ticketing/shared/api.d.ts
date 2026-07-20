// oxlint-disable typescript/consistent-type-imports, import/newline-after-import, typescript/ban-types, typescript/no-empty-object-type -- TypeScript-generated API declaration
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
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
export declare const ticketingMarkerSchema: Schema.Codec<TicketingMarker>;
export declare const ticketingItemSchema: Schema.Codec<TicketingItem>;
export declare const ticketingReadinessSchema: Schema.Codec<TicketingReadiness>;
export declare const ticketingNotFoundSchema: Schema.Codec<TicketingNotFound>;
export interface OperationContext {
  method: string;
  operationId: string;
  routePath: string;
  source: 'client' | 'server' | 'generated-client' | 'effect-adapter' | 'data-platform' | 'unknown';
  traceId?: string;
}
export declare const ticketingApi: HttpApi.HttpApi<
  'TicketingApi',
  HttpApiGroup.HttpApiGroup<
    'ticketing',
    | HttpApiEndpoint.HttpApiEndpoint<
        'createTaskAction',
        'POST',
        '/ticketing/actions/create-task',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'Idempotency-Key': Schema.optional<Schema.String>;
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly actionInvocationId: Schema.optional<Schema.String>;
            readonly ok: Schema.Literal<true>;
            readonly response: Schema.Struct<{
              readonly task: Schema.Struct<{
                readonly collectionId: Schema.String;
                readonly createdAt: Schema.String;
                readonly createdByPrincipalId: Schema.String;
                readonly lastEditedAt: Schema.String;
                readonly lastEditedByPrincipalId: Schema.String;
                readonly revision: Schema.Finite;
                readonly taskId: Schema.String;
                readonly title: Schema.String;
              }>;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Union<
            readonly [
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthRequired', 'OperationContextInvalid']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly [
                    'OperationDomainRejected',
                    'OperationIdempotencyConflict',
                    'OperationIdempotencyReplayUnavailable',
                    'OperationPolicyDenied',
                  ]
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
                >;
              }>,
            ]
          >
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'createTaskCollectionAction',
        'POST',
        '/ticketing/actions/create-task-collection',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<Schema.Struct<{}>>,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'Idempotency-Key': Schema.optional<Schema.String>;
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly actionInvocationId: Schema.optional<Schema.String>;
            readonly ok: Schema.Literal<true>;
            readonly response: Schema.Struct<{
              readonly collection: Schema.Struct<{
                readonly collectionId: Schema.String;
                readonly createdAt: Schema.String;
                readonly schemaId: Schema.String;
              }>;
              readonly schema: Schema.Struct<{
                readonly collectionId: Schema.String;
                readonly propertyDefinitions: Schema.$Array<
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'title'>;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                  }>
                >;
                readonly schemaId: Schema.String;
              }>;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Union<
            readonly [
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthRequired', 'OperationContextInvalid']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly [
                    'OperationDomainRejected',
                    'OperationIdempotencyConflict',
                    'OperationIdempotencyReplayUnavailable',
                    'OperationPolicyDenied',
                  ]
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
                >;
              }>,
            ]
          >
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'get',
        'GET',
        '/ticketing/:id',
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            id: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<Schema.Codec<TicketingItem, TicketingItem, never, never>>,
        HttpApiEndpoint.Json<Schema.Codec<TicketingNotFound, TicketingNotFound, never, never>>,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'getTaskCollection',
        'GET',
        '/ticketing/task-collections/:collectionId',
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            collectionId: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collection: Schema.Struct<{
              readonly collectionId: Schema.String;
              readonly createdAt: Schema.String;
              readonly schemaId: Schema.String;
            }>;
            readonly schema: Schema.Struct<{
              readonly collectionId: Schema.String;
              readonly propertyDefinitions: Schema.$Array<
                Schema.Struct<{
                  readonly datatype: Schema.Literal<'title'>;
                  readonly mandatory: Schema.Boolean;
                  readonly name: Schema.String;
                  readonly propertyDefinitionId: Schema.String;
                }>
              >;
              readonly schemaId: Schema.String;
            }>;
            readonly task: Schema.Struct<{
              readonly collectionId: Schema.String;
              readonly createdAt: Schema.String;
              readonly createdByPrincipalId: Schema.String;
              readonly lastEditedAt: Schema.String;
              readonly lastEditedByPrincipalId: Schema.String;
              readonly revision: Schema.Finite;
              readonly taskId: Schema.String;
              readonly title: Schema.String;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Union<
            readonly [
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthRequired', 'OperationContextInvalid']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly [
                    'OperationDomainRejected',
                    'OperationIdempotencyConflict',
                    'OperationIdempotencyReplayUnavailable',
                    'OperationPolicyDenied',
                  ]
                >;
              }>,
              Schema.Struct<{
                readonly code: Schema.optional<Schema.String>;
                readonly httpStatus: Schema.Finite;
                readonly message: Schema.String;
                readonly ok: Schema.Literal<false>;
                readonly state: Schema.optional<
                  Schema.Codec<Schema.Json, Schema.Json, never, never>
                >;
                readonly errorTag: Schema.Literals<
                  readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
                >;
              }>,
            ]
          >
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'list',
        'GET',
        '/ticketing',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            limit: Schema.optional<Schema.FiniteFromString>;
          }>
        >,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly items: Schema.$Array<Schema.Codec<TicketingItem, TicketingItem, never, never>>;
          }>
        >,
        HttpApiEndpoint.Json<never>,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'readiness',
        'GET',
        '/ticketing/readiness',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<Schema.Codec<TicketingReadiness, TicketingReadiness, never, never>>,
        HttpApiEndpoint.Json<never>,
        never,
        never
      >,
    false
  >
>;
export declare const ticketingOperationContexts: {
  createTaskAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createTaskCollectionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  get: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  getTaskCollection: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  list: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  readiness: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
};
export declare const ticketingApiContract: {
  readonly apiPrefix: '/ticketing-api';
  readonly basePath: '/ticketing-api/ticketing';
  readonly ownerId: 'ticketing';
  readonly readinessPath: '/ticketing-api/ticketing/readiness';
};
