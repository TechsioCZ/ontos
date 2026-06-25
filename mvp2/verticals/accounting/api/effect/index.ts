import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../../src/ultramodern-build.ts';
import {
  accountingEffectApi,
  accountingOperationContexts,
  createAccountingNotFound,
} from '../../shared/effect/api.ts';
import type { OperationContext } from '../../shared/effect/api.ts';

const accountingItems = [
  {
    id: 'starter-accounting',
    marker: ultramodernApiMarker,
    title: 'Wire a real accounting source here',
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

const accountingLayer = HttpApiBuilder.group(accountingEffectApi, 'accounting', (handlers) =>
  handlers
    .handle('list', ({ query }) =>
      Effect.succeed({
        items:
          typeof query.limit === 'number' ? accountingItems.slice(0, query.limit) : accountingItems,
      }).pipe(
        Effect.withSpan('ultramodern.effect.accounting.list', {
          attributes: operationAttributes(accountingOperationContexts.list),
          kind: 'server',
        }),
      ),
    )
    .handle('readiness', () =>
      Effect.succeed({
        checks: {
          effectBff: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker: ultramodernApiMarker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      }).pipe(
        Effect.withSpan('ultramodern.effect.accounting.readiness', {
          attributes: operationAttributes(accountingOperationContexts.readiness),
          kind: 'server',
        }),
      ),
    )
    .handle('get', ({ params }) => {
      const matchedItem = accountingItems.find((candidate) => candidate.id === params.id);
      const result =
        matchedItem === undefined
          ? Effect.fail(createAccountingNotFound(params.id))
          : Effect.succeed(matchedItem);

      return result.pipe(
        Effect.withSpan('ultramodern.effect.accounting.get', {
          attributes: operationAttributes(accountingOperationContexts.get),
          kind: 'server',
        }),
      );
    })
    .handle('create', ({ payload }) =>
      Effect.succeed({
        item: {
          id: `generated-accounting-${payload.title
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, '-')
            .replaceAll(/^-|-$/gu, '')}`,
          marker: ultramodernApiMarker,
          title: payload.title,
        },
      }).pipe(
        Effect.withSpan('ultramodern.effect.accounting.create', {
          attributes: operationAttributes(accountingOperationContexts.create),
          kind: 'server',
        }),
      ),
    ),
);

const layer = HttpApiBuilder.layer(accountingEffectApi).pipe(Layer.provide(accountingLayer));

export default defineEffectBff({
  api: accountingEffectApi,
  layer,
});
