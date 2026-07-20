import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  configureNumberPropertyFormatActionHeadersSchema,
  configureNumberPropertyFormatActionFailureSchemas,
  configureNumberPropertyFormatActionOutcomeSchema,
  configureNumberPropertyFormatActionPayloadSchema,
} from './actions/configure-number-property-format';

import {
  updateNumberPropertyValueActionHeadersSchema,
  updateNumberPropertyValueActionFailureSchemas,
  updateNumberPropertyValueActionOutcomeSchema,
  updateNumberPropertyValueActionPayloadSchema,
} from './actions/update-number-property-value';

import {
  createNumberPropertyDefinitionActionHeadersSchema,
  createNumberPropertyDefinitionActionFailureSchemas,
  createNumberPropertyDefinitionActionOutcomeSchema,
  createNumberPropertyDefinitionActionPayloadSchema,
} from './actions/create-number-property-definition';

import {
  transitionTaskRetentionActionHeadersSchema,
  transitionTaskRetentionActionFailureSchemas,
  transitionTaskRetentionActionOutcomeSchema,
  transitionTaskRetentionActionPayloadSchema,
} from './actions/transition-task-retention';

import {
  deleteTaskPropertyDefinitionActionHeadersSchema,
  deleteTaskPropertyDefinitionActionFailureSchemas,
  deleteTaskPropertyDefinitionActionOutcomeSchema,
  deleteTaskPropertyDefinitionActionPayloadSchema,
} from './actions/delete-task-property-definition';

import {
  duplicateTaskPropertyDefinitionActionHeadersSchema,
  duplicateTaskPropertyDefinitionActionFailureSchemas,
  duplicateTaskPropertyDefinitionActionOutcomeSchema,
  duplicateTaskPropertyDefinitionActionPayloadSchema,
} from './actions/duplicate-task-property-definition';

import {
  configureTaskPropertyDefinitionActionHeadersSchema,
  configureTaskPropertyDefinitionActionFailureSchemas,
  configureTaskPropertyDefinitionActionOutcomeSchema,
  configureTaskPropertyDefinitionActionPayloadSchema,
} from './actions/configure-task-property-definition';

import {
  createCheckboxPropertyDefinitionActionHeadersSchema,
  createCheckboxPropertyDefinitionActionFailureSchemas,
  createCheckboxPropertyDefinitionActionOutcomeSchema,
  createCheckboxPropertyDefinitionActionPayloadSchema,
} from './actions/create-checkbox-property-definition';

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
  updateCheckboxPropertyValueActionHeadersSchema,
  updateCheckboxPropertyValueActionFailureSchemas,
  updateCheckboxPropertyValueActionOutcomeSchema,
  updateCheckboxPropertyValueActionPayloadSchema,
} from './actions/update-checkbox-property-value';
import { filterTaskCheckboxValuesResponseSchema } from './checkbox-filter';
import { queryTaskNumberValuesResponseSchema } from './number-query';
import {
  coreSdkOperationFailureSchemas,
  operationContextHeadersSchema,
} from './core-sdk-operation';
import { taskCollectionAggregateSchema } from './task-collection';
import { taskPropertyDeletionImpactSchema } from './task-property-deletion-impact';
import { taskPropertyWorkspaceSchema } from './task-property-workspace';

export type {
  ConfigureNumberPropertyFormatActionFailure,
  ConfigureNumberPropertyFormatActionOutcome,
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse,
} from './actions/configure-number-property-format';
export type {
  ConfigureTaskPropertyDefinitionActionFailure,
  ConfigureTaskPropertyDefinitionActionOutcome,
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse,
} from './actions/configure-task-property-definition';
export type {
  CreateNumberPropertyDefinitionActionFailure,
  CreateNumberPropertyDefinitionActionOutcome,
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse,
} from './actions/create-number-property-definition';
export type {
  CreateCheckboxPropertyDefinitionActionFailure,
  CreateCheckboxPropertyDefinitionActionOutcome,
  CreateCheckboxPropertyDefinitionActionPayload,
  CreateCheckboxPropertyDefinitionActionResponse,
} from './actions/create-checkbox-property-definition';
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
export type {
  DeleteTaskPropertyDefinitionActionFailure,
  DeleteTaskPropertyDefinitionActionOutcome,
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse,
} from './actions/delete-task-property-definition';
export type {
  DuplicateTaskPropertyDefinitionActionFailure,
  DuplicateTaskPropertyDefinitionActionOutcome,
  DuplicateTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionResponse,
} from './actions/duplicate-task-property-definition';
export type {
  UpdateCheckboxPropertyValueActionFailure,
  UpdateCheckboxPropertyValueActionOutcome,
  UpdateCheckboxPropertyValueActionPayload,
  UpdateCheckboxPropertyValueActionResponse,
} from './actions/update-checkbox-property-value';
export type {
  UpdateNumberPropertyValueActionFailure,
  UpdateNumberPropertyValueActionOutcome,
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse,
} from './actions/update-number-property-value';
export type {
  TransitionTaskRetentionActionFailure,
  TransitionTaskRetentionActionOutcome,
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse,
} from './actions/transition-task-retention';
export type { TaskCollectionAggregate } from './task-collection';
export type { TaskPropertyDeletionImpact } from './task-property-deletion-impact';
export {
  checkboxPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  taskPropertyDefinitionSchema,
} from './task-property-definition';
export type {
  CheckboxPropertyDefinition,
  NumberPropertyDefinition,
  TaskPropertyDefinition,
} from './task-property-definition';
export type { TaskPropertyWorkspace } from './task-property-workspace';
export type {
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse,
} from './checkbox-filter';
export type { QueryTaskNumberValuesPayload, QueryTaskNumberValuesResponse } from './number-query';

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
      HttpApiEndpoint.get(
        'getTaskPropertyWorkspace',
        '/ticketing/task-collections/:collectionId/properties',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          success: taskPropertyWorkspaceSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'filterTaskCheckboxValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/checkbox-filter',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: { value: Schema.Literals(['true', 'false']) },
          success: filterTaskCheckboxValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'queryTaskNumberValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/number-query',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: {
            direction: Schema.optional(Schema.Literals(['ascending', 'descending'])),
            kind: Schema.Literals(['filter', 'group', 'search', 'sort']),
            operator: Schema.optional(
              Schema.Literals([
                'equal',
                'not_equal',
                'greater_than',
                'less_than',
                'greater_than_or_equal',
                'less_than_or_equal',
                'is_empty',
                'is_not_empty',
              ]),
            ),
            search: Schema.optional(Schema.String),
            value: Schema.optional(Schema.String),
          },
          success: queryTaskNumberValuesResponseSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.get(
        'getTaskPropertyDeletionImpact',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/deletion-impact',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          success: taskPropertyDeletionImpactSchema,
        },
      ),
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
    )
    .add(
      HttpApiEndpoint.post(
        'createCheckboxPropertyDefinitionAction',
        '/ticketing/actions/create-checkbox-property-definition',
        {
          error: createCheckboxPropertyDefinitionActionFailureSchemas,
          headers: createCheckboxPropertyDefinitionActionHeadersSchema,
          payload: createCheckboxPropertyDefinitionActionPayloadSchema,
          success: createCheckboxPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateCheckboxPropertyValueAction',
        '/ticketing/actions/update-checkbox-property-value',
        {
          error: updateCheckboxPropertyValueActionFailureSchemas,
          headers: updateCheckboxPropertyValueActionHeadersSchema,
          payload: updateCheckboxPropertyValueActionPayloadSchema,
          success: updateCheckboxPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureTaskPropertyDefinitionAction',
        '/ticketing/actions/configure-task-property-definition',
        {
          error: configureTaskPropertyDefinitionActionFailureSchemas,
          headers: configureTaskPropertyDefinitionActionHeadersSchema,
          payload: configureTaskPropertyDefinitionActionPayloadSchema,
          success: configureTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'duplicateTaskPropertyDefinitionAction',
        '/ticketing/actions/duplicate-task-property-definition',
        {
          error: duplicateTaskPropertyDefinitionActionFailureSchemas,
          headers: duplicateTaskPropertyDefinitionActionHeadersSchema,
          payload: duplicateTaskPropertyDefinitionActionPayloadSchema,
          success: duplicateTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'deleteTaskPropertyDefinitionAction',
        '/ticketing/actions/delete-task-property-definition',
        {
          error: deleteTaskPropertyDefinitionActionFailureSchemas,
          headers: deleteTaskPropertyDefinitionActionHeadersSchema,
          payload: deleteTaskPropertyDefinitionActionPayloadSchema,
          success: deleteTaskPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'transitionTaskRetentionAction',
        '/ticketing/actions/transition-task-retention',
        {
          error: transitionTaskRetentionActionFailureSchemas,
          headers: transitionTaskRetentionActionHeadersSchema,
          payload: transitionTaskRetentionActionPayloadSchema,
          success: transitionTaskRetentionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createNumberPropertyDefinitionAction',
        '/ticketing/actions/create-number-property-definition',
        {
          error: createNumberPropertyDefinitionActionFailureSchemas,
          headers: createNumberPropertyDefinitionActionHeadersSchema,
          payload: createNumberPropertyDefinitionActionPayloadSchema,
          success: createNumberPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateNumberPropertyValueAction',
        '/ticketing/actions/update-number-property-value',
        {
          error: updateNumberPropertyValueActionFailureSchemas,
          headers: updateNumberPropertyValueActionHeadersSchema,
          payload: updateNumberPropertyValueActionPayloadSchema,
          success: updateNumberPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureNumberPropertyFormatAction',
        '/ticketing/actions/configure-number-property-format',
        {
          error: configureNumberPropertyFormatActionFailureSchemas,
          headers: configureNumberPropertyFormatActionHeadersSchema,
          payload: configureNumberPropertyFormatActionPayloadSchema,
          success: configureNumberPropertyFormatActionOutcomeSchema,
        },
      ),
    ),
);

export const ticketingOperationContexts = {
  configureNumberPropertyFormatAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureNumberPropertyFormatAction',
    routePath: '/ticketing/actions/configure-number-property-format',
    source: 'generated-client',
  },
  configureTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/configure-task-property-definition',
    source: 'generated-client',
  },
  createCheckboxPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createCheckboxPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-checkbox-property-definition',
    source: 'generated-client',
  },
  createNumberPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createNumberPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-number-property-definition',
    source: 'generated-client',
  },
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
  deleteTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:deleteTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/delete-task-property-definition',
    source: 'generated-client',
  },
  duplicateTaskPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:duplicateTaskPropertyDefinitionAction',
    routePath: '/ticketing/actions/duplicate-task-property-definition',
    source: 'generated-client',
  },
  filterTaskCheckboxValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:filterTaskCheckboxValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/checkbox-filter',
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
  getTaskPropertyDeletionImpact: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyDeletionImpact',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/deletion-impact',
    source: 'generated-client',
  },
  getTaskPropertyWorkspace: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyWorkspace',
    routePath: '/ticketing/task-collections/:collectionId/properties',
    source: 'generated-client',
  },
  list: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:list',
    routePath: '/ticketing',
    source: 'generated-client',
  },
  queryTaskNumberValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:queryTaskNumberValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/number-query',
    source: 'generated-client',
  },
  readiness: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:readiness',
    routePath: '/ticketing/readiness',
    source: 'generated-client',
  },
  transitionTaskRetentionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:transitionTaskRetentionAction',
    routePath: '/ticketing/actions/transition-task-retention',
    source: 'generated-client',
  },
  updateCheckboxPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateCheckboxPropertyValueAction',
    routePath: '/ticketing/actions/update-checkbox-property-value',
    source: 'generated-client',
  },
  updateNumberPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateNumberPropertyValueAction',
    routePath: '/ticketing/actions/update-number-property-value',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const ticketingApiContract = {
  apiPrefix: '/ticketing-api',
  basePath: '/ticketing-api/ticketing',
  ownerId: 'ticketing',
  readinessPath: '/ticketing-api/ticketing/readiness',
} as const;
