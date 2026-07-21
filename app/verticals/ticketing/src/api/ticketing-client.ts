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
  CreateIntrinsicPropertyDefinitionActionFailure,
  CreateIntrinsicPropertyDefinitionActionOutcome,
  CreateIntrinsicPropertyDefinitionActionPayload,
  QueryIntrinsicTaskPropertiesPayload,
  QueryIntrinsicTaskPropertiesResponse,
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
  | CreateIntrinsicPropertyDefinitionActionFailure
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
  locale?: string;
  operationContext?: OperationContext;
  traceparent?: string;
}

type TicketingActionClientOptions = TicketingClientOptions & { idempotencyKey?: string };

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
  browserTimeZone?: string,
  options: TicketingClientOptions = {},
): TicketingClientEffect<TaskPropertyWorkspace> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.getTaskPropertyWorkspace,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.getTaskPropertyWorkspace({
        headers: options.headers ?? {},
        params: { collectionId },
        query: browserTimeZone === undefined ? {} : { browserTimeZone },
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

export const queryIntrinsicTaskProperties = (
  payload: QueryIntrinsicTaskPropertiesPayload,
  options: TicketingClientOptions = {},
): TicketingClientEffect<QueryIntrinsicTaskPropertiesResponse> =>
  createTicketingClient({
    ...options,
    operationContext:
      options.operationContext ?? ticketingOperationContexts.queryIntrinsicTaskProperties,
  }).pipe(
    Effect.flatMap((client) =>
      client.ticketing.queryIntrinsicTaskProperties({
        headers: options.headers ?? {},
        params: { collectionId: payload.collectionId },
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

export const runCreateIntrinsicPropertyDefinitionAction = (
  payload: CreateIntrinsicPropertyDefinitionActionPayload,
  options: TicketingClientOptions & { idempotencyKey?: string } = {},
): TicketingClientEffect<CreateIntrinsicPropertyDefinitionActionOutcome> => {
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
