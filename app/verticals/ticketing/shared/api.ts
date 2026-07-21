import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  updateEmailPropertyValueActionHeadersSchema,
  updateEmailPropertyValueActionFailureSchemas,
  updateEmailPropertyValueActionOutcomeSchema,
  updateEmailPropertyValueActionPayloadSchema,
} from './actions/update-email-property-value';

import {
  createEmailPropertyDefinitionActionHeadersSchema,
  createEmailPropertyDefinitionActionFailureSchemas,
  createEmailPropertyDefinitionActionOutcomeSchema,
  createEmailPropertyDefinitionActionPayloadSchema,
} from './actions/create-email-property-definition';

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
import { emailQueryOperationSchema, queryTaskEmailValuesResponseSchema } from './email-query';
import {
  coreSdkOperationFailureSchemas,
  operationContextHeadersSchema,
} from './core-sdk-operation';
import { taskCollectionAggregateSchema } from './task-collection';
import { taskPropertyDeletionImpactSchema } from './task-property-deletion-impact';
import { taskPropertyEditCapabilitySchema } from './task-property-edit-capability';
import { taskPropertyWorkspaceSchema } from './task-property-workspace';

export type {
  CreateEmailPropertyDefinitionActionFailure,
  CreateEmailPropertyDefinitionActionOutcome,
  CreateEmailPropertyDefinitionActionPayload,
  CreateEmailPropertyDefinitionActionResponse,
} from './actions/create-email-property-definition';
export type {
  UpdateEmailPropertyValueActionFailure,
  UpdateEmailPropertyValueActionOutcome,
  UpdateEmailPropertyValueActionPayload,
  UpdateEmailPropertyValueActionResponse,
} from './actions/update-email-property-value';

export type {
  ConfigureTaskPropertyDefinitionActionFailure,
  ConfigureTaskPropertyDefinitionActionOutcome,
  ConfigureTaskPropertyDefinitionActionPayload,
  ConfigureTaskPropertyDefinitionActionResponse,
} from './actions/configure-task-property-definition';
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
  TransitionTaskRetentionActionFailure,
  TransitionTaskRetentionActionOutcome,
  TransitionTaskRetentionActionPayload,
  TransitionTaskRetentionActionResponse,
} from './actions/transition-task-retention';
export type { TaskCollectionAggregate } from './task-collection';
export type { TaskPropertyDeletionImpact } from './task-property-deletion-impact';
export type { TaskPropertyEditCapability } from './task-property-edit-capability';
export {
  checkboxPropertyDefinitionSchema,
  emailPropertyDefinitionSchema,
  taskPropertyDefinitionSchema,
} from './task-property-definition';
export type {
  CheckboxPropertyDefinition,
  EmailPropertyDefinition,
  TaskPropertyDefinition,
} from './task-property-definition';
export { emailMailtoHref, parseEmailValue } from './email-value';
export type { ParsedEmailValue } from './email-value';
export type { TaskPropertyWorkspace } from './task-property-workspace';
export type {
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse,
} from './checkbox-filter';
export type { QueryTaskEmailValuesPayload, QueryTaskEmailValuesResponse } from './email-query';

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
        'getTaskPropertyEditCapability',
        '/ticketing/task-collections/:collectionId/properties/edit-capability',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: { collectionId: Schema.String },
          success: taskPropertyEditCapabilitySchema,
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
      HttpApiEndpoint.get(
        'queryTaskEmailValues',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/email-query',
        {
          error: coreSdkOperationFailureSchemas,
          headers: operationContextHeadersSchema,
          params: {
            collectionId: Schema.String,
            propertyDefinitionId: Schema.String,
          },
          query: {
            operation: emailQueryOperationSchema,
            query: Schema.String,
          },
          success: queryTaskEmailValuesResponseSchema,
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
        'createEmailPropertyDefinitionAction',
        '/ticketing/actions/create-email-property-definition',
        {
          error: createEmailPropertyDefinitionActionFailureSchemas,
          headers: createEmailPropertyDefinitionActionHeadersSchema,
          payload: createEmailPropertyDefinitionActionPayloadSchema,
          success: createEmailPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateEmailPropertyValueAction',
        '/ticketing/actions/update-email-property-value',
        {
          error: updateEmailPropertyValueActionFailureSchemas,
          headers: updateEmailPropertyValueActionHeadersSchema,
          payload: updateEmailPropertyValueActionPayloadSchema,
          success: updateEmailPropertyValueActionOutcomeSchema,
        },
      ),
    ),
);

export const ticketingOperationContexts = {
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
  createEmailPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createEmailPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-email-property-definition',
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
  getTaskPropertyEditCapability: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:getTaskPropertyEditCapability',
    routePath: '/ticketing/task-collections/:collectionId/properties/edit-capability',
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
  queryTaskEmailValues: {
    method: 'GET',
    operationId: 'TicketingApi:ticketing:queryTaskEmailValues',
    routePath:
      '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/email-query',
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
  updateEmailPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateEmailPropertyValueAction',
    routePath: '/ticketing/actions/update-email-property-value',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const ticketingApiContract = {
  apiPrefix: '/ticketing-api',
  basePath: '/ticketing-api/ticketing',
  ownerId: 'ticketing',
  readinessPath: '/ticketing-api/ticketing/readiness',
} as const;
