import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ticketingApi, ticketingOperationContexts } from '../shared/api.ts';
import { runCoreSdkAction } from './action-runtime.ts';
import { createTicketActionRegistration } from '../src/actions/create-ticket.ts';
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
    .handle('create', ({ payload }) =>
      Effect.succeed({
        item: {
          id: `generated-ticketing-${payload.title
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, '-')
            .replaceAll(/^-|-$/gu, '')}`,
          marker: ultramodernApiMarker,
          title: payload.title,
        },
      }).pipe(
        Effect.withSpan('ultramodern.api.ticketing.create', {
          attributes: operationAttributes(ticketingOperationContexts.create),
          kind: 'server',
        }),
      ),
    )
    .handle('createTicketAction', ({ payload, request }) =>
      Effect.promise(() =>
        runCoreSdkAction({
          headers: new Headers(request.headers),
          payload,
          registration: createTicketActionRegistration,
        }),
      ).pipe(
        Effect.withSpan('ultramodern.api.ticketing.createTicketAction', {
          attributes: operationAttributes(ticketingOperationContexts.createTicketAction),
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
