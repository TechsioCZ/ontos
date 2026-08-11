import { defineEffectBff, Effect, HttpApiBuilder, Layer } from '@modern-js/plugin-bff/effect-edge';
import type { EffectRuntimeLayer } from '@modern-js/plugin-bff/effect-edge';
import { ActionRuntimeLive, CorePersistenceLive, ReadRuntimeLive } from '@app/core-runtime';
import '../src/customers/customer-actions.runtime.ts';
import { contactDetailReadApiLive } from './contact-detail-read-server.ts';
import { createCustomerActionApiLive } from './create-customer-action-server.ts';
import { customerDetailReadApiLive } from './customer-detail-read-server.ts';
import { customerDirectoryReadApiLive } from './customer-directory-read-server.ts';
import { customerTimelineReadApiLive } from './customer-timeline-read-server.ts';
import { dealDetailReadApiLive } from './deal-detail-read-server.ts';
import { deleteCustomerActionApiLive } from './delete-customer-action-server.ts';
import { editCustomerActionApiLive } from './edit-customer-action-server.ts';
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
const actionRuntimeLive = ActionRuntimeLive.pipe(Layer.provide(CorePersistenceLive), Layer.orDie);
const layer = HttpApiBuilder.layer(crmApi).pipe(
  Layer.provide(
    Layer.mergeAll(
      crmLayer,
      contactDetailReadApiLive,
      createCustomerActionApiLive,
      customerDetailReadApiLive,
      customerDirectoryReadApiLive,
      customerTimelineReadApiLive,
      dealDetailReadApiLive,
      deleteCustomerActionApiLive,
      editCustomerActionApiLive,
    ),
  ),
  Layer.provide(readRuntimeLive),
  Layer.provide(actionRuntimeLive),
) satisfies EffectRuntimeLayer;
// The patched BFF runtime accepts middleware-bearing HttpApi values at runtime, while its
// published AnyWithProps constraint still erases endpoint middleware requirements.
const apiRuntime = defineEffectBff({
  api: crmApi as never,
  layer: layer as never,
});

export default apiRuntime;
