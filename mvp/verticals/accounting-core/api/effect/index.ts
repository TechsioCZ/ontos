import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../../src/ultramodern-build.ts';
import {
  accountingCoreEffectApi,
  accountingCoreOperationContexts,
  AccountingCoreNotFound,
} from '../../shared/effect/api.ts';
import type { OperationContext } from '../../shared/effect/api.ts';

const accountingCoreItems = [
  {
    id: 'starter-accounting-core',
    marker: ultramodernApiMarker,
    title: 'Wire a real accounting-core source here',
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

const accountingCoreLayer = HttpApiBuilder.group(
  accountingCoreEffectApi,
  'accountingCore',
  (handlers) =>
    handlers
      .handle('list', ({ query }) =>
        Effect.succeed({
          items:
            typeof query.limit === 'number'
              ? accountingCoreItems.slice(0, query.limit)
              : accountingCoreItems,
        }).pipe(
          Effect.withSpan('ultramodern.effect.accountingCore.list', {
            attributes: operationAttributes(accountingCoreOperationContexts.list),
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
          Effect.withSpan('ultramodern.effect.accountingCore.readiness', {
            attributes: operationAttributes(accountingCoreOperationContexts.readiness),
            kind: 'server',
          }),
        ),
      )
      .handle('get', ({ params }) => {
        const matchedItem = accountingCoreItems.find((candidate) => candidate.id === params.id);
        const result =
          matchedItem === undefined
            ? Effect.fail(new AccountingCoreNotFound({ id: params.id }))
            : Effect.succeed(matchedItem);

        return result.pipe(
          Effect.withSpan('ultramodern.effect.accountingCore.get', {
            attributes: operationAttributes(accountingCoreOperationContexts.get),
            kind: 'server',
          }),
        );
      })
      .handle('create', ({ payload }) =>
        Effect.succeed({
          item: {
            id: `generated-accounting-core-${payload.title
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/gu, '-')
              .replaceAll(/^-|-$/gu, '')}`,
            marker: ultramodernApiMarker,
            title: payload.title,
          },
        }).pipe(
          Effect.withSpan('ultramodern.effect.accountingCore.create', {
            attributes: operationAttributes(accountingCoreOperationContexts.create),
            kind: 'server',
          }),
        ),
      ),
);

const layer = HttpApiBuilder.layer(accountingCoreEffectApi).pipe(
  Layer.provide(accountingCoreLayer),
);

export default defineEffectBff({
  api: accountingCoreEffectApi,
  layer,
});
