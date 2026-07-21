import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
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
        'configureTaskPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/configure-task-property-definition',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly hidden: Schema.Boolean;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
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
              readonly definition: Schema.Union<
                readonly [
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'checkbox'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'email'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                ]
              >;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'createCheckboxPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-checkbox-property-definition',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
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
              readonly definition: Schema.Struct<{
                readonly datatype: Schema.Literal<'checkbox'>;
                readonly hidden: Schema.Boolean;
                readonly mandatory: Schema.Boolean;
                readonly name: Schema.String;
                readonly propertyDefinitionId: Schema.String;
                readonly revision: Schema.Finite;
              }>;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'createEmailPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-email-property-definition',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly mandatory: Schema.Boolean;
            readonly name: Schema.String;
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
              readonly definition: Schema.Struct<{
                readonly datatype: Schema.Literal<'email'>;
                readonly hidden: Schema.Boolean;
                readonly mandatory: Schema.Boolean;
                readonly name: Schema.String;
                readonly propertyDefinitionId: Schema.String;
                readonly revision: Schema.Finite;
              }>;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
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
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
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
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'deleteTaskPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/delete-task-property-definition',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly confirmed: Schema.Literal<true>;
            readonly expectedImpactCount: Schema.Finite;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
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
              readonly deletedPropertyDefinitionId: Schema.String;
              readonly impactCount: Schema.Finite;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'duplicateTaskPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/duplicate-task-property-definition',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly copyValues: Schema.Boolean;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
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
              readonly definition: Schema.Union<
                readonly [
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'checkbox'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'email'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                ]
              >;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'filterTaskCheckboxValues',
        'GET',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/checkbox-filter',
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            collectionId: Schema.String;
            propertyDefinitionId: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            value: Schema.Literals<readonly ['true', 'false']>;
          }>
        >,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly taskIds: Schema.$Array<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
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
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'getTaskPropertyDeletionImpact',
        'GET',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/deletion-impact',
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            collectionId: Schema.String;
            propertyDefinitionId: Schema.String;
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
            readonly impactCount: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
            readonly revision: Schema.Finite;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'getTaskPropertyWorkspace',
        'GET',
        '/ticketing/task-collections/:collectionId/properties',
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
            readonly collectionId: Schema.String;
            readonly propertyDefinitions: Schema.$Array<
              Schema.Union<
                readonly [
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'checkbox'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'email'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                ]
              >
            >;
            readonly tasks: Schema.$Array<
              Schema.Struct<{
                readonly checkboxValues: Schema.$Array<
                  Schema.Struct<{
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                    readonly value: Schema.Boolean;
                  }>
                >;
                readonly emailValues: Schema.$Array<
                  Schema.Struct<{
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                    readonly value: Schema.String;
                  }>
                >;
                readonly taskId: Schema.String;
                readonly taskRevision: Schema.Finite;
                readonly title: Schema.String;
              }>
            >;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
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
        'queryTaskEmailValues',
        'GET',
        '/ticketing/task-collections/:collectionId/properties/:propertyDefinitionId/email-query',
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            collectionId: Schema.String;
            propertyDefinitionId: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            operation: Schema.Literals<
              readonly [
                'search',
                'is',
                'is_not',
                'contains',
                'does_not_contain',
                'is_empty',
                'is_not_empty',
                'sort_ascending',
                'sort_descending',
                'group',
              ]
            >;
            query: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly groups: Schema.$Array<
              Schema.Struct<{
                readonly key: Schema.NullOr<Schema.String>;
                readonly label: Schema.NullOr<Schema.String>;
                readonly taskIds: Schema.$Array<Schema.String>;
              }>
            >;
            readonly taskIds: Schema.$Array<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
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
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'transitionTaskRetentionAction',
        'POST',
        '/ticketing/actions/transition-task-retention',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly taskId: Schema.String;
            readonly transition: Schema.Literals<
              readonly ['archive', 'restore', 'softDelete', 'hardDelete']
            >;
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
            readonly response: Schema.Union<
              readonly [
                Schema.Struct<{
                  readonly retentionState: Schema.Literals<
                    readonly ['active', 'archived', 'softDeleted']
                  >;
                  readonly taskId: Schema.String;
                  readonly taskRevision: Schema.Finite;
                }>,
                Schema.Struct<{
                  readonly hardDeletedTaskId: Schema.String;
                  readonly retentionState: Schema.Literal<'hardDeleted'>;
                }>,
              ]
            >;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'updateCheckboxPropertyValueAction',
        'POST',
        '/ticketing/actions/update-checkbox-property-value',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
            readonly value: Schema.Boolean;
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
              readonly taskRevision: Schema.Finite;
              readonly value: Schema.Struct<{
                readonly propertyDefinitionId: Schema.String;
                readonly revision: Schema.Finite;
                readonly value: Schema.Boolean;
              }>;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >
    | HttpApiEndpoint.HttpApiEndpoint<
        'updateEmailPropertyValueAction',
        'POST',
        '/ticketing/actions/update-email-property-value',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
            readonly value: Schema.String;
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
              readonly taskRevision: Schema.Finite;
              readonly value: Schema.NullOr<
                Schema.Struct<{
                  readonly propertyDefinitionId: Schema.String;
                  readonly revision: Schema.Finite;
                  readonly value: Schema.String;
                }>
              >;
            }>;
          }>
        >,
        HttpApiEndpoint.Json<
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<readonly ['OperationIdempotencyKeyRequired']>;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthRequired', 'OperationContextInvalid']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationAuthorizationDenied', 'OperationModuleStateDenied']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly ['OperationExecutionFailed', 'OperationPersistenceFailed']
              >;
            }>
          | Schema.Struct<{
              readonly code: Schema.optional<Schema.String>;
              readonly httpStatus: Schema.Finite;
              readonly message: Schema.String;
              readonly ok: Schema.Literal<false>;
              readonly state: Schema.optional<Schema.Codec<Schema.Json, Schema.Json, never, never>>;
              readonly errorTag: Schema.Literals<
                readonly [
                  'OperationDomainRejected',
                  'OperationIdempotencyConflict',
                  'OperationIdempotencyReplayUnavailable',
                  'OperationPolicyDenied',
                ]
              >;
            }>
        >,
        never,
        never
      >,
    false
  >
>;
export declare const ticketingOperationContexts: {
  configureTaskPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createCheckboxPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createEmailPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
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
  deleteTaskPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  duplicateTaskPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  filterTaskCheckboxValues: {
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
  getTaskPropertyDeletionImpact: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  getTaskPropertyWorkspace: {
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
  queryTaskEmailValues: {
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
  transitionTaskRetentionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateCheckboxPropertyValueAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateEmailPropertyValueAction: {
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
