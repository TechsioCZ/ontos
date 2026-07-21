import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import {
  configureSelectOptionOrderActionHeadersSchema,
  configureSelectOptionOrderActionFailureSchemas,
  configureSelectOptionOrderActionOutcomeSchema,
  configureSelectOptionOrderActionPayloadSchema,
} from './actions/configure-select-option-order';
import {
  createSelectOptionAndSelectActionHeadersSchema,
  createSelectOptionAndSelectActionFailureSchemas,
  createSelectOptionAndSelectActionOutcomeSchema,
  createSelectOptionAndSelectActionPayloadSchema,
} from './actions/create-select-option-and-select';
import {
  updateSelectPropertyValueActionHeadersSchema,
  updateSelectPropertyValueActionFailureSchemas,
  updateSelectPropertyValueActionOutcomeSchema,
  updateSelectPropertyValueActionPayloadSchema,
} from './actions/update-select-property-value';
import {
  updateSelectOptionActionHeadersSchema,
  updateSelectOptionActionFailureSchemas,
  updateSelectOptionActionOutcomeSchema,
  updateSelectOptionActionPayloadSchema,
} from './actions/update-select-option';
import {
  createSelectOptionActionHeadersSchema,
  createSelectOptionActionFailureSchemas,
  createSelectOptionActionOutcomeSchema,
  createSelectOptionActionPayloadSchema,
} from './actions/create-select-option';
import {
  createSelectPropertyDefinitionActionHeadersSchema,
  createSelectPropertyDefinitionActionFailureSchemas,
  createSelectPropertyDefinitionActionOutcomeSchema,
  createSelectPropertyDefinitionActionPayloadSchema,
} from './actions/create-select-property-definition';
import {
  configureNumberPropertyFormatActionHeadersSchema,
  configureNumberPropertyFormatActionFailureSchemas,
  configureNumberPropertyFormatActionOutcomeSchema,
  configureNumberPropertyFormatActionPayloadSchema,
} from './actions/configure-number-property-format';
import {
  createNumberPropertyDefinitionActionHeadersSchema,
  createNumberPropertyDefinitionActionFailureSchemas,
  createNumberPropertyDefinitionActionOutcomeSchema,
  createNumberPropertyDefinitionActionPayloadSchema,
} from './actions/create-number-property-definition';
import {
  updateNumberPropertyValueActionHeadersSchema,
  updateNumberPropertyValueActionFailureSchemas,
  updateNumberPropertyValueActionOutcomeSchema,
  updateNumberPropertyValueActionPayloadSchema,
} from './actions/update-number-property-value';
import {
  updateTextPropertyValueActionHeadersSchema,
  updateTextPropertyValueActionFailureSchemas,
  updateTextPropertyValueActionOutcomeSchema,
  updateTextPropertyValueActionPayloadSchema,
} from './actions/update-text-property-value';

import {
  createTextPropertyDefinitionActionHeadersSchema,
  createTextPropertyDefinitionActionFailureSchemas,
  createTextPropertyDefinitionActionOutcomeSchema,
  createTextPropertyDefinitionActionPayloadSchema,
} from './actions/create-text-property-definition';

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
import {
  coreSdkOperationFailureSchemas,
  operationContextHeadersSchema,
} from './core-sdk-operation';
import { taskCollectionAggregateSchema } from './task-collection';
import { taskPropertyDeletionImpactSchema } from './task-property-deletion-impact';
import { taskPropertyWorkspaceSchema } from './task-property-workspace';
import {
  queryTaskPropertyValuesPayloadSchema,
  queryTaskPropertyValuesResponseSchema,
} from './task-property-query';

export type {
  ConfigureNumberPropertyFormatActionFailure,
  ConfigureNumberPropertyFormatActionOutcome,
  ConfigureNumberPropertyFormatActionPayload,
  ConfigureNumberPropertyFormatActionResponse,
} from './actions/configure-number-property-format';
export type {
  ConfigureSelectOptionOrderActionFailure,
  ConfigureSelectOptionOrderActionOutcome,
  ConfigureSelectOptionOrderActionPayload,
  ConfigureSelectOptionOrderActionResponse,
} from './actions/configure-select-option-order';
export type {
  CreateNumberPropertyDefinitionActionFailure,
  CreateNumberPropertyDefinitionActionOutcome,
  CreateNumberPropertyDefinitionActionPayload,
  CreateNumberPropertyDefinitionActionResponse,
} from './actions/create-number-property-definition';
export type {
  UpdateNumberPropertyValueActionFailure,
  UpdateNumberPropertyValueActionOutcome,
  UpdateNumberPropertyValueActionPayload,
  UpdateNumberPropertyValueActionResponse,
} from './actions/update-number-property-value';
export type {
  CreateTextPropertyDefinitionActionFailure,
  CreateTextPropertyDefinitionActionOutcome,
  CreateTextPropertyDefinitionActionPayload,
  CreateTextPropertyDefinitionActionResponse,
} from './actions/create-text-property-definition';
export type {
  UpdateTextPropertyValueActionFailure,
  UpdateTextPropertyValueActionOutcome,
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse,
} from './actions/update-text-property-value';
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
  CreateSelectOptionAndSelectActionFailure,
  CreateSelectOptionAndSelectActionOutcome,
  CreateSelectOptionAndSelectActionPayload,
  CreateSelectOptionAndSelectActionResponse,
} from './actions/create-select-option-and-select';
export type {
  CreateSelectOptionActionFailure,
  CreateSelectOptionActionOutcome,
  CreateSelectOptionActionPayload,
  CreateSelectOptionActionResponse,
} from './actions/create-select-option';
export type {
  CreateSelectPropertyDefinitionActionFailure,
  CreateSelectPropertyDefinitionActionOutcome,
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectPropertyDefinitionActionResponse,
} from './actions/create-select-property-definition';
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
export type {
  UpdateSelectOptionActionFailure,
  UpdateSelectOptionActionOutcome,
  UpdateSelectOptionActionPayload,
  UpdateSelectOptionActionResponse,
} from './actions/update-select-option';
export type {
  UpdateSelectPropertyValueActionFailure,
  UpdateSelectPropertyValueActionOutcome,
  UpdateSelectPropertyValueActionPayload,
  UpdateSelectPropertyValueActionResponse,
} from './actions/update-select-property-value';
export type { TaskCollectionAggregate } from './task-collection';
export type { TaskPropertyDeletionImpact } from './task-property-deletion-impact';
export {
  checkboxPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  selectOptionOrderModeSchema,
  selectOptionSchema,
  selectPropertyDefinitionSchema,
  taskPropertyDefinitionSchema,
  textPropertyDefinitionSchema,
} from './task-property-definition';
export type {
  CheckboxPropertyDefinition,
  NumberPropertyDefinition,
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
  TaskPropertyDefinition,
  TextPropertyDefinition,
} from './task-property-definition';
export type { TaskPropertyWorkspace } from './task-property-workspace';
export type {
  QueryTaskPropertyValuesPayload,
  QueryTaskPropertyValuesResponse,
  TaskPropertyQuery,
} from './task-property-query';
export {
  coreReferenceSchema,
  nullableTextDocumentSchema,
  textDocumentSchema,
  textInlineNodeSchema,
  textMarkSchema,
  textPropertyValueSchema,
} from './text-property';
export type {
  CoreReference,
  TextDocument,
  TextInlineNode,
  TextMark,
  TextPropertyValue,
} from './text-property';
export type { TextQueryOperation } from './text-query';
export type { NumberQueryOperation } from './number-query';
export type {
  FilterTaskCheckboxValuesPayload,
  FilterTaskCheckboxValuesResponse,
} from './checkbox-filter';

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
          query: { locale: Schema.optional(Schema.String) },
          success: taskPropertyWorkspaceSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('queryTaskPropertyValues', '/ticketing/task-properties/query', {
        error: coreSdkOperationFailureSchemas,
        headers: operationContextHeadersSchema,
        payload: queryTaskPropertyValuesPayloadSchema,
        success: queryTaskPropertyValuesResponseSchema,
      }),
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
        'createTextPropertyDefinitionAction',
        '/ticketing/actions/create-text-property-definition',
        {
          error: createTextPropertyDefinitionActionFailureSchemas,
          headers: createTextPropertyDefinitionActionHeadersSchema,
          payload: createTextPropertyDefinitionActionPayloadSchema,
          success: createTextPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'updateTextPropertyValueAction',
        '/ticketing/actions/update-text-property-value',
        {
          error: updateTextPropertyValueActionFailureSchemas,
          headers: updateTextPropertyValueActionHeadersSchema,
          payload: updateTextPropertyValueActionPayloadSchema,
          success: updateTextPropertyValueActionOutcomeSchema,
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
    )
    .add(
      HttpApiEndpoint.post(
        'createSelectPropertyDefinitionAction',
        '/ticketing/actions/create-select-property-definition',
        {
          error: createSelectPropertyDefinitionActionFailureSchemas,
          headers: createSelectPropertyDefinitionActionHeadersSchema,
          payload: createSelectPropertyDefinitionActionPayloadSchema,
          success: createSelectPropertyDefinitionActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post('createSelectOptionAction', '/ticketing/actions/create-select-option', {
        error: createSelectOptionActionFailureSchemas,
        headers: createSelectOptionActionHeadersSchema,
        payload: createSelectOptionActionPayloadSchema,
        success: createSelectOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post('updateSelectOptionAction', '/ticketing/actions/update-select-option', {
        error: updateSelectOptionActionFailureSchemas,
        headers: updateSelectOptionActionHeadersSchema,
        payload: updateSelectOptionActionPayloadSchema,
        success: updateSelectOptionActionOutcomeSchema,
      }),
    )
    .add(
      HttpApiEndpoint.post(
        'updateSelectPropertyValueAction',
        '/ticketing/actions/update-select-property-value',
        {
          error: updateSelectPropertyValueActionFailureSchemas,
          headers: updateSelectPropertyValueActionHeadersSchema,
          payload: updateSelectPropertyValueActionPayloadSchema,
          success: updateSelectPropertyValueActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'createSelectOptionAndSelectAction',
        '/ticketing/actions/create-select-option-and-select',
        {
          error: createSelectOptionAndSelectActionFailureSchemas,
          headers: createSelectOptionAndSelectActionHeadersSchema,
          payload: createSelectOptionAndSelectActionPayloadSchema,
          success: createSelectOptionAndSelectActionOutcomeSchema,
        },
      ),
    )
    .add(
      HttpApiEndpoint.post(
        'configureSelectOptionOrderAction',
        '/ticketing/actions/configure-select-option-order',
        {
          error: configureSelectOptionOrderActionFailureSchemas,
          headers: configureSelectOptionOrderActionHeadersSchema,
          payload: configureSelectOptionOrderActionPayloadSchema,
          success: configureSelectOptionOrderActionOutcomeSchema,
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
  configureSelectOptionOrderAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:configureSelectOptionOrderAction',
    routePath: '/ticketing/actions/configure-select-option-order',
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
  createSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectOptionAction',
    routePath: '/ticketing/actions/create-select-option',
    source: 'generated-client',
  },
  createSelectOptionAndSelectAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectOptionAndSelectAction',
    routePath: '/ticketing/actions/create-select-option-and-select',
    source: 'generated-client',
  },
  createSelectPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createSelectPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-select-property-definition',
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
  createTextPropertyDefinitionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:createTextPropertyDefinitionAction',
    routePath: '/ticketing/actions/create-text-property-definition',
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
  queryTaskPropertyValues: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:queryTaskPropertyValues',
    routePath: '/ticketing/task-properties/query',
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
  updateSelectOptionAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateSelectOptionAction',
    routePath: '/ticketing/actions/update-select-option',
    source: 'generated-client',
  },
  updateSelectPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateSelectPropertyValueAction',
    routePath: '/ticketing/actions/update-select-property-value',
    source: 'generated-client',
  },
  updateTextPropertyValueAction: {
    method: 'POST',
    operationId: 'TicketingApi:ticketing:updateTextPropertyValueAction',
    routePath: '/ticketing/actions/update-text-property-value',
    source: 'generated-client',
  },
} satisfies Record<string, OperationContext>;

export const ticketingApiContract = {
  apiPrefix: '/ticketing-api',
  basePath: '/ticketing-api/ticketing',
  ownerId: 'ticketing',
  readinessPath: '/ticketing-api/ticketing/readiness',
} as const;
