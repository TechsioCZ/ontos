import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import { propertiesEffectApi, propertiesOperationContexts } from '../../shared/effect/api.ts';
import type { OperationContext } from '../../shared/effect/api.ts';

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
  ...(typeof operationContext.traceId === 'string'
    ? { 'modernjs.trace.id': operationContext.traceId }
    : {}),
});

const propertiesLayer = HttpApiBuilder.group(propertiesEffectApi, 'properties', (handlers) =>
  handlers.handle('createUnit', () =>
    Effect.log('[properties-bff] createUnit handler called').pipe(
      Effect.as({
        status: 'ok' as const,
      }),
      Effect.withSpan('ultramodern.effect.properties.createUnit', {
        attributes: operationAttributes(propertiesOperationContexts.createUnit),
        kind: 'server',
      }),
    ),
  ),
);

const layer = HttpApiBuilder.layer(propertiesEffectApi).pipe(Layer.provide(propertiesLayer));

export default defineEffectBff({
  api: propertiesEffectApi,
  layer,
});
