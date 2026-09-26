import {
  ActionRuntimeLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
} from '@app/core-runtime';
import type { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import {
  ActionPermissionLive,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import type { EffectBffRuntimeAssembly } from '@modern-js/bff-effect/assembly';
import { Effect, HttpApiBuilder, HttpRouter, Layer } from '@modern-js/bff-effect/effect-edge';
import type { EffectBffDefinition, EffectBffRuntime } from '@modern-js/bff-effect/effect-edge';
import { Layer as GovernedReadLayer, Logger, References, Schema, Tracer } from 'effect';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { catalogImportAcceptanceServiceFactoryLive } from '../src/persistence/catalog-import-acceptance-service.ts';
import { catalogLocalOverrideServiceFactoryLive } from '../src/persistence/catalog-local-override-service.ts';
import { catalogSourceActionPersistenceFactoryLive } from '../src/persistence/catalog-source-action-persistence.ts';
import { catalogExternalCorrelationResolverLive } from '../src/persistence/external-correlation-resolver.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import { GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive } from './auth/gateway-assertion-redemption.ts';
// </generated-governed-http-handler-support-imports>

// <generated-governed-http-handler-imports>
import { activateLocalOverrideActionApiLive } from './activate-local-override-action-server.ts';
import { activateLocalOverrideRecoveryReadApiLive } from './activate-local-override-recovery-read-server.ts';
import { activatePackageDefinitionActionApiLive } from './activate-package-definition-action-server.ts';
import { activatePackageDefinitionRecoveryReadApiLive } from './activate-package-definition-recovery-read-server.ts';
import { activatePackageOptionActionApiLive } from './activate-package-option-action-server.ts';
import { activatePackageOptionRecoveryReadApiLive } from './activate-package-option-recovery-read-server.ts';
import { addProductCategoryAssignmentActionApiLive } from './add-product-category-assignment-action-server.ts';
import { addProductCategoryAssignmentRecoveryReadApiLive } from './add-product-category-assignment-recovery-read-server.ts';
import { assertSizeEquivalenceActionApiLive } from './assert-size-equivalence-action-server.ts';
import { assertSizeEquivalenceRecoveryReadApiLive } from './assert-size-equivalence-recovery-read-server.ts';
import { assignCatalogMediaActionApiLive } from './assign-catalog-media-action-server.ts';
import { assignCatalogMediaRecoveryReadApiLive } from './assign-catalog-media-recovery-read-server.ts';
import { assignSkuActionApiLive } from './assign-sku-action-server.ts';
import { assignSkuRecoveryReadApiLive } from './assign-sku-recovery-read-server.ts';
import { brandCurrentReadApiLive } from './brand-current-read-server.ts';
import { brandHistoryReadApiLive } from './brand-history-read-server.ts';
import { catalogDocumentCurrentReadApiLive } from './catalog-document-current-read-server.ts';
import { catalogMediaCurrentReadApiLive } from './catalog-media-current-read-server.ts';
import { catalogSourceResolutionReadApiLive } from './catalog-source-resolution-read-server.ts';
import { changeLocalOverrideActionApiLive } from './change-local-override-action-server.ts';
import { changeLocalOverrideRecoveryReadApiLive } from './change-local-override-recovery-read-server.ts';
import { changeProductManufacturerActionApiLive } from './change-product-manufacturer-action-server.ts';
import { changeProductManufacturerRecoveryReadApiLive } from './change-product-manufacturer-recovery-read-server.ts';
import { changeProductRelationshipActionApiLive } from './change-product-relationship-action-server.ts';
import { changeProductRelationshipRecoveryReadApiLive } from './change-product-relationship-recovery-read-server.ts';
import { changeVariantActionApiLive } from './change-variant-action-server.ts';
import { changeVariantRecoveryReadApiLive } from './change-variant-recovery-read-server.ts';
import { colorCurrentReadApiLive } from './color-current-read-server.ts';
import { colorHistoryReadApiLive } from './color-history-read-server.ts';
import { confirmGtinActionApiLive } from './confirm-gtin-action-server.ts';
import { confirmGtinRecoveryReadApiLive } from './confirm-gtin-recovery-read-server.ts';
import { confirmVariantCombinationActionApiLive } from './confirm-variant-combination-action-server.ts';
import { confirmVariantCombinationRecoveryReadApiLive } from './confirm-variant-combination-recovery-read-server.ts';
import { correctGtinActionApiLive } from './correct-gtin-action-server.ts';
import { correctGtinRecoveryReadApiLive } from './correct-gtin-recovery-read-server.ts';
import { correctProductActionApiLive } from './correct-product-action-server.ts';
import { correctProductRecoveryReadApiLive } from './correct-product-recovery-read-server.ts';
import { correctSkuActionApiLive } from './correct-sku-action-server.ts';
import { correctSkuRecoveryReadApiLive } from './correct-sku-recovery-read-server.ts';
import { createAttributeDefinitionActionApiLive } from './create-attribute-definition-action-server.ts';
import { createAttributeDefinitionRecoveryReadApiLive } from './create-attribute-definition-recovery-read-server.ts';
import { createBrandActionApiLive } from './create-brand-action-server.ts';
import { createBrandRecoveryReadApiLive } from './create-brand-recovery-read-server.ts';
import { createConfigurationUnitActionApiLive } from './create-configuration-unit-action-server.ts';
import { createConfigurationUnitRecoveryReadApiLive } from './create-configuration-unit-recovery-read-server.ts';
import { createControlledAttributeValueActionApiLive } from './create-controlled-attribute-value-action-server.ts';
import { createControlledAttributeValueRecoveryReadApiLive } from './create-controlled-attribute-value-recovery-read-server.ts';
import { createPackageDefinitionActionApiLive } from './create-package-definition-action-server.ts';
import { createPackageDefinitionRecoveryReadApiLive } from './create-package-definition-recovery-read-server.ts';
import { createProductActionApiLive } from './create-product-action-server.ts';
import { createProductCategoryActionApiLive } from './create-product-category-action-server.ts';
import { createProductCategoryRecoveryReadApiLive } from './create-product-category-recovery-read-server.ts';
import { createProductRecoveryReadApiLive } from './create-product-recovery-read-server.ts';
import { createProductRelationshipActionApiLive } from './create-product-relationship-action-server.ts';
import { createProductRelationshipRecoveryReadApiLive } from './create-product-relationship-recovery-read-server.ts';
import { createProductTypeActionApiLive } from './create-product-type-action-server.ts';
import { createProductTypeRecoveryReadApiLive } from './create-product-type-recovery-read-server.ts';
import { createProductUnitActionApiLive } from './create-product-unit-action-server.ts';
import { createProductUnitRecoveryReadApiLive } from './create-product-unit-recovery-read-server.ts';
import { createSetCompositionActionApiLive } from './create-set-composition-action-server.ts';
import { createSetCompositionRecoveryReadApiLive } from './create-set-composition-recovery-read-server.ts';
import { createVariantActionApiLive } from './create-variant-action-server.ts';
import { createVariantRecoveryReadApiLive } from './create-variant-recovery-read-server.ts';
import { decideProductTypeUnnecessaryActionApiLive } from './decide-product-type-unnecessary-action-server.ts';
import { decideProductTypeUnnecessaryRecoveryReadApiLive } from './decide-product-type-unnecessary-recovery-read-server.ts';
import { effectiveAttributeValuesCurrentReadApiLive } from './effective-attribute-values-current-read-server.ts';
import { externalTargetResolutionReadApiLive } from './external-target-resolution-read-server.ts';
import { governProductAttributeApplicabilityActionApiLive } from './govern-product-attribute-applicability-action-server.ts';
import { governProductAttributeApplicabilityRecoveryReadApiLive } from './govern-product-attribute-applicability-recovery-read-server.ts';
import { governVariantAllowedValuesActionApiLive } from './govern-variant-allowed-values-action-server.ts';
import { governVariantAllowedValuesRecoveryReadApiLive } from './govern-variant-allowed-values-recovery-read-server.ts';
import { governVariantAxesActionApiLive } from './govern-variant-axes-action-server.ts';
import { governVariantAxesRecoveryReadApiLive } from './govern-variant-axes-recovery-read-server.ts';
import { gtinCurrentReadApiLive } from './gtin-current-read-server.ts';
import { gtinHistoryReadApiLive } from './gtin-history-read-server.ts';
import { importSourceAssertionActionApiLive } from './import-source-assertion-action-server.ts';
import { importSourceAssertionRecoveryReadApiLive } from './import-source-assertion-recovery-read-server.ts';
import { listRecordedVariantsReadApiLive } from './list-recorded-variants-read-server.ts';
import { manufacturerRelationCurrentReadApiLive } from './manufacturer-relation-current-read-server.ts';
import { manufacturerRelationHistoryReadApiLive } from './manufacturer-relation-history-read-server.ts';
import { markGtinUnresolvedActionApiLive } from './mark-gtin-unresolved-action-server.ts';
import { markGtinUnresolvedRecoveryReadApiLive } from './mark-gtin-unresolved-recovery-read-server.ts';
import { moveProductCategoryActionApiLive } from './move-product-category-action-server.ts';
import { moveProductCategoryRecoveryReadApiLive } from './move-product-category-recovery-read-server.ts';
import { packageDefinitionHistoryReadApiLive } from './package-definition-history-read-server.ts';
import { packageOptionHistoryReadApiLive } from './package-option-history-read-server.ts';
import { productBrandCurrentReadApiLive } from './product-brand-current-read-server.ts';
import { productBrandHistoryReadApiLive } from './product-brand-history-read-server.ts';
import { productCategoryClassificationReadApiLive } from './product-category-classification-read-server.ts';
import { productCategoryHistoryReadApiLive } from './product-category-history-read-server.ts';
import { productDetailReadApiLive } from './product-detail-read-server.ts';
import { productHistoryReadApiLive } from './product-history-read-server.ts';
import { productRelationshipCurrentReadApiLive } from './product-relationship-current-read-server.ts';
import { productRelationshipHistoryReadApiLive } from './product-relationship-history-read-server.ts';
import { productSizeCurrentReadApiLive } from './product-size-current-read-server.ts';
import { promotePackageDefinitionActionApiLive } from './promote-package-definition-action-server.ts';
import { promotePackageDefinitionRecoveryReadApiLive } from './promote-package-definition-recovery-read-server.ts';
import { publishProductConfigurationActionApiLive } from './publish-product-configuration-action-server.ts';
import { publishProductConfigurationRecoveryReadApiLive } from './publish-product-configuration-recovery-read-server.ts';
import { quantityPreparationReadApiLive } from './quantity-preparation-read-server.ts';
import { reactivateBrandActionApiLive } from './reactivate-brand-action-server.ts';
import { reactivateBrandRecoveryReadApiLive } from './reactivate-brand-recovery-read-server.ts';
import { reactivateControlledAttributeValueActionApiLive } from './reactivate-controlled-attribute-value-action-server.ts';
import { reactivateControlledAttributeValueRecoveryReadApiLive } from './reactivate-controlled-attribute-value-recovery-read-server.ts';
import { reactivateProductActionApiLive } from './reactivate-product-action-server.ts';
import { reactivateProductRecoveryReadApiLive } from './reactivate-product-recovery-read-server.ts';
import { reactivateVariantActionApiLive } from './reactivate-variant-action-server.ts';
import { reactivateVariantRecoveryReadApiLive } from './reactivate-variant-recovery-read-server.ts';
import { releaseLocalOverrideActionApiLive } from './release-local-override-action-server.ts';
import { releaseLocalOverrideRecoveryReadApiLive } from './release-local-override-recovery-read-server.ts';
import { removeCatalogMediaActionApiLive } from './remove-catalog-media-action-server.ts';
import { removeCatalogMediaRecoveryReadApiLive } from './remove-catalog-media-recovery-read-server.ts';
import { removeProductAttributeValuesActionApiLive } from './remove-product-attribute-values-action-server.ts';
import { removeProductAttributeValuesRecoveryReadApiLive } from './remove-product-attribute-values-recovery-read-server.ts';
import { removeProductCategoryAssignmentActionApiLive } from './remove-product-category-assignment-action-server.ts';
import { removeProductCategoryAssignmentRecoveryReadApiLive } from './remove-product-category-assignment-recovery-read-server.ts';
import { removeProductLocalizedFactsActionApiLive } from './remove-product-localized-facts-action-server.ts';
import { removeProductLocalizedFactsRecoveryReadApiLive } from './remove-product-localized-facts-recovery-read-server.ts';
import { removeProductManufacturerActionApiLive } from './remove-product-manufacturer-action-server.ts';
import { removeProductManufacturerRecoveryReadApiLive } from './remove-product-manufacturer-recovery-read-server.ts';
import { removeProductRelationshipActionApiLive } from './remove-product-relationship-action-server.ts';
import { removeProductRelationshipRecoveryReadApiLive } from './remove-product-relationship-recovery-read-server.ts';
import { removeVariantAttributeOverrideActionApiLive } from './remove-variant-attribute-override-action-server.ts';
import { removeVariantAttributeOverrideRecoveryReadApiLive } from './remove-variant-attribute-override-recovery-read-server.ts';
import { removeVariantLocalizedFactsActionApiLive } from './remove-variant-localized-facts-action-server.ts';
import { removeVariantLocalizedFactsRecoveryReadApiLive } from './remove-variant-localized-facts-recovery-read-server.ts';
import { renameAttributeDefinitionActionApiLive } from './rename-attribute-definition-action-server.ts';
import { renameAttributeDefinitionRecoveryReadApiLive } from './rename-attribute-definition-recovery-read-server.ts';
import { renameBrandActionApiLive } from './rename-brand-action-server.ts';
import { renameBrandRecoveryReadApiLive } from './rename-brand-recovery-read-server.ts';
import { renameControlledAttributeValueActionApiLive } from './rename-controlled-attribute-value-action-server.ts';
import { renameControlledAttributeValueRecoveryReadApiLive } from './rename-controlled-attribute-value-recovery-read-server.ts';
import { renameProductCategoryActionApiLive } from './rename-product-category-action-server.ts';
import { renameProductCategoryRecoveryReadApiLive } from './rename-product-category-recovery-read-server.ts';
import { renameSkuActionApiLive } from './rename-sku-action-server.ts';
import { renameSkuRecoveryReadApiLive } from './rename-sku-recovery-read-server.ts';
import { reorderCatalogMediaActionApiLive } from './reorder-catalog-media-action-server.ts';
import { reorderCatalogMediaRecoveryReadApiLive } from './reorder-catalog-media-recovery-read-server.ts';
import { replaceProductSizesActionApiLive } from './replace-product-sizes-action-server.ts';
import { replaceProductSizesRecoveryReadApiLive } from './replace-product-sizes-recovery-read-server.ts';
import { retireBrandActionApiLive } from './retire-brand-action-server.ts';
import { retireBrandRecoveryReadApiLive } from './retire-brand-recovery-read-server.ts';
import { retireConfigurationUnitActionApiLive } from './retire-configuration-unit-action-server.ts';
import { retireConfigurationUnitRecoveryReadApiLive } from './retire-configuration-unit-recovery-read-server.ts';
import { retireControlledAttributeValueActionApiLive } from './retire-controlled-attribute-value-action-server.ts';
import { retireControlledAttributeValueRecoveryReadApiLive } from './retire-controlled-attribute-value-recovery-read-server.ts';
import { retireGtinActionApiLive } from './retire-gtin-action-server.ts';
import { retireGtinRecoveryReadApiLive } from './retire-gtin-recovery-read-server.ts';
import { retirePackageDefinitionActionApiLive } from './retire-package-definition-action-server.ts';
import { retirePackageDefinitionRecoveryReadApiLive } from './retire-package-definition-recovery-read-server.ts';
import { retirePackageOptionActionApiLive } from './retire-package-option-action-server.ts';
import { retirePackageOptionRecoveryReadApiLive } from './retire-package-option-recovery-read-server.ts';
import { retireProductActionApiLive } from './retire-product-action-server.ts';
import { retireProductCategoryActionApiLive } from './retire-product-category-action-server.ts';
import { retireProductCategoryRecoveryReadApiLive } from './retire-product-category-recovery-read-server.ts';
import { retireProductRecoveryReadApiLive } from './retire-product-recovery-read-server.ts';
import { retireProductUnitActionApiLive } from './retire-product-unit-action-server.ts';
import { retireProductUnitRecoveryReadApiLive } from './retire-product-unit-recovery-read-server.ts';
import { retireVariantActionApiLive } from './retire-variant-action-server.ts';
import { retireVariantRecoveryReadApiLive } from './retire-variant-recovery-read-server.ts';
import { reviseAttributeDefinitionActionApiLive } from './revise-attribute-definition-action-server.ts';
import { reviseAttributeDefinitionRecoveryReadApiLive } from './revise-attribute-definition-recovery-read-server.ts';
import { reviseConfigurationUnitActionApiLive } from './revise-configuration-unit-action-server.ts';
import { reviseConfigurationUnitRecoveryReadApiLive } from './revise-configuration-unit-recovery-read-server.ts';
import { revisePackageDefinitionActionApiLive } from './revise-package-definition-action-server.ts';
import { revisePackageDefinitionRecoveryReadApiLive } from './revise-package-definition-recovery-read-server.ts';
import { reviseProductTypeActionApiLive } from './revise-product-type-action-server.ts';
import { reviseProductTypeRecoveryReadApiLive } from './revise-product-type-recovery-read-server.ts';
import { reviseProductUnitActionApiLive } from './revise-product-unit-action-server.ts';
import { reviseProductUnitRecoveryReadApiLive } from './revise-product-unit-recovery-read-server.ts';
import { reviseSetCompositionActionApiLive } from './revise-set-composition-action-server.ts';
import { reviseSetCompositionRecoveryReadApiLive } from './revise-set-composition-recovery-read-server.ts';
import { selectionEvidenceReadApiLive } from './selection-evidence-read-server.ts';
import { setCompositionCurrentReadApiLive } from './set-composition-current-read-server.ts';
import { setCompositionHistoryReadApiLive } from './set-composition-history-read-server.ts';
import { setProductAttributeValuesActionApiLive } from './set-product-attribute-values-action-server.ts';
import { setProductAttributeValuesRecoveryReadApiLive } from './set-product-attribute-values-recovery-read-server.ts';
import { setProductBrandActionApiLive } from './set-product-brand-action-server.ts';
import { setProductBrandRecoveryReadApiLive } from './set-product-brand-recovery-read-server.ts';
import { setProductLocalizedFactsActionApiLive } from './set-product-localized-facts-action-server.ts';
import { setProductLocalizedFactsRecoveryReadApiLive } from './set-product-localized-facts-recovery-read-server.ts';
import { setProductManufacturerActionApiLive } from './set-product-manufacturer-action-server.ts';
import { setProductManufacturerRecoveryReadApiLive } from './set-product-manufacturer-recovery-read-server.ts';
import { setProductTypeActionApiLive } from './set-product-type-action-server.ts';
import { setProductTypeRecoveryReadApiLive } from './set-product-type-recovery-read-server.ts';
import { setProductUnitTargetDivisibilityActionApiLive } from './set-product-unit-target-divisibility-action-server.ts';
import { setProductUnitTargetDivisibilityRecoveryReadApiLive } from './set-product-unit-target-divisibility-recovery-read-server.ts';
import { setVariantAttributeOverrideActionApiLive } from './set-variant-attribute-override-action-server.ts';
import { setVariantAttributeOverrideRecoveryReadApiLive } from './set-variant-attribute-override-recovery-read-server.ts';
import { setVariantLocalizedFactsActionApiLive } from './set-variant-localized-facts-action-server.ts';
import { setVariantLocalizedFactsRecoveryReadApiLive } from './set-variant-localized-facts-recovery-read-server.ts';
import { skuLookupReadApiLive } from './sku-lookup-read-server.ts';
import { updateProductActionApiLive } from './update-product-action-server.ts';
import { updateProductRecoveryReadApiLive } from './update-product-recovery-read-server.ts';
import { variantHistoryReadApiLive } from './variant-history-read-server.ts';
// </generated-governed-http-handler-imports>

import { catalogApi, catalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker } from '../shared/ultramodern-build.ts';
import {
  catalogCorsAllowedHeaders,
  catalogCorsAllowedMethods,
  catalogCorsAllowedOrigins,
  resolveCatalogShellOrigin,
} from './runtime-support.ts';

const catalogReadinessLayer = HttpApiBuilder.group(catalogApi, 'foundation', (handlers) =>
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
      Effect.withSpan('ultramodern.api.catalog.readiness', {
        attributes: microVerticalOperationAttributes(catalogOperationContexts.readiness),
        kind: 'server',
      }),
    ),
  ),
);

declare const ULTRAMODERN_SHELL_ORIGIN: unknown;

const readShellOrigin = () => {
  try {
    return resolveCatalogShellOrigin(
      Schema.is(Schema.String)(ULTRAMODERN_SHELL_ORIGIN) ? ULTRAMODERN_SHELL_ORIGIN : undefined,
    );
  } catch {
    return resolveCatalogShellOrigin();
  }
};

const runtimeObservabilityLayers = [
  Logger.layer([Logger.defaultLogger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, Tracer.make({ span: (options) => new Tracer.NativeSpan(options) })),
  Layer.succeed(References.MinimumLogLevel, 'Info'),
] as const;
const runtimeObservabilityLive = Layer.mergeAll(...runtimeObservabilityLayers);
const tenantModuleStateServiceLive = TenantModuleStateServiceLive.pipe(Layer.provide(CorePersistenceLive));
const moduleStateGateLive = ModuleStateGateLive.pipe(Layer.provide(tenantModuleStateServiceLive));
const operationalScopeResolverLive = Layer.provide(
  OperationalScopeResolverLive,
  Layer.mergeAll(CorePersistenceLive, ContextAccessLive),
);
const moduleEntrypointGatewayLive = ModuleEntrypointGatewayLive.pipe(Layer.provide(moduleStateGateLive));
const catalogSourceActionPersistenceLive = catalogSourceActionPersistenceFactoryLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      catalogExternalCorrelationResolverLive,
      catalogImportAcceptanceServiceFactoryLive,
      catalogLocalOverrideServiceFactoryLive,
    ),
  ),
);
const catalogActionRuntime = ActionRuntimeLive.pipe(
  Layer.provide(catalogSourceActionPersistenceLive),
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(DatabaseConfigLive),
);
const catalogReadRuntime = ReadRuntimeLive.pipe(
  Layer.provide(catalogExternalCorrelationResolverLive),
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
);

type CatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof catalogReadRuntime>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof catalogActionRuntime>>,
  gatewayAssertionRedemption: Layer.Layer<GatewayAssertionRedemptionService>,
];

type CatalogApiGroups = (typeof catalogApi.groups)[keyof typeof catalogApi.groups];

export const makeCatalogApiRuntime = (
  ...args: CatalogApiRuntimeArguments
): EffectBffDefinition<typeof catalogApi> & EffectBffRuntime<typeof catalogApi> => {
  const [governedReadRuntimeLive, actionRuntimeLive, gatewayAssertionRedemption] = args;
  const governedActionRuntimeLive = Layer.mergeAll(actionRuntimeLive, governedReadRuntimeLive);
  const actionPrincipalVerifierLive = GovernedActionPrincipalVerifierLive.pipe(
    Layer.provide(governedActionRuntimeLive),
  );
  const apiHandlersLive = Layer.mergeAll(
    catalogReadinessLayer,
    // <generated-governed-http-handler-layers>
    activateLocalOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    activateLocalOverrideRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    activatePackageDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    activatePackageDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    activatePackageOptionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    activatePackageOptionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    addProductCategoryAssignmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    addProductCategoryAssignmentRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    assertSizeEquivalenceActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assertSizeEquivalenceRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    assignCatalogMediaActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignCatalogMediaRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    assignSkuActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    assignSkuRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    brandCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    brandHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    catalogDocumentCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    catalogMediaCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    catalogSourceResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    changeLocalOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeLocalOverrideRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    changeProductManufacturerActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeProductManufacturerRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    changeProductRelationshipActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeProductRelationshipRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    changeVariantActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    changeVariantRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    colorCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    colorHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    confirmGtinActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    confirmGtinRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    confirmVariantCombinationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    confirmVariantCombinationRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    correctGtinActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctGtinRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    correctProductActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctProductRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    correctSkuActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    correctSkuRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createAttributeDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createAttributeDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createBrandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createBrandRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createConfigurationUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createConfigurationUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createControlledAttributeValueActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createControlledAttributeValueRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createPackageDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createPackageDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createProductActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProductCategoryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProductCategoryRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createProductRecoveryReadApiLive.pipe(
      GovernedReadLayer.provide(governedReadRuntimeLive),
      Layer.provide(governedActionRuntimeLive),
    ),
    createProductRelationshipActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProductRelationshipRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createProductTypeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProductTypeRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createProductUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createProductUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createSetCompositionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createSetCompositionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    createVariantActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    createVariantRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    decideProductTypeUnnecessaryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    decideProductTypeUnnecessaryRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    effectiveAttributeValuesCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    externalTargetResolutionReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    governProductAttributeApplicabilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    governProductAttributeApplicabilityRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    governVariantAllowedValuesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    governVariantAllowedValuesRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    governVariantAxesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    governVariantAxesRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gtinCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    gtinHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    importSourceAssertionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    importSourceAssertionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    listRecordedVariantsReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    manufacturerRelationCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    manufacturerRelationHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    markGtinUnresolvedActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    markGtinUnresolvedRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    moveProductCategoryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    moveProductCategoryRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    packageDefinitionHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    packageOptionHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productBrandCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productBrandHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productCategoryClassificationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productCategoryHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productDetailReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productRelationshipCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productRelationshipHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    productSizeCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    promotePackageDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    promotePackageDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    publishProductConfigurationActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    publishProductConfigurationRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    quantityPreparationReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateBrandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateBrandRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateControlledAttributeValueActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateControlledAttributeValueRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateProductActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateProductRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reactivateVariantActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reactivateVariantRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    releaseLocalOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    releaseLocalOverrideRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeCatalogMediaActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeCatalogMediaRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeProductAttributeValuesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeProductAttributeValuesRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeProductCategoryAssignmentActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeProductCategoryAssignmentRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeProductLocalizedFactsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeProductLocalizedFactsRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeProductManufacturerActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeProductManufacturerRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeProductRelationshipActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeProductRelationshipRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeVariantAttributeOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeVariantAttributeOverrideRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    removeVariantLocalizedFactsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    removeVariantLocalizedFactsRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    renameAttributeDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    renameAttributeDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    renameBrandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    renameBrandRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    renameControlledAttributeValueActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    renameControlledAttributeValueRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    renameProductCategoryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    renameProductCategoryRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    renameSkuActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    renameSkuRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reorderCatalogMediaActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reorderCatalogMediaRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    replaceProductSizesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    replaceProductSizesRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireBrandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireBrandRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireConfigurationUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireConfigurationUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireControlledAttributeValueActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireControlledAttributeValueRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireGtinActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireGtinRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retirePackageDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retirePackageDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retirePackageOptionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retirePackageOptionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireProductActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireProductCategoryActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireProductCategoryRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireProductRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireProductUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireProductUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    retireVariantActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    retireVariantRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reviseAttributeDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseAttributeDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reviseConfigurationUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseConfigurationUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    revisePackageDefinitionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    revisePackageDefinitionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reviseProductTypeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseProductTypeRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reviseProductUnitActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseProductUnitRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    reviseSetCompositionActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    reviseSetCompositionRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    selectionEvidenceReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setCompositionCurrentReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setCompositionHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductAttributeValuesActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductAttributeValuesRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductBrandActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductBrandRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductLocalizedFactsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductLocalizedFactsRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductManufacturerActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductManufacturerRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductTypeActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductTypeRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setProductUnitTargetDivisibilityActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setProductUnitTargetDivisibilityRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setVariantAttributeOverrideActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setVariantAttributeOverrideRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    setVariantLocalizedFactsActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    setVariantLocalizedFactsRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    skuLookupReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    updateProductActionApiLive.pipe(GovernedReadLayer.provide(governedActionRuntimeLive)),
    updateProductRecoveryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    variantHistoryReadApiLive.pipe(GovernedReadLayer.provide(governedReadRuntimeLive)),
    // </generated-governed-http-handler-layers>
  ).pipe(Layer.provide(Layer.mergeAll(actionPrincipalVerifierLive, gatewayAssertionRedemption)));
  type CatalogHandlerRequirements =
    typeof apiHandlersLive extends Layer.Layer<infer _Services, infer _Error, infer Requirements>
      ? Requirements
      : never;
  const resolvedApiHandlersLive: EffectBffRuntimeAssembly<
    'CatalogApi',
    CatalogApiGroups,
    CatalogHandlerRequirements
  >['handlers'] = apiHandlersLive.pipe(Layer.provide(runtimeObservabilityLive), Layer.orDie);
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...catalogCorsAllowedHeaders],
    allowedMethods: [...catalogCorsAllowedMethods],
    allowedOrigins: catalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: catalogApi,
    handlers: resolvedApiHandlersLive,
    transport: transportLive,
  });
};

const apiRuntime: EffectBffDefinition<typeof catalogApi> & EffectBffRuntime<typeof catalogApi> = makeCatalogApiRuntime(
  catalogReadRuntime,
  catalogActionRuntime,
  GovernedGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { catalogActionRuntime };
