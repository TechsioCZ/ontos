// oxlint-disable typescript/ban-types, typescript/no-empty-object-type -- TypeScript-generated API declaration
import type {
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
  CreateUrlPropertyDefinitionActionFailure,
  CreateUrlPropertyDefinitionActionOutcome,
  CreateUrlPropertyDefinitionActionPayload,
  CreateUrlPropertyDefinitionActionResponse,
} from './actions/create-url-property-definition';
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
  UpdateUrlPropertyValueActionFailure,
  UpdateUrlPropertyValueActionOutcome,
  UpdateUrlPropertyValueActionPayload,
  UpdateUrlPropertyValueActionResponse,
} from './actions/update-url-property-value';
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
export type { TaskPropertyEditCapability } from './task-property-edit-capability';
export {
  checkboxPropertyDefinitionSchema,
  emailPropertyDefinitionSchema,
  numberPropertyDefinitionSchema,
  selectOptionOrderModeSchema,
  selectOptionSchema,
  selectPropertyDefinitionSchema,
  taskPropertyDefinitionSchema,
  textPropertyDefinitionSchema,
  urlPropertyDefinitionSchema,
} from './task-property-definition';
export type {
  CheckboxPropertyDefinition,
  EmailPropertyDefinition,
  NumberPropertyDefinition,
  SelectOption,
  SelectOptionOrderMode,
  SelectPropertyDefinition,
  TaskPropertyDefinition,
  TextPropertyDefinition,
  UrlPropertyDefinition,
} from './task-property-definition';
export { emailMailtoHref, parseEmailValue } from './email-value';
export type { ParsedEmailValue } from './email-value';
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
export type { QueryTaskUrlValuesPayload, QueryTaskUrlValuesResponse } from './url-query';
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
        'configureNumberPropertyFormatAction',
        'POST',
        '/ticketing/actions/configure-number-property-format',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly format: Schema.Literals<
              readonly ['number', 'number_with_separators', 'percent']
            >;
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
              readonly definition: Schema.Struct<{
                readonly datatype: Schema.Literal<'number'>;
                readonly format: Schema.Literals<
                  readonly ['number', 'number_with_separators', 'percent']
                >;
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
        'configureSelectOptionOrderAction',
        'POST',
        '/ticketing/actions/configure-select-option-order',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly manualOptionIds: Schema.optional<Schema.$Array<Schema.String>>;
            readonly optionOrderMode: Schema.Literals<
              readonly ['manual', 'alphabetical', 'reverse_alphabetical']
            >;
            readonly propertyDefinitionId: Schema.String;
            readonly viewerLocale: Schema.String;
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
                readonly datatype: Schema.Literal<'select'>;
                readonly hidden: Schema.Boolean;
                readonly mandatory: Schema.Boolean;
                readonly name: Schema.String;
                readonly optionOrderMode: Schema.Literals<
                  readonly ['manual', 'alphabetical', 'reverse_alphabetical']
                >;
                readonly options: Schema.$Array<
                  Schema.Struct<{
                    readonly color: Schema.String;
                    readonly manualPosition: Schema.Finite;
                    readonly name: Schema.String;
                    readonly optionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>
                >;
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
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'number'>;
                    readonly format: Schema.Literals<
                      readonly ['number', 'number_with_separators', 'percent']
                    >;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'select'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly optionOrderMode: Schema.Literals<
                      readonly ['manual', 'alphabetical', 'reverse_alphabetical']
                    >;
                    readonly options: Schema.$Array<
                      Schema.Struct<{
                        readonly color: Schema.String;
                        readonly manualPosition: Schema.Finite;
                        readonly name: Schema.String;
                        readonly optionId: Schema.String;
                        readonly revision: Schema.Finite;
                      }>
                    >;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'text'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'url'>;
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
        'createNumberPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-number-property-definition',
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
                readonly datatype: Schema.Literal<'number'>;
                readonly format: Schema.Literals<
                  readonly ['number', 'number_with_separators', 'percent']
                >;
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
        'createSelectOptionAction',
        'POST',
        '/ticketing/actions/create-select-option',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly color: Schema.String;
            readonly expectedDefinitionRevision: Schema.Finite;
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
              readonly definitionRevision: Schema.Finite;
              readonly option: Schema.Struct<{
                readonly color: Schema.String;
                readonly manualPosition: Schema.Finite;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
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
        'createSelectOptionAndSelectAction',
        'POST',
        '/ticketing/actions/create-select-option-and-select',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly color: Schema.String;
            readonly expectedDefinitionRevision: Schema.Finite;
            readonly expectedValueRevision: Schema.Finite;
            readonly name: Schema.String;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
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
              readonly definitionRevision: Schema.Finite;
              readonly option: Schema.Struct<{
                readonly color: Schema.String;
                readonly manualPosition: Schema.Finite;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
                readonly revision: Schema.Finite;
              }>;
              readonly taskRevision: Schema.Finite;
              readonly value: Schema.Struct<{
                readonly optionId: Schema.optional<Schema.String>;
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
        'createSelectPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-select-property-definition',
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
                readonly datatype: Schema.Literal<'select'>;
                readonly hidden: Schema.Boolean;
                readonly mandatory: Schema.Boolean;
                readonly name: Schema.String;
                readonly optionOrderMode: Schema.Literals<
                  readonly ['manual', 'alphabetical', 'reverse_alphabetical']
                >;
                readonly options: Schema.$Array<
                  Schema.Struct<{
                    readonly color: Schema.String;
                    readonly manualPosition: Schema.Finite;
                    readonly name: Schema.String;
                    readonly optionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>
                >;
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
        'createTextPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-text-property-definition',
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
                readonly datatype: Schema.Literal<'text'>;
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
        'createUrlPropertyDefinitionAction',
        'POST',
        '/ticketing/actions/create-url-property-definition',
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
                readonly datatype: Schema.Literal<'url'>;
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
            readonly copyValues: Schema.optional<Schema.Boolean>;
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
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'number'>;
                    readonly format: Schema.Literals<
                      readonly ['number', 'number_with_separators', 'percent']
                    >;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'select'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly optionOrderMode: Schema.Literals<
                      readonly ['manual', 'alphabetical', 'reverse_alphabetical']
                    >;
                    readonly options: Schema.$Array<
                      Schema.Struct<{
                        readonly color: Schema.String;
                        readonly manualPosition: Schema.Finite;
                        readonly name: Schema.String;
                        readonly optionId: Schema.String;
                        readonly revision: Schema.Finite;
                      }>
                    >;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'text'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'url'>;
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
        'getTaskPropertyEditCapability',
        'GET',
        '/ticketing/task-collections/:collectionId/properties/edit-capability',
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
            readonly canEdit: Schema.Literal<true>;
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
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            locale: Schema.optional<Schema.String>;
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
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'number'>;
                    readonly format: Schema.Literals<
                      readonly ['number', 'number_with_separators', 'percent']
                    >;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'select'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly optionOrderMode: Schema.Literals<
                      readonly ['manual', 'alphabetical', 'reverse_alphabetical']
                    >;
                    readonly options: Schema.$Array<
                      Schema.Struct<{
                        readonly color: Schema.String;
                        readonly manualPosition: Schema.Finite;
                        readonly name: Schema.String;
                        readonly optionId: Schema.String;
                        readonly revision: Schema.Finite;
                      }>
                    >;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'text'>;
                    readonly hidden: Schema.Boolean;
                    readonly mandatory: Schema.Boolean;
                    readonly name: Schema.String;
                    readonly propertyDefinitionId: Schema.String;
                    readonly revision: Schema.Finite;
                  }>,
                  Schema.Struct<{
                    readonly datatype: Schema.Literal<'url'>;
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
                    readonly value: Schema.NullOr<Schema.String>;
                  }>
                >;
                readonly numberValues: Schema.optional<
                  Schema.$Array<
                    Schema.Struct<{
                      readonly propertyDefinitionId: Schema.String;
                      readonly revision: Schema.Finite;
                      readonly value: Schema.Union<readonly [Schema.String, Schema.Null]>;
                    }>
                  >
                >;
                readonly selectValues: Schema.optional<
                  Schema.$Array<
                    Schema.Struct<{
                      readonly optionId: Schema.optional<Schema.String>;
                      readonly propertyDefinitionId: Schema.String;
                      readonly revision: Schema.Finite;
                    }>
                  >
                >;
                readonly taskId: Schema.String;
                readonly taskRevision: Schema.Finite;
                readonly textValues: Schema.optional<
                  Schema.$Array<
                    Schema.Struct<{
                      readonly document: Schema.Union<
                        readonly [
                          Schema.Null,
                          Schema.Struct<{
                            readonly content: Schema.$Array<
                              Schema.Union<
                                readonly [
                                  Schema.Struct<{
                                    readonly marks: Schema.$Array<
                                      Schema.Union<
                                        readonly [
                                          Schema.Struct<{
                                            readonly type: Schema.Literals<
                                              readonly [
                                                'bold',
                                                'italic',
                                                'underline',
                                                'strikethrough',
                                                'code',
                                              ]
                                            >;
                                          }>,
                                          Schema.Struct<{
                                            readonly color: Schema.String;
                                            readonly type: Schema.Literal<'foregroundColor'>;
                                          }>,
                                          Schema.Struct<{
                                            readonly color: Schema.String;
                                            readonly type: Schema.Literal<'backgroundColor'>;
                                          }>,
                                          Schema.Struct<{
                                            readonly href: Schema.String;
                                            readonly type: Schema.Literal<'link'>;
                                          }>,
                                        ]
                                      >
                                    >;
                                    readonly text: Schema.String;
                                    readonly type: Schema.Literal<'text'>;
                                  }>,
                                  Schema.Struct<{
                                    readonly type: Schema.Literal<'lineBreak'>;
                                  }>,
                                  Schema.Struct<{
                                    readonly expression: Schema.String;
                                    readonly type: Schema.Literal<'equation'>;
                                  }>,
                                  Schema.Struct<{
                                    readonly reference: Schema.Struct<{
                                      readonly entityId: Schema.String;
                                      readonly entityType: Schema.String;
                                      readonly kind: Schema.Literals<
                                        readonly ['mention', 'relation']
                                      >;
                                      readonly lastResolvedLabel: Schema.String;
                                      readonly ownerModuleKey: Schema.String;
                                      readonly targetTenantId: Schema.String;
                                      readonly token: Schema.String;
                                    }>;
                                    readonly type: Schema.Literal<'reference'>;
                                  }>,
                                ]
                              >
                            >;
                            readonly type: Schema.Literal<'textDocument'>;
                          }>,
                        ]
                      >;
                      readonly propertyDefinitionId: Schema.String;
                      readonly readableText: Schema.Union<readonly [Schema.Null, Schema.String]>;
                      readonly revision: Schema.Finite;
                    }>
                  >
                >;
                readonly title: Schema.String;
                readonly urlValues: Schema.optional<
                  Schema.$Array<
                    Schema.Struct<{
                      readonly propertyDefinitionId: Schema.String;
                      readonly revision: Schema.Finite;
                      readonly value: Schema.NullOr<Schema.String>;
                    }>
                  >
                >;
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
        'queryTaskPropertyValues',
        'POST',
        '/ticketing/task-properties/query',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly propertyDefinitionId: Schema.String;
            readonly query: Schema.Union<
              readonly [
                Schema.Struct<{
                  readonly datatype: Schema.Literal<'number'>;
                  readonly operation: Schema.Union<
                    readonly [
                      Schema.Struct<{
                        readonly query: Schema.String;
                        readonly type: Schema.Literal<'search'>;
                      }>,
                      Schema.Struct<{
                        readonly operator: Schema.Literals<
                          readonly [
                            'equal',
                            'notEqual',
                            'greaterThan',
                            'lessThan',
                            'greaterThanOrEqual',
                            'lessThanOrEqual',
                          ]
                        >;
                        readonly type: Schema.Literal<'filter'>;
                        readonly value: Schema.String;
                      }>,
                      Schema.Struct<{
                        readonly operator: Schema.Literals<readonly ['isEmpty', 'isNotEmpty']>;
                        readonly type: Schema.Literal<'filter'>;
                      }>,
                      Schema.Struct<{
                        readonly direction: Schema.Literals<readonly ['ascending', 'descending']>;
                        readonly type: Schema.Literal<'sort'>;
                      }>,
                      Schema.Struct<{
                        readonly type: Schema.Literal<'group'>;
                      }>,
                    ]
                  >;
                }>,
                Schema.Struct<{
                  readonly datatype: Schema.Literal<'text'>;
                  readonly operation: Schema.Union<
                    readonly [
                      Schema.Struct<{
                        readonly query: Schema.String;
                        readonly type: Schema.Literal<'search'>;
                      }>,
                      Schema.Struct<{
                        readonly operator: Schema.Literals<
                          readonly [
                            'contains',
                            'doesNotContain',
                            'equals',
                            'doesNotEqual',
                            'startsWith',
                            'endsWith',
                          ]
                        >;
                        readonly type: Schema.Literal<'filter'>;
                        readonly value: Schema.String;
                      }>,
                      Schema.Struct<{
                        readonly operator: Schema.Literals<readonly ['isEmpty', 'isNotEmpty']>;
                        readonly type: Schema.Literal<'filter'>;
                      }>,
                      Schema.Struct<{
                        readonly direction: Schema.Literals<readonly ['ascending', 'descending']>;
                        readonly type: Schema.Literal<'sort'>;
                      }>,
                      Schema.Struct<{
                        readonly type: Schema.Literal<'group'>;
                      }>,
                    ]
                  >;
                }>,
              ]
            >;
          }>
        >,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly groups: Schema.optional<
              Schema.$Array<
                Schema.Struct<{
                  readonly heading: Schema.Union<readonly [Schema.Null, Schema.String]>;
                  readonly taskIds: Schema.$Array<Schema.String>;
                }>
              >
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
        'queryTaskUrlValues',
        'POST',
        '/ticketing/queries/task-url-values',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly operation: Schema.Union<
              readonly [
                Schema.Struct<{
                  readonly kind: Schema.Literal<'search'>;
                  readonly query: Schema.String;
                }>,
                Schema.Struct<{
                  readonly kind: Schema.Literal<'filter'>;
                  readonly operator: Schema.Literals<readonly ['contains', 'does_not_contain']>;
                  readonly query: Schema.String;
                }>,
                Schema.Struct<{
                  readonly kind: Schema.Literal<'filter'>;
                  readonly operator: Schema.Literals<readonly ['is_empty', 'is_not_empty']>;
                }>,
                Schema.Struct<{
                  readonly direction: Schema.Literals<readonly ['ascending', 'descending']>;
                  readonly kind: Schema.Literal<'sort'>;
                }>,
                Schema.Struct<{
                  readonly kind: Schema.Literal<'group'>;
                }>,
              ]
            >;
            readonly propertyDefinitionId: Schema.String;
          }>
        >,
        HttpApiEndpoint.StringTree<
          Schema.Struct<{
            readonly 'x-ontos-operation-context': Schema.optional<Schema.String>;
          }>
        >,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly groups: Schema.$Array<
              Schema.Struct<{
                readonly heading: Schema.NullOr<Schema.String>;
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
              readonly value: Schema.Struct<{
                readonly propertyDefinitionId: Schema.String;
                readonly revision: Schema.Finite;
                readonly value: Schema.NullOr<Schema.String>;
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
        'updateNumberPropertyValueAction',
        'POST',
        '/ticketing/actions/update-number-property-value',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
            readonly value: Schema.Union<readonly [Schema.String, Schema.Null]>;
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
                readonly value: Schema.Union<readonly [Schema.String, Schema.Null]>;
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
        'updateSelectOptionAction',
        'POST',
        '/ticketing/actions/update-select-option',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly color: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly name: Schema.String;
            readonly optionId: Schema.String;
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
              readonly definitionRevision: Schema.Finite;
              readonly option: Schema.Struct<{
                readonly color: Schema.String;
                readonly manualPosition: Schema.Finite;
                readonly name: Schema.String;
                readonly optionId: Schema.String;
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
        'updateSelectPropertyValueAction',
        'POST',
        '/ticketing/actions/update-select-property-value',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly expectedRevision: Schema.Finite;
            readonly optionId: Schema.optional<Schema.String>;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
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
                readonly optionId: Schema.optional<Schema.String>;
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
        'updateTextPropertyValueAction',
        'POST',
        '/ticketing/actions/update-text-property-value',
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.StringTree<never>,
        HttpApiEndpoint.Json<
          Schema.Struct<{
            readonly collectionId: Schema.String;
            readonly document: Schema.Union<
              readonly [
                Schema.Null,
                Schema.Struct<{
                  readonly content: Schema.$Array<
                    Schema.Union<
                      readonly [
                        Schema.Struct<{
                          readonly marks: Schema.$Array<
                            Schema.Union<
                              readonly [
                                Schema.Struct<{
                                  readonly type: Schema.Literals<
                                    readonly [
                                      'bold',
                                      'italic',
                                      'underline',
                                      'strikethrough',
                                      'code',
                                    ]
                                  >;
                                }>,
                                Schema.Struct<{
                                  readonly color: Schema.String;
                                  readonly type: Schema.Literal<'foregroundColor'>;
                                }>,
                                Schema.Struct<{
                                  readonly color: Schema.String;
                                  readonly type: Schema.Literal<'backgroundColor'>;
                                }>,
                                Schema.Struct<{
                                  readonly href: Schema.String;
                                  readonly type: Schema.Literal<'link'>;
                                }>,
                              ]
                            >
                          >;
                          readonly text: Schema.String;
                          readonly type: Schema.Literal<'text'>;
                        }>,
                        Schema.Struct<{
                          readonly type: Schema.Literal<'lineBreak'>;
                        }>,
                        Schema.Struct<{
                          readonly expression: Schema.String;
                          readonly type: Schema.Literal<'equation'>;
                        }>,
                        Schema.Struct<{
                          readonly reference: Schema.Struct<{
                            readonly entityId: Schema.String;
                            readonly entityType: Schema.String;
                            readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
                            readonly lastResolvedLabel: Schema.String;
                            readonly ownerModuleKey: Schema.String;
                            readonly targetTenantId: Schema.String;
                            readonly token: Schema.String;
                          }>;
                          readonly type: Schema.Literal<'reference'>;
                        }>,
                      ]
                    >
                  >;
                  readonly type: Schema.Literal<'textDocument'>;
                }>,
              ]
            >;
            readonly expectedRevision: Schema.Finite;
            readonly propertyDefinitionId: Schema.String;
            readonly taskId: Schema.String;
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
                readonly document: Schema.Union<
                  readonly [
                    Schema.Null,
                    Schema.Struct<{
                      readonly content: Schema.$Array<
                        Schema.Union<
                          readonly [
                            Schema.Struct<{
                              readonly marks: Schema.$Array<
                                Schema.Union<
                                  readonly [
                                    Schema.Struct<{
                                      readonly type: Schema.Literals<
                                        readonly [
                                          'bold',
                                          'italic',
                                          'underline',
                                          'strikethrough',
                                          'code',
                                        ]
                                      >;
                                    }>,
                                    Schema.Struct<{
                                      readonly color: Schema.String;
                                      readonly type: Schema.Literal<'foregroundColor'>;
                                    }>,
                                    Schema.Struct<{
                                      readonly color: Schema.String;
                                      readonly type: Schema.Literal<'backgroundColor'>;
                                    }>,
                                    Schema.Struct<{
                                      readonly href: Schema.String;
                                      readonly type: Schema.Literal<'link'>;
                                    }>,
                                  ]
                                >
                              >;
                              readonly text: Schema.String;
                              readonly type: Schema.Literal<'text'>;
                            }>,
                            Schema.Struct<{
                              readonly type: Schema.Literal<'lineBreak'>;
                            }>,
                            Schema.Struct<{
                              readonly expression: Schema.String;
                              readonly type: Schema.Literal<'equation'>;
                            }>,
                            Schema.Struct<{
                              readonly reference: Schema.Struct<{
                                readonly entityId: Schema.String;
                                readonly entityType: Schema.String;
                                readonly kind: Schema.Literals<readonly ['mention', 'relation']>;
                                readonly lastResolvedLabel: Schema.String;
                                readonly ownerModuleKey: Schema.String;
                                readonly targetTenantId: Schema.String;
                                readonly token: Schema.String;
                              }>;
                              readonly type: Schema.Literal<'reference'>;
                            }>,
                          ]
                        >
                      >;
                      readonly type: Schema.Literal<'textDocument'>;
                    }>,
                  ]
                >;
                readonly propertyDefinitionId: Schema.String;
                readonly readableText: Schema.Union<readonly [Schema.Null, Schema.String]>;
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
        'updateUrlPropertyValueAction',
        'POST',
        '/ticketing/actions/update-url-property-value',
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
              readonly value: Schema.Struct<{
                readonly propertyDefinitionId: Schema.String;
                readonly revision: Schema.Finite;
                readonly value: Schema.NullOr<Schema.String>;
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
      >,
    false
  >
>;
export declare const ticketingOperationContexts: {
  configureNumberPropertyFormatAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  configureSelectOptionOrderAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
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
  createNumberPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createSelectOptionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createSelectOptionAndSelectAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createSelectPropertyDefinitionAction: {
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
  createTextPropertyDefinitionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  createUrlPropertyDefinitionAction: {
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
  getTaskPropertyEditCapability: {
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
  queryTaskPropertyValues: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  queryTaskUrlValues: {
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
  updateNumberPropertyValueAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateSelectOptionAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateSelectPropertyValueAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateTextPropertyValueAction: {
    method: string;
    operationId: string;
    routePath: string;
    source: 'generated-client';
  };
  updateUrlPropertyValueAction: {
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
