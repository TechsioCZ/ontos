import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { taxApi, taxOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
// <generated-governed-http-handler-support-imports>
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
// </generated-governed-http-handler-imports>

const taxReadinessLayer = HttpApiBuilder.group(taxApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.tax.readiness', {
        attributes: microVerticalOperationAttributes(taxOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

const runtimeObservabilityLive = Layer.mergeAll(
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = OperationalScopeResolverLive.pipe(
  Layer.provide(Layer.mergeAll(CorePersistenceLive, ContextAccessLive)),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const readRuntimeDependenciesLive = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
);
const readRuntimeLive = ReadRuntimeLive.pipe(
  Layer.provide(readRuntimeDependenciesLive),
  Layer.provide(DatabaseConfigLive),
);
/** Read runtime bound by generated governed HTTP handlers mounted in the slot below. */
export const governedReadRuntimeLive = readRuntimeLive;

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  taxReadinessLayer,
  // <generated-governed-http-handler-layers>
  // </generated-governed-http-handler-layers>
).pipe(
  // <generated-governed-http-handler-support-layers>
  // </generated-governed-http-handler-support-layers>
  Layer.provide(Layer.mergeAll(runtimeObservabilityLive, RequestSchemaProblemLive)),
);
const resolvedApiHandlersLive = governedReadApiHandlersLive.pipe(Layer.orDie);

export const makeTaxApiRuntime = (): EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> =>
  assembleEffectBffRuntime({
    api: taxApi,
    handlers: resolvedApiHandlersLive,
  });

const apiRuntime: EffectBffDefinition<typeof taxApi> & EffectBffRuntime<typeof taxApi> = makeTaxApiRuntime();

export default apiRuntime;
