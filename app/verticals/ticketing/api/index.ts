import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ticketingApi, ticketingOperationContexts } from '../shared/api.ts';
import { createTaskActionRegistration } from '../src/actions/create-task.ts';
import { createTaskCollectionActionRegistration } from '../src/actions/create-task-collection.ts';
import { runCoreSdkAction, runCoreSdkDataAccess } from './action-runtime.ts';
import { getTaskCollectionDataAccessRegistration } from '../src/data-access/get-task-collection.ts';
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
