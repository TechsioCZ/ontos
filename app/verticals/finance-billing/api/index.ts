import {
  OwnerActionApprovalSchemaErrorLive,
  makeOwnerActionApproveHandler,
  makeOwnerActionInspectHandler,
} from '@app/core-runtime/access/approvals/owner-http';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import { financeBillingBackendRegistration } from '../vertical.runtime-declaration.ts';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { Reactivity } from 'effect/reactivity';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, Layer } from '@modern-js/bff-effect/effect-edge';

import { financeBillingApi } from '../shared/api.ts';

import {
  CoreSearchQueryRuntimeLive,
  CoreSearchProjectionStoreLive,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeActionRuntimeLive,
  ContextAccessLive as GovernedContextAccessLive,
  CorePersistenceLive as GovernedCorePersistenceLive,
  DatabaseConfigLive as GovernedDatabaseConfigLive,
  makeReadRuntimeLive,
  TenantModuleStateServiceLive as GovernedTenantModuleStateServiceLive,
} from '@app/core-runtime';
import {
  AccessDecisionLive,
  AccessEnforcementPortsLive,
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive as GovernedModuleEntrypointGatewayLive,
  ModuleStateGateLive as GovernedModuleStateGateLive,
  OperationalScopeResolverLive as GovernedOperationalScopeResolverLive,
  TenantIntentLoaderLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ultramodernDeliveryUnit, ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import { ActiveApplicationCompositionSourceLive as GovernedApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { Layer as GovernedReadLayer, Logger, References, Tracer } from 'effect';
import { FetchHttpClient as GovernedFetchHttpClient } from 'effect/http';
// The redemption binding itself arrives through the generated support-import slot below; only the
// finance-specific client comes from the owner service module, so this file imports that module once.
import { FinanceRedemptionClientLive } from '../src/services/gateway-redemption.ts';
import { FinanceTaxRatesLive } from '../src/integrations/tax-rates.ts';
// <generated-governed-http-handler-support-imports>
import {
  ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive,
  authenticateOperationPrincipal as authenticateOwnerApprovalPrincipal,
} from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { applyCommandActionApiLive } from './apply-command-action-server.ts';
import { documentsReadApiLive } from './documents-search-server.ts';
import { invoicesReadApiLive } from './invoices-search-server.ts';
import { leaseInvoicesReadApiLive } from './lease-invoices-read-server.ts';
import { recordsReadApiLive } from './records-read-server.ts';
import { requestSearchRebuildActionApiLive } from './request-search-rebuild-action-server.ts';
import { vatChoicesReadApiLive } from './vat-choices-read-server.ts';
// </generated-governed-http-handler-imports>

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const governedCompositionHttpClientLive = GovernedFetchHttpClient.layer.pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.succeed(GovernedFetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' }),
  ),
);
const governedApplicationCompositionSourceLive = GovernedApplicationCompositionSourceLive.pipe(
  GovernedReadLayer.provide(governedCompositionHttpClientLive),
);
const governedActiveApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
);

const governedTenantModuleStateServiceLive = GovernedTenantModuleStateServiceLive.pipe(
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
);
const governedModuleStateGateLive = GovernedModuleStateGateLive.pipe(
  GovernedReadLayer.provide(governedTenantModuleStateServiceLive),
);
const governedAccessEnforcementLive = AccessDecisionLive.pipe(
  GovernedReadLayer.provideMerge(AccessEnforcementPortsLive),
  GovernedReadLayer.provide(TenantIntentLoaderLive),
  GovernedReadLayer.provide(GovernedCorePersistenceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
);
const governedReadRuntimeDependenciesLive = GovernedReadLayer.mergeAll(
  GovernedCorePersistenceLive,
  GovernedContextAccessLive,
  GovernedModuleEntrypointGatewayLive.pipe(GovernedReadLayer.provide(governedModuleStateGateLive)),
  GovernedOperationalScopeResolverLive.pipe(
    GovernedReadLayer.provide(
      GovernedReadLayer.mergeAll(GovernedCorePersistenceLive, GovernedContextAccessLive, governedAccessEnforcementLive),
    ),
  ),
  governedAccessEnforcementLive,
);
const governedReadRuntimeLive = makeReadRuntimeLive(ultramodernDeliveryUnit, financeBillingBackendRegistration).pipe(
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(governedActiveApplicationCompositionLive),
);

const ownerActionApprovalsLive = makeOwnerActionApprovalsLive(
  ultramodernDeliveryUnit,
  financeBillingBackendRegistration,
).pipe(
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

const governedActionRuntimeLive = makeActionRuntimeLive(
  ultramodernDeliveryUnit,
  financeBillingBackendRegistration,
).pipe(
  GovernedReadLayer.provideMerge(ownerActionApprovalsLive),
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      governedReadRuntimeDependenciesLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      governedModuleStateGateLive,
      governedActiveApplicationCompositionLive,
    ),
  ),
);

export const governedReadApiHandlersLive = GovernedReadLayer.mergeAll(
  HttpApiBuilder.group(financeBillingApi, 'ownerActionApprovals', (handlers) =>
    handlers
      .handle('approve', makeOwnerActionApproveHandler(authenticateOwnerApprovalPrincipal))
      .handle('inspect', makeOwnerActionInspectHandler(authenticateOwnerApprovalPrincipal)),
  ).pipe(
    GovernedReadLayer.provide(OwnerActionApprovalSchemaErrorLive),
    GovernedReadLayer.provide(governedActionRuntimeLive),
  ),
  // <generated-governed-http-handler-layers>
  applyCommandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  documentsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  invoicesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  leaseInvoicesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  recordsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  requestSearchRebuildActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
  vatChoicesReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
  // </generated-governed-http-handler-layers>
).pipe(
  GovernedReadLayer.provide(CoreSearchQueryRuntimeLive.pipe(GovernedReadLayer.provide(CoreSearchProjectionStoreLive))),
  // <generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      GovernedActionPrincipalVerifierLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
      GovernedGatewayAssertionRedemptionLive,
    ),
  ),
  // </generated-governed-http-handler-support-layers>
  GovernedReadLayer.provide(FinanceRedemptionClientLive.pipe(GovernedReadLayer.provide(Reactivity.layer))),
  // Invoice VAT choices and their command checks read Tax as Finance, for the admitted person.
  GovernedReadLayer.provide(FinanceTaxRatesLive),
  // The apply command validates its references through the governed Read runtime.
  GovernedReadLayer.provide(GovernedReadLayer.mergeAll(ActionPermissionLive, governedReadRuntimeLive)),
  GovernedReadLayer.provide(governedReadRuntimeDependenciesLive),
);

const financeBillingReadinessLayer = HttpApiBuilder.group(financeBillingApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.financeBilling.readiness', {
        attributes: { 'modernjs.operation.id': 'FinanceBillingApi:foundation:readiness' },
        kind: 'server',
      }),
    ),
  ),
);

const apiHandlersLive = Layer.mergeAll(financeBillingReadinessLayer);
const governedResolvedApiHandlersLive = GovernedReadLayer.mergeAll(apiHandlersLive, governedReadApiHandlersLive).pipe(
  GovernedReadLayer.provide(governedApplicationCompositionSourceLive),
  GovernedReadLayer.provide(GovernedDatabaseConfigLive),
  GovernedReadLayer.provide(databaseIdentitiesLive),
  GovernedReadLayer.provide(nodeCryptoLayer),
  GovernedReadLayer.provide(
    GovernedReadLayer.mergeAll(
      Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
      GovernedReadLayer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
      GovernedReadLayer.succeed(References.MinimumLogLevel, 'Info'),
    ),
  ),
  GovernedReadLayer.orDie,
);

export const makeFinanceBillingApiRuntime = () =>
  assembleEffectBffRuntime({
    api: financeBillingApi,
    handlers: governedResolvedApiHandlersLive,
  });
const apiRuntime = makeFinanceBillingApiRuntime();

export default apiRuntime;
