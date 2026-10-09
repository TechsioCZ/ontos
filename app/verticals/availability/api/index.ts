import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';

import { availabilityApi, availabilityOperationContexts } from '../shared/api.ts';
import type { OperationContext } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';

import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';

// <generated-governed-http-handler-support-imports>
// </generated-governed-http-handler-support-imports>
// <generated-governed-http-handler-imports>
// </generated-governed-http-handler-imports>

// Business read publication awaits the owner integration in #874. Preserved
// contracts and owner services do not participate in the deployed foundation.
const operationAttributes = (operationContext: OperationContext) => {
  const attributes = {
    'modernjs.operation.id': operationContext.operationId,
    'modernjs.operation.method': operationContext.method,
    'modernjs.operation.route': operationContext.routePath,
    'modernjs.operation.source': operationContext.source,
  };
  return operationContext.traceId === undefined
    ? attributes
    : { ...attributes, 'modernjs.trace.id': operationContext.traceId };
};

/** The native assembly installs handlers; the owner composes actual logging and span services here. */
const runtimeObservabilityLive = GovernedReadLayer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
);

const availabilityReadinessLayer = HttpApiBuilder.group(availabilityApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    Effect.succeed({
      checks: {
        api: 'ready' as const,
        moduleFederation: 'ready' as const,
        ssr: 'ready' as const,
        translations: 'ready' as const,
      },
      marker: {
        appId: ultramodernApiMarker.appId,
        build: ultramodernApiMarker.build,
        buildMarker: ultramodernApiMarker.buildMarker,
        deployProfile: ultramodernApiMarker.deployProfile,
        packageName: ultramodernApiMarker.packageName,
        sourceRevision: ultramodernApiMarker.sourceRevision,
        surface: ultramodernApiMarker.surface,
        unitId: ultramodernApiMarker.unitId,
        version: ultramodernApiMarker.version,
      },
      status: 'ready' as const,
      versionSkew: 'none' as const,
    }).pipe(
      Effect.withSpan('ultramodern.api.availability.readiness', {
        attributes: operationAttributes(availabilityOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = GovernedReadLayer.mergeAll(
  availabilityReadinessLayer,
  // <generated-governed-http-handler-layers>
  // </generated-governed-http-handler-layers>
);
export const makeAvailabilityApiRuntime = () =>
  assembleEffectBffRuntime({
    api: availabilityApi,
    handlers: apiHandlersLive.pipe(
      GovernedReadLayer.provide(GovernedReadLayer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
      GovernedReadLayer.orDie,
    ),
  });
const apiRuntime = makeAvailabilityApiRuntime();

export default apiRuntime;
