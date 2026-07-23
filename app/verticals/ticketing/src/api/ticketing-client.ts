import {
  Effect,
  makeEffectHttpApiClient,
  runEffectRequest,
} from '@modern-js/plugin-bff/effect-client';
import type {
  HttpClientError,
  HttpApi,
  HttpApiClient,
  HttpApiGroup,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { ticketingApiContract, ticketingApi, ticketingOperationContexts } from '../../shared/api';
import type {
  TicketingItem,
  TicketingListResponse,
  TicketingNotFound,
  OperationContext,
  TicketingReadiness,
  TaskCollectionAggregate,
  TaskPropertyDeletionImpact,
  MultiSelectOptionDeletionImpact,
  SelectOptionDeletionImpact,
  StatusOptionDeletionImpact,
  TaskPropertyDefinitionEditCapability,
  TaskPropertyEditCapability,
  TaskPropertyWorkspace,
  CreateTaskCollectionActionFailure,
  CreateTaskCollectionActionOutcome,
  CreateTaskCollectionActionPayload,
  CreateTaskActionFailure,
  CreateTaskActionOutcome,
  CreateTaskActionPayload,
  CreateCheckboxPropertyDefinitionActionFailure,
  CreateCheckboxPropertyDefinitionActionOutcome,
  CreateCheckboxPropertyDefinitionActionPayload,
  UpdateCheckboxPropertyValueActionFailure,
  UpdateCheckboxPropertyValueActionOutcome,
  UpdateCheckboxPropertyValueActionPayload,
  FilterTaskCheckboxValuesResponse,
  GroupTaskDateValuesResponse,
  GroupTaskDateRangeValuesResponse,
  ConfigureTaskPropertyDefinitionActionFailure,
  ConfigureTaskPropertyDefinitionActionOutcome,
  ConfigureTaskPropertyDefinitionActionPayload,
  DuplicateTaskPropertyDefinitionActionFailure,
  DuplicateTaskPropertyDefinitionActionOutcome,
  DuplicateTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionFailure,
  DeleteTaskPropertyDefinitionActionOutcome,
  DeleteTaskPropertyDefinitionActionPayload,
  TransitionTaskRetentionActionFailure,
  TransitionTaskRetentionActionOutcome,
  TransitionTaskRetentionActionPayload,
  CreateTextPropertyDefinitionActionFailure,
  CreateTextPropertyDefinitionActionOutcome,
  CreateTextPropertyDefinitionActionPayload,
  UpdateTextPropertyValueActionFailure,
  UpdateTextPropertyValueActionOutcome,
  UpdateTextPropertyValueActionPayload,
  QueryTaskPropertyValuesPayload,
  QueryTaskPropertyValuesResponse,
  ConfigureNumberPropertyFormatActionFailure,
  ConfigureNumberPropertyFormatActionOutcome,
  ConfigureNumberPropertyFormatActionPayload,
  CreateNumberPropertyDefinitionActionFailure,
  CreateNumberPropertyDefinitionActionOutcome,
  CreateNumberPropertyDefinitionActionPayload,
  UpdateNumberPropertyValueActionFailure,
  UpdateNumberPropertyValueActionOutcome,
  UpdateNumberPropertyValueActionPayload,
  CreateSelectPropertyDefinitionActionFailure,
  CreateSelectPropertyDefinitionActionOutcome,
  CreateSelectPropertyDefinitionActionPayload,
  CreateSelectOptionActionFailure,
  CreateSelectOptionActionOutcome,
  CreateSelectOptionActionPayload,
  UpdateSelectOptionActionFailure,
  UpdateSelectOptionActionOutcome,
  UpdateSelectOptionActionPayload,
  UpdateSelectPropertyValueActionFailure,
  UpdateSelectPropertyValueActionOutcome,
  UpdateSelectPropertyValueActionPayload,
  CreateSelectOptionAndSelectActionFailure,
  CreateSelectOptionAndSelectActionOutcome,
  CreateSelectOptionAndSelectActionPayload,
  ConfigureSelectOptionOrderActionFailure,
  ConfigureSelectOptionOrderActionOutcome,
  ConfigureSelectOptionOrderActionPayload,
  CreateUrlPropertyDefinitionActionFailure,
  CreateUrlPropertyDefinitionActionOutcome,
  CreateUrlPropertyDefinitionActionPayload,
  QueryTaskUrlValuesPayload,
  QueryTaskUrlValuesResponse,
  UpdateUrlPropertyValueActionFailure,
  UpdateUrlPropertyValueActionOutcome,
  UpdateUrlPropertyValueActionPayload,
  CreateEmailPropertyDefinitionActionFailure,
  CreateEmailPropertyDefinitionActionOutcome,
  CreateEmailPropertyDefinitionActionPayload,
  UpdateEmailPropertyValueActionFailure,
  UpdateEmailPropertyValueActionOutcome,
  UpdateEmailPropertyValueActionPayload,
  QueryTaskEmailValuesPayload,
  QueryTaskEmailValuesResponse,
  CreatePhonePropertyDefinitionActionFailure,
  CreatePhonePropertyDefinitionActionOutcome,
  CreatePhonePropertyDefinitionActionPayload,
  UpdatePhonePropertyValueActionFailure,
  UpdatePhonePropertyValueActionOutcome,
  UpdatePhonePropertyValueActionPayload,
  CreateDatePropertyDefinitionActionFailure,
  CreateDatePropertyDefinitionActionOutcome,
  CreateDatePropertyDefinitionActionPayload,
  UpdateDatePropertyValueActionFailure,
  UpdateDatePropertyValueActionOutcome,
  UpdateDatePropertyValueActionPayload,
  ConfigurePersonPropertyCardinalityActionFailure,
  ConfigurePersonPropertyCardinalityActionOutcome,
  ConfigurePersonPropertyCardinalityActionPayload,
  CreatePersonPropertyDefinitionActionFailure,
  CreatePersonPropertyDefinitionActionOutcome,
  CreatePersonPropertyDefinitionActionPayload,
  QueryTaskPersonValuesPayload,
  QueryTaskPersonValuesResponse,
  SearchEligiblePeopleResponse,
  UpdatePersonPropertyValueActionFailure,
  UpdatePersonPropertyValueActionOutcome,
  UpdatePersonPropertyValueActionPayload,
  ConfigurePrincipalTimeZonePreferenceActionFailure,
  ConfigurePrincipalTimeZonePreferenceActionOutcome,
  ConfigurePrincipalTimeZonePreferenceActionPayload,
  CreateIntrinsicPropertyDefinitionActionFailure,
  CreateIntrinsicPropertyDefinitionActionOutcome,
  CreateIntrinsicPropertyDefinitionActionPayload,
  QueryIntrinsicTaskPropertiesPayload,
  QueryIntrinsicTaskPropertiesResponse,
  CreateFilesMediaPropertyDefinitionActionFailure,
  CreateFilesMediaPropertyDefinitionActionOutcome,
  CreateFilesMediaPropertyDefinitionActionPayload,
  UploadFilesMediaItemActionFailure,
  UploadFilesMediaItemActionOutcome,
  UploadFilesMediaItemActionPayload,
  ConfigureIdPropertyPrefixActionFailure,
  ConfigureIdPropertyPrefixActionOutcome,
  ConfigureIdPropertyPrefixActionPayload,
  CreateIdPropertyDefinitionActionFailure,
  CreateIdPropertyDefinitionActionOutcome,
  CreateIdPropertyDefinitionActionPayload,
  DuplicateTaskActionFailure,
  DuplicateTaskActionOutcome,
  DuplicateTaskActionPayload,
  UpdateTaskContentActionFailure,
  UpdateTaskContentActionOutcome,
  UpdateTaskContentActionPayload,
  CreateStatusPropertyDefinitionActionFailure,
  CreateStatusPropertyDefinitionActionOutcome,
  CreateStatusPropertyDefinitionActionPayload,
  ConfigureStatusDefaultActionFailure,
  ConfigureStatusDefaultActionOutcome,
  ConfigureStatusDefaultActionPayload,
  UpdateStatusPropertyValueActionFailure,
  UpdateStatusPropertyValueActionOutcome,
  UpdateStatusPropertyValueActionPayload,
  CreateStatusOptionActionFailure,
  CreateStatusOptionActionOutcome,
  CreateStatusOptionActionPayload,
  UpdateStatusOptionActionFailure,
  UpdateStatusOptionActionOutcome,
  UpdateStatusOptionActionPayload,
  CreateDateRangePropertyDefinitionActionFailure,
  CreateDateRangePropertyDefinitionActionOutcome,
  CreateDateRangePropertyDefinitionActionPayload,
  UpdateDateRangePropertyValueActionFailure,
  UpdateDateRangePropertyValueActionOutcome,
  UpdateDateRangePropertyValueActionPayload,
  ConfigureDateRangeTimeSupportActionFailure,
  ConfigureDateRangeTimeSupportActionOutcome,
  ConfigureDateRangeTimeSupportActionPayload,
  UploadFilesMediaItemsActionFailure,
  UploadFilesMediaItemsActionOutcome,
  UploadFilesMediaItemsActionPayload,
  CreateMultiSelectPropertyDefinitionActionFailure,
  CreateMultiSelectPropertyDefinitionActionOutcome,
  CreateMultiSelectPropertyDefinitionActionPayload,
  CreateMultiSelectOptionActionFailure,
  CreateMultiSelectOptionActionOutcome,
  CreateMultiSelectOptionActionPayload,
  UpdateMultiSelectPropertyValueActionFailure,
  UpdateMultiSelectPropertyValueActionOutcome,
  UpdateMultiSelectPropertyValueActionPayload,
  UpdateMultiSelectOptionActionFailure,
  UpdateMultiSelectOptionActionOutcome,
  UpdateMultiSelectOptionActionPayload,
  ReorderMultiSelectOptionsActionFailure,
  ReorderMultiSelectOptionsActionOutcome,
  ReorderMultiSelectOptionsActionPayload,
  CreateMultiSelectOptionAndSelectActionFailure,
  CreateMultiSelectOptionAndSelectActionOutcome,
  CreateMultiSelectOptionAndSelectActionPayload,
  DeleteSelectOptionActionFailure,
  DeleteSelectOptionActionOutcome,
  DeleteSelectOptionActionPayload,
  CoreReferenceRequest,
  CoreReferenceResponse,
  RetainTextCoreReferenceLabelActionFailure,
  RetainTextCoreReferenceLabelActionOutcome,
  RetainTextCoreReferenceLabelActionPayload,
  DeleteMultiSelectOptionActionFailure,
  DeleteMultiSelectOptionActionOutcome,
  DeleteMultiSelectOptionActionPayload,
  AddFilesMediaExternalItemActionFailure,
  AddFilesMediaExternalItemActionOutcome,
  AddFilesMediaExternalItemActionPayload,
  ReorderFilesMediaItemsActionFailure,
  ReorderFilesMediaItemsActionOutcome,
  ReorderFilesMediaItemsActionPayload,
  RemoveFilesMediaItemActionFailure,
  RemoveFilesMediaItemActionOutcome,
  RemoveFilesMediaItemActionPayload,
  DeleteStatusOptionActionFailure,
  DeleteStatusOptionActionOutcome,
  DeleteStatusOptionActionPayload,
} from '../../shared/api';

export { Effect, runEffectRequest };

type TicketingApiGroups =
  typeof ticketingApi extends HttpApi.HttpApi<infer _ApiId, infer Groups> ? Groups : never;

export type TicketingClient = HttpApiClient.Client<
  Extract<TicketingApiGroups, HttpApiGroup.Any>,
  never,
  never
>;

export type TicketingClientError =
  | DeleteMultiSelectOptionActionFailure
  | RemoveFilesMediaItemActionFailure
  | ReorderFilesMediaItemsActionFailure
  | AddFilesMediaExternalItemActionFailure
  | DeleteStatusOptionActionFailure
  | RetainTextCoreReferenceLabelActionFailure
  | DeleteSelectOptionActionFailure
  | CreateMultiSelectOptionAndSelectActionFailure
  | ReorderMultiSelectOptionsActionFailure
  | UpdateMultiSelectOptionActionFailure
  | UpdateMultiSelectPropertyValueActionFailure
  | CreateMultiSelectOptionActionFailure
  | CreateMultiSelectPropertyDefinitionActionFailure
  | ConfigureDateRangeTimeSupportActionFailure
  | UpdateDateRangePropertyValueActionFailure
  | CreateDateRangePropertyDefinitionActionFailure
  | UpdateTaskContentActionFailure
  | UpdateStatusOptionActionFailure
  | CreateStatusOptionActionFailure
  | UpdateStatusPropertyValueActionFailure
  | ConfigureStatusDefaultActionFailure
  | CreateStatusPropertyDefinitionActionFailure
  | UploadFilesMediaItemsActionFailure
  | DuplicateTaskActionFailure
  | ConfigureIdPropertyPrefixActionFailure
  | CreateIdPropertyDefinitionActionFailure
  | UploadFilesMediaItemActionFailure
  | CreateFilesMediaPropertyDefinitionActionFailure
  | CreateDatePropertyDefinitionActionFailure
  | UpdateDatePropertyValueActionFailure
  | ConfigurePersonPropertyCardinalityActionFailure
  | CreatePersonPropertyDefinitionActionFailure
  | UpdatePersonPropertyValueActionFailure
  | ConfigurePrincipalTimeZonePreferenceActionFailure
  | CreateIntrinsicPropertyDefinitionActionFailure
  | UpdatePhonePropertyValueActionFailure
  | CreatePhonePropertyDefinitionActionFailure
  | UpdateEmailPropertyValueActionFailure
  | CreateEmailPropertyDefinitionActionFailure
  | UpdateUrlPropertyValueActionFailure
  | CreateUrlPropertyDefinitionActionFailure
  | ConfigureSelectOptionOrderActionFailure
  | CreateSelectOptionAndSelectActionFailure
  | UpdateSelectPropertyValueActionFailure
  | UpdateSelectOptionActionFailure
  | CreateSelectOptionActionFailure
  | CreateSelectPropertyDefinitionActionFailure
  | ConfigureNumberPropertyFormatActionFailure
  | UpdateNumberPropertyValueActionFailure
  | CreateNumberPropertyDefinitionActionFailure
  | UpdateTextPropertyValueActionFailure
  | CreateTextPropertyDefinitionActionFailure
  | TransitionTaskRetentionActionFailure
  | DeleteTaskPropertyDefinitionActionFailure
  | DuplicateTaskPropertyDefinitionActionFailure
  | ConfigureTaskPropertyDefinitionActionFailure
  | UpdateCheckboxPropertyValueActionFailure
  | CreateCheckboxPropertyDefinitionActionFailure
  | CreateTaskActionFailure
  | CreateTaskCollectionActionFailure
  | TicketingNotFound
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export type TicketingClientEffect<Success> = Effect.Effect<Success, TicketingClientError, never>;

export interface TicketingClientOptions {
  headers?: Record<string, string>;
  baseUrl?: string | URL;
  browserTimeZone?: string;
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

type TicketingActionClientOptions = TicketingClientOptions & { idempotencyKey?: string };

const browserLocaleFallback = 'en';

export const resolveTicketingBrowserLocale = (): string => {
  if (typeof navigator === 'undefined') {
    return browserLocaleFallback;
  }

  const preferredLocale =
    navigator.languages.find((language) => language.trim().length > 0) ?? navigator.language;

  return preferredLocale.trim() || browserLocaleFallback;
};

const actionHeaders = (options: TicketingActionClientOptions): Record<string, string> | undefined =>
  options.idempotencyKey === undefined
    ? options.headers
    : {
        ...options.headers,
        'Idempotency-Key': options.idempotencyKey,
      };

export const createTicketingClient = (
  options: TicketingClientOptions = {},
): TicketingClientEffect<TicketingClient> =>
  makeEffectHttpApiClient(ticketingApi, {
    baseUrl: options.baseUrl ?? ticketingApiContract.apiPrefix,
    requestContext: {
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.operationContext === undefined
        ? {}
        : { operationContext: options.operationContext }),
      ...(options.traceparent === undefined ? {} : { traceparent: options.traceparent }),
    },
  });

export const listTicketing = (
  options: TicketingClientOptions & { limit?: number } = {},
): TicketingClientEffect<TicketingListResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.list,
  }).pipe(Effect.flatMap((client) => client.ticketing.list({ query: { limit: options.limit } })));

export const getTicketingReadiness = (
  options: TicketingClientOptions = {},
): TicketingClientEffect<TicketingReadiness> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.readiness,
  }).pipe(Effect.flatMap((client) => client.ticketing.readiness({})));

export const getTicketing = (
  id: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TicketingItem> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.get,
  }).pipe(Effect.flatMap((client) => client.ticketing.get({ params: { id } })));

export const executeCoreReference = (
  payload: CoreReferenceRequest,
  options: TicketingClientOptions = {},
): TicketingClientEffect<CoreReferenceResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.coreReference,
  }).pipe(
    Effect.flatMap((client) => {
      switch (payload.operation) {
        case 'discover': {
          return client.ticketing.coreReference({
            headers: options.headers ?? {},
            payload,
          });
        }
        case 'insert': {
          return client.ticketing.coreReference({
            headers: options.headers ?? {},
            payload,
          });
        }
        case 'open': {
          return client.ticketing.coreReference({
            headers: options.headers ?? {},
            payload,
          });
        }
        case 'resolve': {
          return client.ticketing.coreReference({
            headers: options.headers ?? {},
            payload,
          });
        }
        default: {
          return payload satisfies never;
        }
      }
    }),
  );

export const getTaskCollection = (
  collectionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskCollectionAggregate> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.getTaskCollection,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskCollection({
        headers: options.headers ?? {},
        params: { collectionId },
      }),
    ),
  );

export const getTaskPropertyWorkspace = (
  collectionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskPropertyWorkspace> => {
  const locale = resolveTicketingBrowserLocale();

  return createTicketingClient({
    ...options,
    locale,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getTaskPropertyWorkspace,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskPropertyWorkspace({
        headers: options.headers ?? {},
        params: { collectionId },
        query: {
          ...(options.browserTimeZone === undefined
            ? {}
            : { browserTimeZone: options.browserTimeZone }),
          locale,
        },
      }),
    ),
  );
};

export type QueryIntrinsicTaskPropertiesClientPayload = Omit<
  QueryIntrinsicTaskPropertiesPayload,
  'viewerLocale'
>;

export const queryIntrinsicTaskProperties = (
  payload: QueryIntrinsicTaskPropertiesClientPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryIntrinsicTaskPropertiesResponse> => {
  const locale = resolveTicketingBrowserLocale();

  return createTicketingClient({
    ...options,
    locale,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.queryIntrinsicTaskProperties,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryIntrinsicTaskProperties({
        headers: options.headers ?? {},
        params: { collectionId: payload.collectionId },
        payload: { ...payload, viewerLocale: locale },
      }),
    ),
  );
};

export const getTaskPropertyEditCapability = (
  collectionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskPropertyEditCapability> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getTaskPropertyEditCapability,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskPropertyEditCapability({
        headers: options.headers ?? {},
        params: { collectionId },
      }),
    ),
  );

export const getTaskPropertyDefinitionEditCapability = (
  collectionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskPropertyDefinitionEditCapability> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.getTaskPropertyDefinitionEditCapability,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskPropertyDefinitionEditCapability({
        headers: options.headers ?? {},
        params: { collectionId },
      }),
    ),
  );

export const filterTaskCheckboxValues = (
  collectionId: string,
  propertyDefinitionId: string,
  value: boolean,
  options: TicketingClientOptions = {},
): TicketingClientEffect<FilterTaskCheckboxValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.filterTaskCheckboxValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.filterTaskCheckboxValues({
        headers: options.headers ?? {},
        params: { collectionId, propertyDefinitionId },
        query: { value: value ? 'true' : 'false' },
      }),
    ),
  );

export const groupTaskDateValues = (
  collectionId: string,
  propertyDefinitionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<GroupTaskDateValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.groupTaskDateValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.groupTaskDateValues({
        headers: options.headers ?? {},
        params: { collectionId, propertyDefinitionId },
      }),
    ),
  );

export const groupTaskDateRangeValues = (
  collectionId: string,
  propertyDefinitionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<GroupTaskDateRangeValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.groupTaskDateRangeValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.groupTaskDateRangeValues({
        headers: options.headers ?? {},
        params: { collectionId, propertyDefinitionId },
      }),
    ),
  );

export const queryTaskEmailValues = (
  payload: QueryTaskEmailValuesPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryTaskEmailValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.queryTaskEmailValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryTaskEmailValues({
        headers: options.headers ?? {},
        params: {
          collectionId: payload.collectionId,
          propertyDefinitionId: payload.propertyDefinitionId,
        },
        query: { operation: payload.operation, query: payload.query },
      }),
    ),
  );

const taskPersonHttpQuery = (payload: QueryTaskPersonValuesPayload) => {
  const common = {
    ...(payload.group === undefined
      ? {}
      : { group: payload.group ? ('true' as const) : ('false' as const) }),
    ...(payload.search === undefined ? {} : { search: payload.search }),
    ...(payload.sort === undefined ? {} : { sort: payload.sort }),
  };

  if (payload.filter === undefined) {
    return common;
  }
  if ('principalId' in payload.filter) {
    return {
      ...common,
      filter: payload.filter.operator,
      principalId: payload.filter.principalId,
    };
  }
  return { ...common, filter: payload.filter.operator };
};

export const queryTaskPersonValues = (
  payload: QueryTaskPersonValuesPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryTaskPersonValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.queryTaskPersonValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryTaskPersonValues({
        headers: options.headers ?? {},
        params: {
          collectionId: payload.collectionId,
          propertyDefinitionId: payload.propertyDefinitionId,
        },
        query: taskPersonHttpQuery(payload),
      }),
    ),
  );

export const searchEligiblePeople = (
  collectionId: string,
  query: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<SearchEligiblePeopleResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.searchEligiblePeople,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.searchEligiblePeople({
        headers: options.headers ?? {},
        params: { collectionId },
        query: { query },
      }),
    ),
  );

export const queryTaskUrlValues = (
  payload: QueryTaskUrlValuesPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryTaskUrlValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext: options.operationContext ?? ticketingOperationContexts.queryTaskUrlValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryTaskUrlValues({
        headers: options.headers ?? {},
        payload,
      }),
    ),
  );

export const getTaskPropertyDeletionImpact = (
  collectionId: string,
  propertyDefinitionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskPropertyDeletionImpact> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getTaskPropertyDeletionImpact,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskPropertyDeletionImpact({
        headers: options.headers ?? {},
        params: { collectionId, propertyDefinitionId },
      }),
    ),
  );

export const getSelectOptionDeletionImpact = (
  collectionId: string,
  propertyDefinitionId: string,
  optionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<SelectOptionDeletionImpact> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getSelectOptionDeletionImpact,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getSelectOptionDeletionImpact({
        headers: options.headers ?? {},
        params: { collectionId, optionId, propertyDefinitionId },
      }),
    ),
  );

export const getMultiSelectOptionDeletionImpact = (
  collectionId: string,
  propertyDefinitionId: string,
  optionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<MultiSelectOptionDeletionImpact> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getMultiSelectOptionDeletionImpact,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getMultiSelectOptionDeletionImpact({
        headers: options.headers ?? {},
        params: { collectionId, optionId, propertyDefinitionId },
      }),
    ),
  );

export const getStatusOptionDeletionImpact = (
  collectionId: string,
  propertyDefinitionId: string,
  optionId: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<StatusOptionDeletionImpact> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getStatusOptionDeletionImpact,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getStatusOptionDeletionImpact({
        headers: options.headers ?? {},
        params: { collectionId, optionId, propertyDefinitionId },
      }),
    ),
  );

export const queryTaskPropertyValues = (
  payload: QueryTaskPropertyValuesPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryTaskPropertyValuesResponse> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.queryTaskPropertyValues,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryTaskPropertyValues({
        headers: options.headers ?? {},
        payload,
      }),
    ),
  );

export const runCreateTaskCollectionAction = (
  payload: CreateTaskCollectionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateTaskCollectionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createTaskCollectionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createTaskCollectionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateTaskAction = (
  payload: CreateTaskActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateTaskActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext: options.operationContext ?? ticketingOperationContexts.createTaskAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createTaskAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateCheckboxPropertyDefinitionAction = (
  payload: CreateCheckboxPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateCheckboxPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createCheckboxPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createCheckboxPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateCheckboxPropertyValueAction = (
  payload: UpdateCheckboxPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateCheckboxPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateCheckboxPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateCheckboxPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runConfigureTaskPropertyDefinitionAction = (
  payload: ConfigureTaskPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigureTaskPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureTaskPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureTaskPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runDuplicateTaskPropertyDefinitionAction = (
  payload: DuplicateTaskPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<DuplicateTaskPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.duplicateTaskPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.duplicateTaskPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runDeleteTaskPropertyDefinitionAction = (
  payload: DeleteTaskPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<DeleteTaskPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.deleteTaskPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.deleteTaskPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runTransitionTaskRetentionAction = (
  payload: TransitionTaskRetentionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<TransitionTaskRetentionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.transitionTaskRetentionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.transitionTaskRetentionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateDatePropertyDefinitionAction = (
  payload: CreateDatePropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateDatePropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createDatePropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createDatePropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateDatePropertyValueAction = (
  payload: UpdateDatePropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateDatePropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateDatePropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateDatePropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateTextPropertyDefinitionAction = (
  payload: CreateTextPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateTextPropertyDefinitionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createTextPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createTextPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateTextPropertyValueAction = (
  payload: UpdateTextPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateTextPropertyValueActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateTextPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateTextPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateNumberPropertyDefinitionAction = (
  payload: CreateNumberPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateNumberPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createNumberPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createNumberPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateNumberPropertyValueAction = (
  payload: UpdateNumberPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateNumberPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateNumberPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateNumberPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runConfigureNumberPropertyFormatAction = (
  payload: ConfigureNumberPropertyFormatActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigureNumberPropertyFormatActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureNumberPropertyFormatAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureNumberPropertyFormatAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateSelectPropertyDefinitionAction = (
  payload: CreateSelectPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateSelectPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createSelectPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createSelectPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateSelectOptionAction = (
  payload: CreateSelectOptionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateSelectOptionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateSelectOptionAction = (
  payload: UpdateSelectOptionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateSelectOptionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateSelectPropertyValueAction = (
  payload: UpdateSelectPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateSelectPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateSelectPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateSelectPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateSelectOptionAndSelectAction = (
  payload: CreateSelectOptionAndSelectActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateSelectOptionAndSelectActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createSelectOptionAndSelectAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createSelectOptionAndSelectAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export type ConfigureSelectOptionOrderClientPayload = Omit<
  ConfigureSelectOptionOrderActionPayload,
  'viewerLocale'
>;

export const runConfigureSelectOptionOrderAction = (
  payload: ConfigureSelectOptionOrderClientPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigureSelectOptionOrderActionOutcome> => {
  const headers = actionHeaders(options);
  const locale = resolveTicketingBrowserLocale();

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    locale,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureSelectOptionOrderAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureSelectOptionOrderAction({
        headers: headers ?? {},
        payload: { ...payload, viewerLocale: locale },
      }),
    ),
  );
};

export const runCreateUrlPropertyDefinitionAction = (
  payload: CreateUrlPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateUrlPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createUrlPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createUrlPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateUrlPropertyValueAction = (
  payload: UpdateUrlPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateUrlPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateUrlPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateUrlPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateEmailPropertyDefinitionAction = (
  payload: CreateEmailPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateEmailPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createEmailPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createEmailPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateEmailPropertyValueAction = (
  payload: UpdateEmailPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdateEmailPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateEmailPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateEmailPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreatePhonePropertyDefinitionAction = (
  payload: CreatePhonePropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreatePhonePropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createPhonePropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createPhonePropertyDefinitionAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runUpdatePhonePropertyValueAction = (
  payload: UpdatePhonePropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdatePhonePropertyValueActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updatePhonePropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updatePhonePropertyValueAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runCreatePersonPropertyDefinitionAction = (
  payload: CreatePersonPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreatePersonPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createPersonPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createPersonPropertyDefinitionAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runUpdatePersonPropertyValueAction = (
  payload: UpdatePersonPropertyValueActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UpdatePersonPropertyValueActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updatePersonPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updatePersonPropertyValueAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runConfigurePersonPropertyCardinalityAction = (
  payload: ConfigurePersonPropertyCardinalityActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigurePersonPropertyCardinalityActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.configurePersonPropertyCardinalityAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configurePersonPropertyCardinalityAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateIntrinsicPropertyDefinitionAction = (
  payload: CreateIntrinsicPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateIntrinsicPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.createIntrinsicPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createIntrinsicPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runConfigurePrincipalTimeZonePreferenceAction = (
  payload: ConfigurePrincipalTimeZonePreferenceActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigurePrincipalTimeZonePreferenceActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.configurePrincipalTimeZonePreferenceAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configurePrincipalTimeZonePreferenceAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateFilesMediaPropertyDefinitionAction = (
  payload: CreateFilesMediaPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateFilesMediaPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.createFilesMediaPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createFilesMediaPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUploadFilesMediaItemAction = (
  payload: UploadFilesMediaItemActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UploadFilesMediaItemActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.uploadFilesMediaItemAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.uploadFilesMediaItemAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runUploadFilesMediaItemsAction = (
  payload: UploadFilesMediaItemsActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<UploadFilesMediaItemsActionOutcome> => {
  const headers = actionHeaders(options);

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.uploadFilesMediaItemsAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.uploadFilesMediaItemsAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateIdPropertyDefinitionAction = (
  payload: CreateIdPropertyDefinitionActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<CreateIdPropertyDefinitionActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createIdPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createIdPropertyDefinitionAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runConfigureIdPropertyPrefixAction = (
  payload: ConfigureIdPropertyPrefixActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<ConfigureIdPropertyPrefixActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureIdPropertyPrefixAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureIdPropertyPrefixAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runDuplicateTaskAction = (
  payload: DuplicateTaskActionPayload,
  options: TicketingActionClientOptions = {},
): TicketingClientEffect<DuplicateTaskActionOutcome> => {
  const headers = actionHeaders(options);
  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext: options.operationContext ?? ticketingOperationContexts.duplicateTaskAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.duplicateTaskAction({ headers: headers ?? {}, payload }),
    ),
  );
};

export const runUpdateTaskContentAction = (
  payload: UpdateTaskContentActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateTaskContentActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateTaskContentAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateTaskContentAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateStatusPropertyDefinitionAction = (
  payload: CreateStatusPropertyDefinitionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateStatusPropertyDefinitionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createStatusPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createStatusPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runConfigureStatusDefaultAction = (
  payload: ConfigureStatusDefaultActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<ConfigureStatusDefaultActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureStatusDefaultAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureStatusDefaultAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateStatusPropertyValueAction = (
  payload: UpdateStatusPropertyValueActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateStatusPropertyValueActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateStatusPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateStatusPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateStatusOptionAction = (
  payload: CreateStatusOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateStatusOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createStatusOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createStatusOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateStatusOptionAction = (
  payload: UpdateStatusOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateStatusOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateStatusOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateStatusOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateDateRangePropertyDefinitionAction = (
  payload: CreateDateRangePropertyDefinitionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateDateRangePropertyDefinitionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.createDateRangePropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createDateRangePropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateDateRangePropertyValueAction = (
  payload: UpdateDateRangePropertyValueActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateDateRangePropertyValueActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateDateRangePropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateDateRangePropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runConfigureDateRangeTimeSupportAction = (
  payload: ConfigureDateRangeTimeSupportActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<ConfigureDateRangeTimeSupportActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.configureDateRangeTimeSupportAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.configureDateRangeTimeSupportAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateMultiSelectPropertyDefinitionAction = (
  payload: CreateMultiSelectPropertyDefinitionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateMultiSelectPropertyDefinitionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ??
      ticketingOperationContexts.createMultiSelectPropertyDefinitionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createMultiSelectPropertyDefinitionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateMultiSelectOptionAction = (
  payload: CreateMultiSelectOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateMultiSelectOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createMultiSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createMultiSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateMultiSelectPropertyValueAction = (
  payload: UpdateMultiSelectPropertyValueActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateMultiSelectPropertyValueActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateMultiSelectPropertyValueAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateMultiSelectPropertyValueAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runUpdateMultiSelectOptionAction = (
  payload: UpdateMultiSelectOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<UpdateMultiSelectOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.updateMultiSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.updateMultiSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runReorderMultiSelectOptionsAction = (
  payload: ReorderMultiSelectOptionsActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<ReorderMultiSelectOptionsActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.reorderMultiSelectOptionsAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.reorderMultiSelectOptionsAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runCreateMultiSelectOptionAndSelectAction = (
  payload: CreateMultiSelectOptionAndSelectActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateMultiSelectOptionAndSelectActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.createMultiSelectOptionAndSelectAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.createMultiSelectOptionAndSelectAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runDeleteSelectOptionAction = (
  payload: DeleteSelectOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<DeleteSelectOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.deleteSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.deleteSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runRetainTextCoreReferenceLabelAction = (
  payload: RetainTextCoreReferenceLabelActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<RetainTextCoreReferenceLabelActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.retainTextCoreReferenceLabelAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.retainTextCoreReferenceLabelAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runAddFilesMediaExternalItemAction = (
  payload: AddFilesMediaExternalItemActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<AddFilesMediaExternalItemActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.addFilesMediaExternalItemAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.addFilesMediaExternalItemAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runReorderFilesMediaItemsAction = (
  payload: ReorderFilesMediaItemsActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<ReorderFilesMediaItemsActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.reorderFilesMediaItemsAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.reorderFilesMediaItemsAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runRemoveFilesMediaItemAction = (
  payload: RemoveFilesMediaItemActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<RemoveFilesMediaItemActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.removeFilesMediaItemAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.removeFilesMediaItemAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runDeleteStatusOptionAction = (
  payload: DeleteStatusOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<DeleteStatusOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.deleteStatusOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.deleteStatusOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};

export const runDeleteMultiSelectOptionAction = (
  payload: DeleteMultiSelectOptionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<DeleteMultiSelectOptionActionOutcome> => {
  const headers =
    options.idempotencyKey === undefined
      ? options.headers
      : {
          ...options.headers,
          'Idempotency-Key': options.idempotencyKey,
        };

  return createTicketingClient({
    ...options,
    ...(headers === undefined ? undefined : { headers }),
    operationContext:
      options.operationContext ?? ticketingOperationContexts.deleteMultiSelectOptionAction,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.deleteMultiSelectOptionAction({
        headers: headers ?? {},
        payload,
      }),
    ),
  );
};
