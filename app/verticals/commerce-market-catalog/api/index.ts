import {
  ActionCoreErrorSchema,
  ActionPayloadValidationError,
  ActionTransportMetadataSchema,
  TrustedPrincipalContextSchema,
  readVerifiedGatewayCompositionRevision,
  ActionHandlerExecutionError,
  makeActionAuthorizationPreflightPermit,
  ActionRuntime,
  ActionAuthorizationPreflight,
  OperationalScopeResolver,
  makeActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  GatewayAssertionRedemptionService,
  ReadRuntime,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type {
  ActionCoreError,
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
  ActionRuntimeService,
  ReadRuntimeService,
  OperationalScopeResolverService,
} from '@app/core-runtime';
import { RetireMarketPayloadSchema, MarketCommandRejected } from '../shared/action-contracts.ts';
import type { RetireMarketPayload } from '../shared/action-contracts.ts';
import type { MarketRetirementAdmissionEvidence } from '../shared/market-retirement-admission.ts';
import { retireMarketAction, RetireMarketDomainErrorSchema } from '../src/actions/retire-market.action.ts';
import { MarketRetirementPostAttempt } from '../src/services/market-retirement-post-attempt.ts';
import { manageMarketRetirementAdmissionAction } from '../src/actions/manage-market-retirement-admission.action.ts';
import { MarketRetirementImpactAssessmentStale } from '../src/actions/market-retirement-impact-assessment-stale.ts';
import type { MarketRetirementImpactAssessmentUnavailable } from '../src/actions/market-retirement-impact-assessment-unavailable.ts';
import { marketRetirementEffectRecoveryRead } from '../src/api/market-retirement-effect-recovery.read.ts';
import { MarketRetirementImpactAuthorityLive } from '../src/integrations/market-retirement-impact.ts';
import { MarketRetirementImpactAuthorityFactory } from '../src/services/market-retirement-impact-authority.ts';
import {
  PreparedMarketRetirementImpact,
  PreparedMarketRetirementImpactLive,
} from '../src/services/market-retirement-admission.service.ts';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import {
  ActionRepositoryLive,
  ActionPermissionLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Ref, Context, Crypto, Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { commerceMarketCatalogApi, commerceMarketCatalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import { commerceMarketCatalogRegistration } from '../vertical.registration.ts';
import { ActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { retirementUnavailable, retirementPreflightUnavailable } from './market-retirement-runtime.ts';
import {
  GatewayAssertionRedemptionLive,
  GatewayAssertionRedemptionDatabaseLive,
} from './auth/gateway-assertion-redemption.ts';
// <generated-governed-http-handler-imports>
import { activateMarketActionApiLive } from './activate-market-action-server.ts';
import { associateStorefrontActionApiLive } from './associate-storefront-action-server.ts';
import { createMarketActionApiLive } from './create-market-action-server.ts';
import { currentMarketCatalogReadApiLive } from './current-market-catalog-read-server.ts';
import { eligibleMarketTuplesReadApiLive } from './eligible-market-tuples-read-server.ts';
import { marketHistoryReadApiLive } from './market-history-read-server.ts';
import { marketRetirementEffectRecoveryReadApiLive } from './market-retirement-effect-recovery-read-server.ts';
import { pricingCurrentMarketEvidenceReadApiLive } from './pricing-current-market-evidence-read-server.ts';
import { removeStorefrontAssociationActionApiLive } from './remove-storefront-association-action-server.ts';
import { resolveCommerceMarketReadApiLive } from './resolve-commerce-market-read-server.ts';
import { retireMarketActionApiLive } from './retire-market-action-server.ts';
import { reviseMarketDefinitionActionApiLive } from './revise-market-definition-action-server.ts';
import { reviseStorefrontAssociationActionApiLive } from './revise-storefront-association-action-server.ts';
import { suspendMarketActionApiLive } from './suspend-market-action-server.ts';
import { verifyMarketEligibilityV1ReadApiLive } from './verify-market-eligibility-v1-read-server.ts';
// </generated-governed-http-handler-imports>
import {
  commerceMarketCatalogCorsAllowedHeaders,
  commerceMarketCatalogCorsAllowedMethods,
  commerceMarketCatalogCorsAllowedOrigins,
  resolveCommerceMarketCatalogShellOrigin,
} from './runtime-support.ts';

const commerceMarketCatalogReadinessLayer = HttpApiBuilder.group(commerceMarketCatalogApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.commerceMarketCatalog.readiness', {
        attributes: microVerticalOperationAttributes(commerceMarketCatalogOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  const configuredShellOrigin = (() => {
    try {
      return ULTRAMODERN_SHELL_ORIGIN;
    } catch {
      return null;
    }
  })();
  return resolveCommerceMarketCatalogShellOrigin(
    Schema.is(Schema.String)(configuredShellOrigin) ? configuredShellOrigin : undefined,
  );
};

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
const nativeCompositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(
  Layer.provide(
    FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
    ),
  ),
);
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(nativeCompositionSourceLive),
);
type CommerceMarketCatalogActionRuntimeDependencyLayers =
  | typeof CorePersistenceLive
  | typeof ContextAccessLive
  | typeof ActionRepositoryLive
  | typeof ActionPermissionLive
  | typeof ModuleStateGateLive
  | typeof ModuleEntrypointGatewayLive
  | typeof OperationalScopeResolverLive
  | typeof ActiveApplicationCompositionConfigLive;

export const commerceMarketCatalogActionRuntimeDependenciesLive: Layer.Layer<
  Layer.Success<CommerceMarketCatalogActionRuntimeDependencyLayers>,
  Layer.Error<
    | CommerceMarketCatalogActionRuntimeDependencyLayers
    | typeof TenantModuleStateServiceLive
    | typeof ActiveApplicationCompositionSourceLive
  >,
  Layer.Services<typeof CorePersistenceLive> | Crypto.Crypto
> = Layer.mergeAll(
  CorePersistenceLive,
  ContextAccessLive,
  ActionRepositoryLive,
  ActionPermissionLive,
  moduleStateGateLive,
  moduleEntrypointGatewayLive,
  operationalScopeResolverLive,
  activeApplicationCompositionLive,
);
const actionRuntimeDependenciesLive = commerceMarketCatalogActionRuntimeDependenciesLive.pipe(
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
);
const baseProductionActionRuntimeLive = makeActionRuntimeLive(
  ultramodernDeliveryUnit,
  commerceMarketCatalogRegistration,
).pipe(Layer.provide(actionRuntimeDependenciesLive));
const productionReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, commerceMarketCatalogRegistration).pipe(
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ContextAccessLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
      activeApplicationCompositionLive,
    ),
  ),
  Layer.provide(Layer.mergeAll(DatabaseConfigLive, nodeCryptoLayer)),
);

const MARKET_RUNTIME_AUDIENCE = 'commerce-market-catalog' as const;
interface MarketRetirementRuntimeBindingServices {
  readonly base: ActionRuntimeService;
  readonly coreFactory: Layer.Layer<
    ActionRuntime,
    MarketRetirementImpactAssessmentUnavailable,
    ActionAuthorizationPreflight
  >;
  readonly crypto: Crypto.Crypto;
  readonly readRuntime: ReadRuntimeService;
  readonly scopeResolver: OperationalScopeResolverService;
}
export class MarketRetirementRuntimeBindings extends Context.Service<
  MarketRetirementRuntimeBindings,
  MarketRetirementRuntimeBindingServices
>()('@app/commerce-market-catalog/api/MarketRetirementRuntimeBindings') {}
interface RetirementInvocationState {
  readonly admission?: MarketRetirementAdmissionEvidence;
  readonly admitted?: ActionAuthorizationPreflightInput;
  readonly ownerFailure?: typeof retireMarketAction.descriptor.domainErrorSchema.Type | ActionCoreError;
  readonly prepared?: Effect.Success<(typeof PreparedMarketRetirementImpact.Service)['take']>;
}
const captureRetirementFailure = (
  state: Ref.Ref<RetirementInvocationState>,
  ownerFailure: NonNullable<RetirementInvocationState['ownerFailure']>,
) =>
  Ref.update(state, (current) => ({ ...current, ownerFailure })).pipe(
    Effect.andThen(Effect.fail(retirementPreflightUnavailable())),
  );

const retirementFailureDecoder =
  <Declared extends Schema.ConstraintDecoder<{ readonly _tag: string }>>(declared: Declared) =>
  (cause: unknown): Effect.Effect<never, ActionCoreError | Declared['Type']> => {
    if (Schema.is(ActionCoreErrorSchema)(cause)) {
      return Effect.fail(cause);
    }
    return Schema.decodeUnknownEffect(declared)(cause).pipe(
      Effect.mapError((decodeCause) =>
        Object.defineProperty(
          new ActionHandlerExecutionError({
            code: 'action_handler_execution_failed',
            reason: 'The owner retirement failure is not declared',
          }),
          'cause',
          { value: { cause, decodeCause } },
        ),
      ),
      Effect.flatMap((failure) => {
        Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
        return Effect.fail(failure);
      }),
    );
  };

/** Native request binding: every collaborator comes from the real process Layer graph. */
export const MarketRetirementActionRuntimeLive = Layer.effect(
  ActionRuntime,
  Effect.gen(function* retirementRuntimeLive() {
    const { base, coreFactory, crypto, readRuntime, scopeResolver } = yield* MarketRetirementRuntimeBindings;
    const authorityFactory = yield* MarketRetirementImpactAuthorityFactory;
    const recover = Effect.fn('MarketRetirement.recover')(function* recover(
      source: ActionAuthorizationPreflightInput,
      payload: RetireMarketPayload,
    ) {
      return yield* readRuntime
        .runRead({
          audience: MARKET_RUNTIME_AUDIENCE,
          input: { marketRef: payload.marketRef, sourceActionInvocationId: source.actionInvocationId },
          principal: source.principal,
          registration: marketRetirementEffectRecoveryRead,
          transport: { correlationId: source.correlationId },
        })
        .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.mapError(retirementUnavailable));
    });
    const manage = Effect.fn('MarketRetirement.manage')(function* manage(
      source: ActionAuthorizationPreflightInput,
      payload: RetireMarketPayload,
      operation: 'PREPARE' | 'ABORT',
    ) {
      const retirement = yield* Schema.encodeEffect(RetireMarketPayloadSchema)(payload).pipe(
        Effect.mapError(retirementUnavailable),
      );
      return yield* base
        .runAction({
          audience: MARKET_RUNTIME_AUDIENCE,
          payload: { operation, retirement, sourceActionInvocationId: source.actionInvocationId },
          principal: source.principal,
          registration: manageMarketRetirementAdmissionAction,
          transport: {
            correlationId: source.correlationId,
            idempotencyKey: `${source.actionInvocationId}:admission:${operation.toLowerCase()}`,
          },
        })
        .pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(MarketRetirementImpactAuthorityFactory, authorityFactory),
          Effect.catchTag('ActionAlreadyCommitted', () =>
            recover(source, payload).pipe(
              Effect.flatMap((receipt) =>
                receipt.outcome === 'NOT_FOUND' ? Effect.fail(retirementUnavailable()) : Effect.succeed(receipt),
              ),
            ),
          ),
        );
    });
    const authorityFor = (
      source: ActionAuthorizationPreflightInput,
      receipt: MarketRetirementAdmissionEvidence,
      payload: RetireMarketPayload,
    ) =>
      authorityFactory.forAdmission({
        basis: receipt.basis,
        compositionRevision: readVerifiedGatewayCompositionRevision(source.scope) ?? '',
        originalCompositionRevision: receipt.compositionRevision,
        releaseGuardHash: receipt.releaseGuardHash,
        retirement: payload,
        scope: source.scope,
        sourceActionInvocationId: source.actionInvocationId,
      });
    const consumeRetirement = Effect.fn('MarketRetirement.consume')(function* consumeRetirement(
      state: Ref.Ref<RetirementInvocationState>,
      payload: RetireMarketPayload,
      source: ActionAuthorizationPreflightInput,
    ) {
      if (retireMarketAction.descriptor.policies.length !== 0) {
        return yield* retirementUnavailable();
      }
      yield* Ref.update(state, (current) => ({ ...current, admitted: source }));
      const retirement = yield* Schema.encodeEffect(RetireMarketPayloadSchema)(payload).pipe(
        Effect.mapError(retirementUnavailable),
      );
      const admission = yield* manage(source, payload, 'PREPARE');
      yield* Ref.update(state, (current) => ({ ...current, admission }));
      if (admission.outcome === 'ABORTED') {
        return yield* new MarketCommandRejected({
          code: 'invalid_lifecycle_transition',
          reason: 'The original retirement admission is irrevocably ABORTED',
        });
      }
      if (admission.outcome !== 'PENDING' || source.scope.legalEntityId === undefined) {
        return yield* retirementUnavailable();
      }
      if (admission.compositionRevision !== readVerifiedGatewayCompositionRevision(source.scope)) {
        return yield* new MarketRetirementImpactAssessmentStale({
          code: 'market_retirement_impact_assessment_stale',
          reason: 'The original admission belongs to a different Composition revision',
        });
      }
      const assessment = yield* authorityFor(source, admission, payload).reserveRetirementImpact({
        actionInvocationId: source.actionInvocationId,
        compositionRevision: admission.compositionRevision,
        effectiveAt: retirement.effectiveAt,
        expectedMarketRevision: payload.expectedRevision,
        legalEntityId: source.scope.legalEntityId,
        marketRef: payload.marketRef,
        reason: payload.reason,
      });
      return yield* Ref.update(state, (current) => ({
        ...current,
        prepared: { actionInvocationId: source.actionInvocationId, assessment },
      }));
    });
    const prepareSource = (
      state: Ref.Ref<RetirementInvocationState>,
      payload: RetireMarketPayload,
    ): ActionAuthorizationPreflightService => ({
      prepare: (source) => {
        if (source.actionKey !== retireMarketAction.descriptor.actionKey) {
          return Effect.succeed({ outcome: 'not_applicable' as const });
        }
        const permit = makeActionAuthorizationPreflightPermit({
          actionInvocationId: source.actionInvocationId,
          actionKey: source.actionKey,
          principalId: source.scope.principalId,
        });
        const consume = permit.consume.pipe(
          Effect.andThen(consumeRetirement(state, payload, source)),
          Effect.matchEffect({
            onFailure: (error) => captureRetirementFailure(state, error),
            onSuccess: Effect.succeed,
          }),
        );
        return Effect.succeed({ outcome: 'allowed' as const, permit: { ...permit, consume } });
      },
    });
    const resolveOriginalSource = Effect.fn('MarketRetirement.resolveOriginalSource')(function* resolveOriginalSource(
      input: Pick<Parameters<ActionRuntimeService['runAction']>[0], 'principal' | 'transport'>,
      invocationId: string,
      payload: RetireMarketPayload,
    ) {
      if (!Schema.is(TrustedPrincipalContextSchema)(input.principal)) {
        return yield* retirementUnavailable();
      }
      const transport = yield* Schema.decodeUnknownEffect(ActionTransportMetadataSchema)(input.transport).pipe(
        Effect.mapError(retirementUnavailable),
      );
      const scope = yield* scopeResolver
        .resolve({
          audience: MARKET_RUNTIME_AUDIENCE,
          correlationId: transport.correlationId,
          legalEntityScope: 'required',
          principal: input.principal,
        })
        .pipe(Effect.mapError(retirementUnavailable));
      const source: ActionAuthorizationPreflightInput = {
        actionInvocationId: invocationId,
        actionKey: retireMarketAction.descriptor.actionKey,
        correlationId: scope.correlationId,
        payload,
        principal: input.principal,
        scope,
      };
      return source;
    });
    const runtime: ActionRuntimeService = {
      resolveActionCommit: base.resolveActionCommit,
      runAction: (input) => {
        if (input.registration.descriptor.actionKey !== retireMarketAction.descriptor.actionKey) {
          return base.runAction(input);
        }
        const declaredErrors = Schema.make<
          Schema.ConstraintDecoder<typeof input.registration.descriptor.domainErrorSchema.Type>
        >(input.registration.descriptor.domainErrorSchema.ast);
        const decodeFailure = retirementFailureDecoder(declaredErrors);
        const decodeRetirementFailure = retirementFailureDecoder(RetireMarketDomainErrorSchema);
        return Effect.scoped(
          Effect.gen(function* runRetirement() {
            const payload = yield* Schema.decodeUnknownEffect(RetireMarketPayloadSchema)(input.payload).pipe(
              Effect.mapError((cause) => {
                const failure = new ActionPayloadValidationError({
                  code: 'action_payload_invalid',
                  reason: 'The retirement payload is invalid',
                });
                Object.defineProperty(failure, 'cause', { value: cause });
                return failure;
              }),
            );
            if (!Object.is(input.registration, retireMarketAction)) {
              return yield* retirementUnavailable();
            }
            const state = yield* Ref.make<RetirementInvocationState>({});
            const preflight = prepareSource(state, payload);
            const context = yield* Layer.build(
              coreFactory.pipe(Layer.provide(Layer.succeed(ActionAuthorizationPreflight, preflight))),
            );
            const requestRuntime = Context.get(context, ActionRuntime);
            const take = Ref.get(state).pipe(
              Effect.flatMap((current) =>
                current.prepared === undefined
                  ? Effect.fail(retirementUnavailable())
                  : Effect.succeed(current.prepared),
              ),
            );
            const preparedContext = yield* Layer.build(PreparedMarketRetirementImpactLive(take));
            const preparedService = Context.get(preparedContext, PreparedMarketRetirementImpact);
            const settlement: typeof MarketRetirementPostAttempt.Service = {
              abort: (source, retirement) => manage(source, retirement, 'ABORT'),
              authorityFor,
              decodeFailure: decodeRetirementFailure,
              readState: Ref.get(state),
              recover,
              resolveOriginalSource: (invocationId, retirement) =>
                resolveOriginalSource(input, invocationId, retirement),
              unavailable: retirementUnavailable,
            };
            return yield* requestRuntime
              .runAction(input)
              .pipe(
                Effect.provideService(PreparedMarketRetirementImpact, preparedService),
                Effect.provideService(MarketRetirementPostAttempt, settlement),
              );
          }),
        ).pipe(Effect.matchEffect({ onFailure: decodeFailure, onSuccess: Effect.succeed }));
      },
    };
    return runtime;
  }),
);
const nativeRetirementBindingsLive = Layer.effect(
  MarketRetirementRuntimeBindings,
  Effect.gen(function* nativeRetirementBindings() {
    const base = yield* ActionRuntime;
    const readRuntime = yield* ReadRuntime;
    const crypto = yield* Crypto.Crypto;
    const scopeResolver = yield* OperationalScopeResolver;
    const dependencies = yield* Effect.context<Layer.Success<typeof actionRuntimeDependenciesLive>>();
    return {
      base,
      coreFactory: makeActionRuntimeLive(ultramodernDeliveryUnit, commerceMarketCatalogRegistration).pipe(
        Layer.provide(Layer.succeedContext(dependencies)),
      ),
      crypto,
      readRuntime,
      scopeResolver,
    };
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      baseProductionActionRuntimeLive,
      productionReadRuntimeLive,
      actionRuntimeDependenciesLive,
      nodeCryptoLayer,
    ),
  ),
);
const productionActionRuntimeLive = MarketRetirementActionRuntimeLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      nativeRetirementBindingsLive,
      MarketRetirementImpactAuthorityLive.pipe(Layer.provide(nodeCryptoLayer)),
    ),
  ),
);

const productionGatewayAssertionRedemptionLive = GatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type CommerceMarketCatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof productionReadRuntimeLive>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof productionActionRuntimeLive>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
];

export const makeCommerceMarketCatalogApiRuntime = (
  ...args: CommerceMarketCatalogApiRuntimeArguments
): EffectBffDefinition<typeof commerceMarketCatalogApi> & EffectBffRuntime<typeof commerceMarketCatalogApi> => {
  const [governedReadRuntimeLive, governedActionRuntimeLive, gatewayAssertionRedemption] = args;
  const actionPrincipalVerifierLive = ActionPrincipalVerifierLive.pipe(Layer.provide(governedActionRuntimeLive));
  const apiHandlersLive = Layer.mergeAll(
    commerceMarketCatalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    activateMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    associateStorefrontActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    currentMarketCatalogReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    eligibleMarketTuplesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    marketRetirementEffectRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    pricingCurrentMarketEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeStorefrontAssociationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    resolveCommerceMarketReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseMarketDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseStorefrontAssociationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    suspendMarketActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    verifyMarketEligibilityV1ReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  const resolvedApiHandlersLive = apiHandlersLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtimeObservabilityLive,
        nodeCryptoLayer,
        RequestSchemaProblemLive,
        ActiveApplicationCompositionSourceLive.pipe(
          Layer.provide(
            FetchHttpClient.layer.pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
            ),
          ),
        ),
      ),
    ),
    Layer.orDie,
  );
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...commerceMarketCatalogCorsAllowedHeaders],
    allowedMethods: [...commerceMarketCatalogCorsAllowedMethods],
    allowedOrigins: commerceMarketCatalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: commerceMarketCatalogApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

/** Assemble this owner's unchanged HTTP runtime from caller-owned scoped services. */
export const commerceMarketCatalogApiRuntimeFromContext = Effect.gen(
  function* commerceMarketCatalogApiRuntimeFromContext() {
    const readRuntime = yield* ReadRuntime;
    const actionRuntime = yield* ActionRuntime;
    const redemption = yield* GatewayAssertionRedemptionService;
    return makeCommerceMarketCatalogApiRuntime(
      Layer.succeed(ReadRuntime, readRuntime),
      Layer.succeed(ActionRuntime, actionRuntime),
      Layer.succeed(GatewayAssertionRedemptionService, redemption),
    );
  },
);

const apiRuntime = makeCommerceMarketCatalogApiRuntime(
  productionReadRuntimeLive,
  productionActionRuntimeLive,
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;
