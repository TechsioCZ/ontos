import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type {
  EffectBffDefinition,
  EffectBffRuntime,
  EffectRuntimeLayer,
} from '@modern-js/plugin-bff/effect-edge';
import { CorePersistenceLive, ReadRuntimeLive } from '@app/core-runtime';
import { contactDetailReadApiLive } from './contact-detail-read-server.ts';
import { customerDetailReadApiLive } from './customer-detail-read-server.ts';
import { customerTimelineReadApiLive } from './customer-timeline-read-server.ts';
import { dealDetailReadApiLive } from './deal-detail-read-server.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { crmApi, crmOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';

const operationAttributes = (operationContext: OperationContext) => ({
  'modernjs.operation.id': operationContext.operationId,
  'modernjs.operation.method': operationContext.method,
  'modernjs.operation.route': operationContext.routePath,
  'modernjs.operation.source': operationContext.source,
  ...(typeof operationContext.traceId === 'string'
    ? { 'modernjs.trace.id': operationContext.traceId }
    : {}),
});

const crmLayer = HttpApiBuilder.group(crmApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
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
      Effect.withSpan('ultramodern.api.crm.readiness', {
        attributes: operationAttributes(crmOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const readRuntimeLive = ReadRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const layer = HttpApiBuilder.layer(crmApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      crmLayer,
      contactDetailReadApiLive,
      customerDetailReadApiLive,
      customerTimelineReadApiLive,
      dealDetailReadApiLive,
    ),
  ),
  Layer.provide(readRuntimeLive),
) satisfies EffectRuntimeLayer;
const apiRuntime: EffectBffDefinition<typeof crmApi, EffectRuntimeLayer> &
  EffectBffRuntime<typeof crmApi, EffectRuntimeLayer> = defineEffectBff({
  api: crmApi,
  layer,
});

export default apiRuntime;
