import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ticketingApi, ticketingOperationContexts } from '../shared/api.ts';
import { updateTaskContentActionRegistration } from '../src/actions/update-task-content.ts';
import { configureIdPropertyPrefixActionRegistration } from '../src/actions/configure-id-property-prefix.ts';
import { createIdPropertyDefinitionActionRegistration } from '../src/actions/create-id-property-definition.ts';
import { duplicateTaskActionRegistration } from '../src/actions/duplicate-task.ts';
import { configurePersonPropertyCardinalityActionRegistration } from '../src/actions/configure-person-property-cardinality.ts';
import { createDatePropertyDefinitionActionRegistration } from '../src/actions/create-date-property-definition.ts';
import { updateDatePropertyValueActionRegistration } from '../src/actions/update-date-property-value.ts';
import { configurePrincipalTimeZonePreferenceActionRegistration } from '../src/actions/configure-principal-time-zone-preference.ts';
import { createIntrinsicPropertyDefinitionActionRegistration } from '../src/actions/create-intrinsic-property-definition.ts';
import { createPersonPropertyDefinitionActionRegistration } from '../src/actions/create-person-property-definition.ts';
import { updatePersonPropertyValueActionRegistration } from '../src/actions/update-person-property-value.ts';
import { createFilesMediaPropertyDefinitionActionRegistration } from '../src/actions/create-files-media-property-definition.ts';
import { uploadFilesMediaItemActionRegistration } from '../src/actions/upload-files-media-item.ts';
import { createEmailPropertyDefinitionActionRegistration } from '../src/actions/create-email-property-definition.ts';
import { updateEmailPropertyValueActionRegistration } from '../src/actions/update-email-property-value.ts';
import { createUrlPropertyDefinitionActionRegistration } from '../src/actions/create-url-property-definition.ts';
import { updateUrlPropertyValueActionRegistration } from '../src/actions/update-url-property-value.ts';
import { createPhonePropertyDefinitionActionRegistration } from '../src/actions/create-phone-property-definition.ts';
import { updatePhonePropertyValueActionRegistration } from '../src/actions/update-phone-property-value.ts';
import { configureNumberPropertyFormatActionRegistration } from '../src/actions/configure-number-property-format.ts';
import { createNumberPropertyDefinitionActionRegistration } from '../src/actions/create-number-property-definition.ts';
import { updateNumberPropertyValueActionRegistration } from '../src/actions/update-number-property-value.ts';
import { updateTextPropertyValueActionRegistration } from '../src/actions/update-text-property-value.ts';
import { createTextPropertyDefinitionActionRegistration } from '../src/actions/create-text-property-definition.ts';
import { configureSelectOptionOrderActionRegistration } from '../src/actions/configure-select-option-order.ts';
import { createSelectOptionAndSelectActionRegistration } from '../src/actions/create-select-option-and-select.ts';
import { updateSelectPropertyValueActionRegistration } from '../src/actions/update-select-property-value.ts';
import { updateSelectOptionActionRegistration } from '../src/actions/update-select-option.ts';
import { createSelectOptionActionRegistration } from '../src/actions/create-select-option.ts';
import { createSelectPropertyDefinitionActionRegistration } from '../src/actions/create-select-property-definition.ts';
import { transitionTaskRetentionActionRegistration } from '../src/actions/transition-task-retention.ts';
import { deleteTaskPropertyDefinitionActionRegistration } from '../src/actions/delete-task-property-definition.ts';
import { duplicateTaskPropertyDefinitionActionRegistration } from '../src/actions/duplicate-task-property-definition.ts';
import { configureTaskPropertyDefinitionActionRegistration } from '../src/actions/configure-task-property-definition.ts';
import { updateCheckboxPropertyValueActionRegistration } from '../src/actions/update-checkbox-property-value.ts';
import { createCheckboxPropertyDefinitionActionRegistration } from '../src/actions/create-checkbox-property-definition.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { runCoreSdkAction, runCoreSdkDataAccess } from './action-runtime.ts';
import { getTaskCollectionDataAccessRegistration } from '../src/data-access/get-task-collection.ts';
import { getTaskPropertyWorkspaceDataAccessRegistration } from '../src/data-access/get-task-property-workspace.ts';
import { getTaskPropertyEditCapabilityDataAccessRegistration } from '../src/data-access/get-task-property-edit-capability.ts';
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { filterTaskCheckboxValuesDataAccessRegistration } from '../src/data-access/filter-task-checkbox-values.ts';
import { groupTaskDateValuesDataAccessRegistration } from '../src/data-access/group-task-date-values.ts';
import { queryTaskEmailValuesDataAccessRegistration } from '../src/data-access/query-task-email-values.ts';
import { queryTaskPersonValuesDataAccessRegistration } from '../src/data-access/query-task-person-values.ts';
import { queryTaskPropertyValuesDataAccessRegistration } from '../src/data-access/query-task-property-values.ts';
import { queryTaskUrlValuesDataAccessRegistration } from '../src/data-access/query-task-url-values.ts';
import { searchEligiblePeopleDataAccessRegistration } from '../src/data-access/search-eligible-people.ts';
import { queryIntrinsicTaskPropertiesDataAccessRegistration } from '../src/data-access/query-intrinsic-task-properties.ts';
import type { TicketingNotFound, OperationContext } from '../shared/api.ts';
import type { ConfigurePersonPropertyCardinalityActionFailure } from '../shared/actions/configure-person-property-cardinality.ts';
import type { TaskPersonQueryFilter } from '../shared/person-query.ts';
import type { CoreSdkOperationTransportOutcome } from './action-runtime.ts';

type CoreSdkOperationTransportFailure = Extract<
  CoreSdkOperationTransportOutcome<unknown>,
  { readonly ok: false }
>;

const failureFields = (failure: CoreSdkOperationTransportFailure) => ({
  ...(failure.code === undefined ? {} : { code: failure.code }),
  httpStatus: failure.httpStatus,
  message: failure.message,
  ok: false as const,
  ...(failure.state === undefined ? {} : { state: failure.state }),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const configurePersonCardinalityFailure = (
  failure: CoreSdkOperationTransportFailure,
): ConfigurePersonPropertyCardinalityActionFailure => {
  if (failure.errorTag !== 'OperationDomainRejected') {
    return {
      ...failureFields(failure),
      errorTag: failure.errorTag,
    };
  }

  if (
    failure.code === 'ticketing.configurePersonPropertyCardinality.assignments_violate_limit' &&
    isRecord(failure.state) &&
    typeof failure.state['violatingTaskCount'] === 'number' &&
    Number.isFinite(failure.state['violatingTaskCount'])
  ) {
    return {
      code: failure.code,
      errorTag: failure.errorTag,
      httpStatus: failure.httpStatus,
      message: failure.message,
      ok: false,
      state: { violatingTaskCount: failure.state['violatingTaskCount'] },
    };
  }

  if (failure.code === 'ticketing.configurePersonPropertyCardinality.stale_or_missing') {
    return {
      code: failure.code,
      errorTag: failure.errorTag,
      httpStatus: failure.httpStatus,
      message: failure.message,
      ok: false,
    };
  }

  return {
    code: 'ticketing.configurePersonPropertyCardinality.unexpected_domain_rejection',
    errorTag: 'OperationExecutionFailed',
    httpStatus: 500,
    message: 'Configure Person Property Cardinality returned an invalid domain failure.',
    ok: false,
  };
};

const ticketingItems = [
  {
    id: 'starter-ticketing',
    marker: ultramodernApiMarker,
    title: 'Wire a real ticketing source here',
  },
];

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
  ...(typeof operationContext.traceId === 'string'
    ? { 'modernjs.trace.id': operationContext.traceId }
    : {}),
});

const ticketingLayer = HttpApiBuilder.group(ticketingApi, 'ticketing', (handlers) =>
  handlers
    .handle('list', ({ query }) =>
      Effect.succeed({
        items:
          typeof query.limit === 'number' ? ticketingItems.slice(0, query.limit) : ticketingItems,
      }).pipe(
        Effect.withSpan('ultramodern.api.ticketing.list', {
          attributes: operationAttributes(ticketingOperationContexts.list),
          kind: 'server',
        }),
      ),
    )
    .handle('readiness', () =>
      Effect.succeed({
        checks: {
          api: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker: ultramodernApiMarker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      }).pipe(
        Effect.withSpan('ultramodern.api.ticketing.readiness', {
          attributes: operationAttributes(ticketingOperationContexts.readiness),
          kind: 'server',
        }),
      ),
    )
    .handle('get', ({ params }) => {
      const matchedItem = ticketingItems.find((candidate) => candidate.id === params.id);
      const notFound: TicketingNotFound = {
        _tag: 'TicketingNotFound',
        id: params.id,
      };
      const result =
        matchedItem === undefined ? Effect.fail(notFound) : Effect.succeed(matchedItem);

      return result.pipe(
        Effect.withSpan('ultramodern.api.ticketing.get', {
          attributes: operationAttributes(ticketingOperationContexts.get),
          kind: 'server',
        }),
      );
    })
    .handle('getTaskCollection', ({ params, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: { collectionId: params.collectionId },
          registration: getTaskCollectionDataAccessRegistration,
          resultCount: () => 1,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.getTaskCollection', {
          attributes: operationAttributes(ticketingOperationContexts.getTaskCollection),
          kind: 'server',
        }),
      ),
    )
    .handle('getTaskPropertyWorkspace', ({ params, query, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            ...(query.browserTimeZone === undefined
              ? {}
              : { browserTimeZone: query.browserTimeZone }),
            ...(query.locale === undefined ? {} : { locale: query.locale }),
          },
          registration: getTaskPropertyWorkspaceDataAccessRegistration,
          resultCount: (response) => response.tasks.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.getTaskPropertyWorkspace', {
          attributes: operationAttributes(ticketingOperationContexts.getTaskPropertyWorkspace),
          kind: 'server',
        }),
      ),
    )
    .handle('queryIntrinsicTaskProperties', ({ params, payload, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: { ...payload, collectionId: params.collectionId },
          registration: queryIntrinsicTaskPropertiesDataAccessRegistration,
          resultCount: (response) => response.tasks.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.queryIntrinsicTaskProperties', {
          attributes: operationAttributes(ticketingOperationContexts.queryIntrinsicTaskProperties),
          kind: 'server',
        }),
      ),
    )
    .handle('getTaskPropertyEditCapability', ({ params, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: { collectionId: params.collectionId },
          registration: getTaskPropertyEditCapabilityDataAccessRegistration,
          resultCount: () => 1,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.getTaskPropertyEditCapability', {
          attributes: operationAttributes(ticketingOperationContexts.getTaskPropertyEditCapability),
          kind: 'server',
        }),
      ),
    )
    .handle('filterTaskCheckboxValues', ({ params, query, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            propertyDefinitionId: params.propertyDefinitionId,
            value: query.value === 'true',
          },
          registration: filterTaskCheckboxValuesDataAccessRegistration,
          resultCount: (response) => response.taskIds.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.filterTaskCheckboxValues', {
          attributes: operationAttributes(ticketingOperationContexts.filterTaskCheckboxValues),
          kind: 'server',
        }),
      ),
    )
    .handle('queryTaskEmailValues', ({ params, query, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            operation: query.operation,
            propertyDefinitionId: params.propertyDefinitionId,
            query: query.query,
          },
          registration: queryTaskEmailValuesDataAccessRegistration,
          resultCount: (response) => response.taskIds.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.queryTaskEmailValues', {
          attributes: operationAttributes(ticketingOperationContexts.queryTaskEmailValues),
          kind: 'server',
        }),
      ),
    )
    .handle('searchEligiblePeople', ({ params, query, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: { collectionId: params.collectionId, query: query.query },
          registration: searchEligiblePeopleDataAccessRegistration,
          resultCount: (response) => response.people.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.searchEligiblePeople', {
          attributes: operationAttributes(ticketingOperationContexts.searchEligiblePeople),
          kind: 'server',
        }),
      ),
    )
    .handle('queryTaskPersonValues', ({ params, query, request }) => {
      let filter: TaskPersonQueryFilter | undefined;
      if (query.filter === 'contains' || query.filter === 'doesNotContain') {
        filter = { operator: query.filter, principalId: query.principalId };
      } else if (query.filter !== undefined) {
        filter = { operator: query.filter };
      }

      return Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            propertyDefinitionId: params.propertyDefinitionId,
            ...(filter === undefined ? {} : { filter }),
            ...(query.group === undefined ? {} : { group: query.group === 'true' }),
            ...(query.search === undefined ? {} : { search: query.search }),
            ...(query.sort === undefined ? {} : { sort: query.sort }),
          },
          registration: queryTaskPersonValuesDataAccessRegistration,
          resultCount: (response) => response.taskIds.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.queryTaskPersonValues', {
          attributes: operationAttributes(ticketingOperationContexts.queryTaskPersonValues),
          kind: 'server',
        }),
      );
    })
    .handle('getTaskPropertyDeletionImpact', ({ params, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            propertyDefinitionId: params.propertyDefinitionId,
          },
          registration: getTaskPropertyDeletionImpactDataAccessRegistration,
          resultCount: () => 1,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.getTaskPropertyDeletionImpact', {
          attributes: operationAttributes(ticketingOperationContexts.getTaskPropertyDeletionImpact),
          kind: 'server',
        }),
      ),
    )
    .handle('groupTaskDateValues', ({ params, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload: {
            collectionId: params.collectionId,
            propertyDefinitionId: params.propertyDefinitionId,
          },
          registration: groupTaskDateValuesDataAccessRegistration,
          resultCount: (response) => response.groups.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.groupTaskDateValues', {
          attributes: operationAttributes(ticketingOperationContexts.groupTaskDateValues),
          kind: 'server',
        }),
      ),
    )
    .handle('queryTaskPropertyValues', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload,
          registration: queryTaskPropertyValuesDataAccessRegistration,
          resultCount: (response) => response.taskIds.length,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.queryTaskPropertyValues', {
          attributes: operationAttributes(ticketingOperationContexts.queryTaskPropertyValues),
          kind: 'server',
        }),
      ),
    )
    .handle('queryTaskUrlValues', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkDataAccess({
          headers: new Headers(request.headers),
          payload,
          registration: queryTaskUrlValuesDataAccessRegistration,
          resultCount: (response) =>
            response.taskIds.length +
            response.groups.reduce((count, group) => count + group.taskIds.length, 0),
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok ? Effect.succeed(outcome.response) : Effect.fail(outcome),
        ),
        Effect.withSpan('ultramodern.api.ticketing.queryTaskUrlValues', {
          attributes: operationAttributes(ticketingOperationContexts.queryTaskUrlValues),
          kind: 'server',
        }),
      ),
    )
    .handle('createTaskCollectionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createTaskCollectionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createTaskCollectionAction', {
          attributes: operationAttributes(ticketingOperationContexts.createTaskCollectionAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createTaskAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createTaskActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createTaskAction', {
          attributes: operationAttributes(ticketingOperationContexts.createTaskAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createCheckboxPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createCheckboxPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createCheckboxPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createCheckboxPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createIntrinsicPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createIntrinsicPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createIntrinsicPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createIntrinsicPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configurePrincipalTimeZonePreferenceAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configurePrincipalTimeZonePreferenceActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.configurePrincipalTimeZonePreferenceAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configurePrincipalTimeZonePreferenceAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateCheckboxPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateCheckboxPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateCheckboxPropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updateCheckboxPropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createEmailPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createEmailPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createEmailPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createEmailPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateEmailPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateEmailPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateEmailPropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updateEmailPropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configureTaskPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configureTaskPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.configureTaskPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configureTaskPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('duplicateTaskPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: duplicateTaskPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.duplicateTaskPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.duplicateTaskPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('deleteTaskPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: deleteTaskPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.deleteTaskPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.deleteTaskPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('transitionTaskRetentionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: transitionTaskRetentionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.transitionTaskRetentionAction', {
          attributes: operationAttributes(ticketingOperationContexts.transitionTaskRetentionAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createTextPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createTextPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createTextPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createTextPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateTextPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateTextPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateTextPropertyValueAction', {
          attributes: operationAttributes(ticketingOperationContexts.updateTextPropertyValueAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createNumberPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createNumberPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createNumberPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createNumberPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateNumberPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateNumberPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateNumberPropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updateNumberPropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configureNumberPropertyFormatAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configureNumberPropertyFormatActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.configureNumberPropertyFormatAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configureNumberPropertyFormatAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createSelectPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createSelectPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createSelectPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createSelectPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createSelectOptionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createSelectOptionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createSelectOptionAction', {
          attributes: operationAttributes(ticketingOperationContexts.createSelectOptionAction),
          kind: 'server',
        }),
      ),
    )
    .handle('updateSelectOptionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateSelectOptionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateSelectOptionAction', {
          attributes: operationAttributes(ticketingOperationContexts.updateSelectOptionAction),
          kind: 'server',
        }),
      ),
    )
    .handle('updateSelectPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateSelectPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateSelectPropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updateSelectPropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createSelectOptionAndSelectAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createSelectOptionAndSelectActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createSelectOptionAndSelectAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createSelectOptionAndSelectAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configureSelectOptionOrderAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configureSelectOptionOrderActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.configureSelectOptionOrderAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configureSelectOptionOrderAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createUrlPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createUrlPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createUrlPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createUrlPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateUrlPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateUrlPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateUrlPropertyValueAction', {
          attributes: operationAttributes(ticketingOperationContexts.updateUrlPropertyValueAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createPhonePropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createPhonePropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createPhonePropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createPhonePropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updatePhonePropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updatePhonePropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updatePhonePropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updatePhonePropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createDatePropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createDatePropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createDatePropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createDatePropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updateDatePropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateDatePropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updateDatePropertyValueAction', {
          attributes: operationAttributes(ticketingOperationContexts.updateDatePropertyValueAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createPersonPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createPersonPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createPersonPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createPersonPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('updatePersonPropertyValueAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updatePersonPropertyValueActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.updatePersonPropertyValueAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.updatePersonPropertyValueAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configurePersonPropertyCardinalityAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configurePersonPropertyCardinalityActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) =>
          outcome.ok
            ? Effect.succeed(outcome)
            : Effect.fail(configurePersonCardinalityFailure(outcome)),
        ),
        Effect.withSpan('ultramodern.api.ticketing.configurePersonPropertyCardinalityAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configurePersonPropertyCardinalityAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('createFilesMediaPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createFilesMediaPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createFilesMediaPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createFilesMediaPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('uploadFilesMediaItemAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: uploadFilesMediaItemActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.uploadFilesMediaItemAction', {
          attributes: operationAttributes(ticketingOperationContexts.uploadFilesMediaItemAction),
          kind: 'server',
        }),
      ),
    )
    .handle('createIdPropertyDefinitionAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createIdPropertyDefinitionActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.createIdPropertyDefinitionAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.createIdPropertyDefinitionAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('configureIdPropertyPrefixAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: configureIdPropertyPrefixActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.configureIdPropertyPrefixAction', {
          attributes: operationAttributes(
            ticketingOperationContexts.configureIdPropertyPrefixAction,
          ),
          kind: 'server',
        }),
      ),
    )
    .handle('duplicateTaskAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: duplicateTaskActionRegistration,
        }),
      ).pipe(
        Effect.flatMap((outcome) => (outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome))),
        Effect.withSpan('ultramodern.api.ticketing.duplicateTaskAction', {
          attributes: operationAttributes(ticketingOperationContexts.duplicateTaskAction),
          kind: 'server',
        }),
      ),
    )
    .handle('updateTaskContentAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: updateTaskContentActionRegistration,
        }),
      )
        .pipe(
          Effect.flatMap((outcome) =>
            outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome),
          ),
        )
        .pipe(
          Effect.withSpan('ultramodern.api.ticketing.updateTaskContentAction', {
            attributes: operationAttributes(ticketingOperationContexts.updateTaskContentAction),
            kind: 'server',
          }),
        ),
    ),
);

const layer = HttpApiBuilder.layer(ticketingApi).pipe(
  Layer.provide(ticketingLayer),
) satisfies EffectRuntimeLayer;

const apiRuntime: EffectBffDefinition<typeof ticketingApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof ticketingApi, EffectRuntimeLayer> = defineEffectBff({
  api: ticketingApi,
  layer,
});

export default apiRuntime;
