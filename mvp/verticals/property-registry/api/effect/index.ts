import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { ultramodernApiMarker } from '../../src/ultramodern-build.ts';
import {
  propertyRegistryEffectApi,
  propertyRegistryOperationContexts,
  PropertyRegistryNotFound,
} from '../../shared/effect/api.ts';
import type { OperationContext } from '../../shared/effect/api.ts';

const propertyRegistryItems = [
  {
    id: 'starter-property-registry',
    marker: ultramodernApiMarker,
    title: 'Wire a real property-registry source here',
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

const propertyRegistryLayer = HttpApiBuilder.group(
  propertyRegistryEffectApi,
  'propertyRegistry',
  (handlers) =>
    handlers
      .handle('list', ({ query }) =>
        Effect.succeed({
          items:
            typeof query.limit === 'number'
              ? propertyRegistryItems.slice(0, query.limit)
              : propertyRegistryItems,
        }).pipe(
          Effect.withSpan('ultramodern.effect.propertyRegistry.list', {
            attributes: operationAttributes(propertyRegistryOperationContexts.list),
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
          Effect.withSpan('ultramodern.effect.propertyRegistry.readiness', {
            attributes: operationAttributes(propertyRegistryOperationContexts.readiness),
            kind: 'server',
          }),
        ),
      )
      .handle('get', ({ params }) => {
        const matchedItem = propertyRegistryItems.find((candidate) => candidate.id === params.id);
        const result =
          matchedItem === undefined
            ? Effect.fail(new PropertyRegistryNotFound({ id: params.id }))
            : Effect.succeed(matchedItem);

        return result.pipe(
          Effect.withSpan('ultramodern.effect.propertyRegistry.get', {
            attributes: operationAttributes(propertyRegistryOperationContexts.get),
            kind: 'server',
          }),
        );
      })
      .handle('create', ({ payload }) =>
        Effect.succeed({
          item: {
            id: `generated-property-registry-${payload.title
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/gu, '-')
              .replaceAll(/^-|-$/gu, '')}`,
            marker: ultramodernApiMarker,
            title: payload.title,
          },
        }).pipe(
          Effect.withSpan('ultramodern.effect.propertyRegistry.create', {
            attributes: operationAttributes(propertyRegistryOperationContexts.create),
            kind: 'server',
          }),
        ),
      ),
);

const layer = HttpApiBuilder.layer(propertyRegistryEffectApi).pipe(
  Layer.provide(propertyRegistryLayer),
);

export default defineEffectBff({
  api: propertyRegistryEffectApi,
  layer,
});
