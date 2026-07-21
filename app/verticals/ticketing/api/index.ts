import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ticketingApi, ticketingOperationContexts } from '../shared/api.ts';
import { createIntrinsicPropertyDefinitionActionRegistration } from '../src/actions/create-intrinsic-property-definition.ts';
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
import { getTaskPropertyDeletionImpactDataAccessRegistration } from '../src/data-access/get-task-property-deletion-impact.ts';
import { filterTaskCheckboxValuesDataAccessRegistration } from '../src/data-access/filter-task-checkbox-values.ts';
import { queryIntrinsicTaskPropertiesDataAccessRegistration } from '../src/data-access/query-intrinsic-task-properties.ts';
import type { TicketingNotFound, OperationContext } from '../shared/api.ts';

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
      )
        .pipe(
          Effect.flatMap((outcome) =>
            outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome),
          ),
        )
        .pipe(
          Effect.withSpan('ultramodern.api.ticketing.transitionTaskRetentionAction', {
            attributes: operationAttributes(
              ticketingOperationContexts.transitionTaskRetentionAction,
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
      )
        .pipe(
          Effect.flatMap((outcome) =>
            outcome.ok ? Effect.succeed(outcome) : Effect.fail(outcome),
          ),
        )
        .pipe(
          Effect.withSpan('ultramodern.api.ticketing.createIntrinsicPropertyDefinitionAction', {
            attributes: operationAttributes(
              ticketingOperationContexts.createIntrinsicPropertyDefinitionAction,
            ),
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
