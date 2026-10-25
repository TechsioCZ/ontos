import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import {
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  ContextAccessLive,
  CorePersistenceLive,
  DatabaseConfigLive,
  ReadRuntimeLive,
  TenantModuleStateServiceLive,
  makeActionRuntimeLive,
} from '@app/core-runtime';
import type { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import { ActiveApplicationCompositionConfigLive } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
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
import { Logger, References, Schema, Tracer } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { microVerticalOperationAttributes } from '@app/shared-contracts';
import { catalogImportAcceptanceServiceFactoryLive } from '../src/persistence/catalog-import-acceptance-service.ts';
import { catalogLocalOverrideServiceFactoryLive } from '../src/persistence/catalog-local-override-service.ts';
import { catalogSourceActionPersistenceFactoryLive } from '../src/persistence/catalog-source-action-persistence.ts';
import { catalogExternalCorrelationResolverLive } from '../src/persistence/external-correlation-resolver.ts';
// <generated-governed-http-handler-support-imports>
import { ActionPrincipalVerifierLive as GovernedActionPrincipalVerifierLive } from './auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive as GovernedGatewayAssertionRedemptionLive,
} from './auth/gateway-assertion-redemption.ts';
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
import { assortmentProductClassificationV1ReadApiLive } from './assortment-product-classification-v1-read-server.ts';
import { assortmentSelectionAssessmentV1ReadApiLive } from './assortment-selection-assessment-v1-read-server.ts';
import { assortmentSetCompositionV1ReadApiLive } from './assortment-set-composition-v1-read-server.ts';
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
import { pricingPurposeEquivalenceReadApiLive } from './pricing-purpose-equivalence-read-server.ts';
import { productBrandCurrentReadApiLive } from './product-brand-current-read-server.ts';
import { productBrandHistoryReadApiLive } from './product-brand-history-read-server.ts';
import { productCategoryClassificationReadApiLive } from './product-category-classification-read-server.ts';
import { productCategoryHistoryReadApiLive } from './product-category-history-read-server.ts';
import { productDetailReadApiLive } from './product-detail-read-server.ts';
import { productHistoryReadApiLive } from './product-history-read-server.ts';
import { productRelationshipCurrentReadApiLive } from './product-relationship-current-read-server.ts';
import { productRelationshipHistoryReadApiLive } from './product-relationship-history-read-server.ts';
import { productSizeCurrentReadApiLive } from './product-size-current-read-server.ts';
import { productVariantSnapshotReadApiLive } from './product-variant-snapshot-read-server.ts';
import { promotePackageDefinitionActionApiLive } from './promote-package-definition-action-server.ts';
import { promotePackageDefinitionRecoveryReadApiLive } from './promote-package-definition-recovery-read-server.ts';
import { publishProductConfigurationActionApiLive } from './publish-product-configuration-action-server.ts';
import { publishProductConfigurationRecoveryReadApiLive } from './publish-product-configuration-recovery-read-server.ts';
import { quantityBasisCompatibilityReadApiLive } from './quantity-basis-compatibility-read-server.ts';
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

import { catalogApi, catalogMarkerSchema, catalogOperationContexts } from '../shared/api.ts';
import { ultramodernApiMarker, ultramodernDeliveryUnit } from '../shared/ultramodern-build.ts';
import {
  catalogCorsAllowedHeaders,
  catalogCorsAllowedMethods,
  catalogCorsAllowedOrigins,
  resolveCatalogShellOrigin,
} from './runtime-support.ts';

const databaseIdentitiesLive = makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]));

const catalogReadinessLayer = HttpApiBuilder.group(catalogApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () =>
    // The marker comes from JSON, so its literal fields are decoded against the published schema.
    Schema.decodeUnknownEffect(catalogMarkerSchema)(ultramodernApiMarker).pipe(
      Effect.orDie,
      Effect.map((marker) => ({
        checks: {
          api: 'ready' as const,
          moduleFederation: 'ready' as const,
          ssr: 'ready' as const,
          translations: 'ready' as const,
        },
        marker,
        status: 'ready' as const,
        versionSkew: 'none' as const,
      })),
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
const nativeHttpClientLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
);
const nativeCompositionSourceLive = ActiveApplicationCompositionSourceLive.pipe(Layer.provide(nativeHttpClientLive));
const activeApplicationCompositionLive = ActiveApplicationCompositionConfigLive.pipe(
  Layer.provide(nativeCompositionSourceLive),
);
const catalogActionRuntime = makeActionRuntimeLive(ultramodernDeliveryUnit).pipe(
  Layer.provide(catalogSourceActionPersistenceLive),
  Layer.provide(
    Layer.mergeAll(
      CorePersistenceLive,
      activeApplicationCompositionLive,
      ActionRepositoryLive,
      ActionPermissionLive,
      ContextAccessLive,
      moduleStateGateLive,
      moduleEntrypointGatewayLive,
      operationalScopeResolverLive,
    ),
  ),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(databaseIdentitiesLive),
);
const catalogReadRuntime = ReadRuntimeLive.pipe(
  Layer.provide(catalogExternalCorrelationResolverLive),
  Layer.provide(
    Layer.mergeAll(CorePersistenceLive, ContextAccessLive, moduleEntrypointGatewayLive, operationalScopeResolverLive),
  ),
  Layer.provide(DatabaseConfigLive),
  Layer.provide(databaseIdentitiesLive),
);

const productionGatewayAssertionRedemptionLive = GovernedGatewayAssertionRedemptionLive.pipe(
  Layer.provide(GatewayAssertionRedemptionDatabaseLive),
  Layer.provide(DatabaseConfigLive),
);

type CatalogApiRuntimeArguments = readonly [
  readRuntime: Layer.Layer<ReadRuntime, Layer.Error<typeof catalogReadRuntime>>,
  actionRuntime: Layer.Layer<ActionRuntime, Layer.Error<typeof catalogActionRuntime>>,
  gatewayAssertionRedemption: Layer.Layer<
    GatewayAssertionRedemptionService,
    Layer.Error<typeof productionGatewayAssertionRedemptionLive>
  >,
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
    activateLocalOverrideActionApiLive,
    activateLocalOverrideRecoveryReadApiLive,
    activatePackageDefinitionActionApiLive,
    activatePackageDefinitionRecoveryReadApiLive,
    activatePackageOptionActionApiLive,
    activatePackageOptionRecoveryReadApiLive,
    addProductCategoryAssignmentActionApiLive,
    addProductCategoryAssignmentRecoveryReadApiLive,
    assertSizeEquivalenceActionApiLive,
    assertSizeEquivalenceRecoveryReadApiLive,
    assignCatalogMediaActionApiLive,
    assignCatalogMediaRecoveryReadApiLive,
    assignSkuActionApiLive,
    assignSkuRecoveryReadApiLive,
    assortmentProductClassificationV1ReadApiLive,
    assortmentSelectionAssessmentV1ReadApiLive,
    assortmentSetCompositionV1ReadApiLive,
    brandCurrentReadApiLive,
    brandHistoryReadApiLive,
    catalogDocumentCurrentReadApiLive,
    catalogMediaCurrentReadApiLive,
    catalogSourceResolutionReadApiLive,
    changeLocalOverrideActionApiLive,
    changeLocalOverrideRecoveryReadApiLive,
    changeProductManufacturerActionApiLive,
    changeProductManufacturerRecoveryReadApiLive,
    changeProductRelationshipActionApiLive,
    changeProductRelationshipRecoveryReadApiLive,
    changeVariantActionApiLive,
    changeVariantRecoveryReadApiLive,
    colorCurrentReadApiLive,
    colorHistoryReadApiLive,
    confirmGtinActionApiLive,
    confirmGtinRecoveryReadApiLive,
    confirmVariantCombinationActionApiLive,
    confirmVariantCombinationRecoveryReadApiLive,
    correctGtinActionApiLive,
    correctGtinRecoveryReadApiLive,
    correctProductActionApiLive,
    correctProductRecoveryReadApiLive,
    correctSkuActionApiLive,
    correctSkuRecoveryReadApiLive,
    createAttributeDefinitionActionApiLive,
    createAttributeDefinitionRecoveryReadApiLive,
    createBrandActionApiLive,
    createBrandRecoveryReadApiLive,
    createConfigurationUnitActionApiLive,
    createConfigurationUnitRecoveryReadApiLive,
    createControlledAttributeValueActionApiLive,
    createControlledAttributeValueRecoveryReadApiLive,
    createPackageDefinitionActionApiLive,
    createPackageDefinitionRecoveryReadApiLive,
    createProductActionApiLive,
    createProductCategoryActionApiLive,
    createProductCategoryRecoveryReadApiLive,
    createProductRecoveryReadApiLive,
    createProductRelationshipActionApiLive,
    createProductRelationshipRecoveryReadApiLive,
    createProductTypeActionApiLive,
    createProductTypeRecoveryReadApiLive,
    createProductUnitActionApiLive,
    createProductUnitRecoveryReadApiLive,
    createSetCompositionActionApiLive,
    createSetCompositionRecoveryReadApiLive,
    createVariantActionApiLive,
    createVariantRecoveryReadApiLive,
    decideProductTypeUnnecessaryActionApiLive,
    decideProductTypeUnnecessaryRecoveryReadApiLive,
    effectiveAttributeValuesCurrentReadApiLive,
    externalTargetResolutionReadApiLive,
    governProductAttributeApplicabilityActionApiLive,
    governProductAttributeApplicabilityRecoveryReadApiLive,
    governVariantAllowedValuesActionApiLive,
    governVariantAllowedValuesRecoveryReadApiLive,
    governVariantAxesActionApiLive,
    governVariantAxesRecoveryReadApiLive,
    gtinCurrentReadApiLive,
    gtinHistoryReadApiLive,
    importSourceAssertionActionApiLive,
    importSourceAssertionRecoveryReadApiLive,
    listRecordedVariantsReadApiLive,
    manufacturerRelationCurrentReadApiLive,
    manufacturerRelationHistoryReadApiLive,
    markGtinUnresolvedActionApiLive,
    markGtinUnresolvedRecoveryReadApiLive,
    moveProductCategoryActionApiLive,
    moveProductCategoryRecoveryReadApiLive,
    packageDefinitionHistoryReadApiLive,
    packageOptionHistoryReadApiLive,
    pricingPurposeEquivalenceReadApiLive,
    productBrandCurrentReadApiLive,
    productBrandHistoryReadApiLive,
    productCategoryClassificationReadApiLive,
    productCategoryHistoryReadApiLive,
    productDetailReadApiLive,
    productHistoryReadApiLive,
    productRelationshipCurrentReadApiLive,
    productRelationshipHistoryReadApiLive,
    productSizeCurrentReadApiLive,
    productVariantSnapshotReadApiLive,
    promotePackageDefinitionActionApiLive,
    promotePackageDefinitionRecoveryReadApiLive,
    publishProductConfigurationActionApiLive,
    publishProductConfigurationRecoveryReadApiLive,
    quantityBasisCompatibilityReadApiLive,
    quantityPreparationReadApiLive,
    reactivateBrandActionApiLive,
    reactivateBrandRecoveryReadApiLive,
    reactivateControlledAttributeValueActionApiLive,
    reactivateControlledAttributeValueRecoveryReadApiLive,
    reactivateProductActionApiLive,
    reactivateProductRecoveryReadApiLive,
    reactivateVariantActionApiLive,
    reactivateVariantRecoveryReadApiLive,
    releaseLocalOverrideActionApiLive,
    releaseLocalOverrideRecoveryReadApiLive,
    removeCatalogMediaActionApiLive,
    removeCatalogMediaRecoveryReadApiLive,
    removeProductAttributeValuesActionApiLive,
    removeProductAttributeValuesRecoveryReadApiLive,
    removeProductCategoryAssignmentActionApiLive,
    removeProductCategoryAssignmentRecoveryReadApiLive,
    removeProductLocalizedFactsActionApiLive,
    removeProductLocalizedFactsRecoveryReadApiLive,
    removeProductManufacturerActionApiLive,
    removeProductManufacturerRecoveryReadApiLive,
    removeProductRelationshipActionApiLive,
    removeProductRelationshipRecoveryReadApiLive,
    removeVariantAttributeOverrideActionApiLive,
    removeVariantAttributeOverrideRecoveryReadApiLive,
    removeVariantLocalizedFactsActionApiLive,
    removeVariantLocalizedFactsRecoveryReadApiLive,
    renameAttributeDefinitionActionApiLive,
    renameAttributeDefinitionRecoveryReadApiLive,
    renameBrandActionApiLive,
    renameBrandRecoveryReadApiLive,
    renameControlledAttributeValueActionApiLive,
    renameControlledAttributeValueRecoveryReadApiLive,
    renameProductCategoryActionApiLive,
    renameProductCategoryRecoveryReadApiLive,
    renameSkuActionApiLive,
    renameSkuRecoveryReadApiLive,
    reorderCatalogMediaActionApiLive,
    reorderCatalogMediaRecoveryReadApiLive,
    replaceProductSizesActionApiLive,
    replaceProductSizesRecoveryReadApiLive,
    retireBrandActionApiLive,
    retireBrandRecoveryReadApiLive,
    retireConfigurationUnitActionApiLive,
    retireConfigurationUnitRecoveryReadApiLive,
    retireControlledAttributeValueActionApiLive,
    retireControlledAttributeValueRecoveryReadApiLive,
    retireGtinActionApiLive,
    retireGtinRecoveryReadApiLive,
    retirePackageDefinitionActionApiLive,
    retirePackageDefinitionRecoveryReadApiLive,
    retirePackageOptionActionApiLive,
    retirePackageOptionRecoveryReadApiLive,
    retireProductActionApiLive,
    retireProductCategoryActionApiLive,
    retireProductCategoryRecoveryReadApiLive,
    retireProductRecoveryReadApiLive,
    retireProductUnitActionApiLive,
    retireProductUnitRecoveryReadApiLive,
    retireVariantActionApiLive,
    retireVariantRecoveryReadApiLive,
    reviseAttributeDefinitionActionApiLive,
    reviseAttributeDefinitionRecoveryReadApiLive,
    reviseConfigurationUnitActionApiLive,
    reviseConfigurationUnitRecoveryReadApiLive,
    revisePackageDefinitionActionApiLive,
    revisePackageDefinitionRecoveryReadApiLive,
    reviseProductTypeActionApiLive,
    reviseProductTypeRecoveryReadApiLive,
    reviseProductUnitActionApiLive,
    reviseProductUnitRecoveryReadApiLive,
    reviseSetCompositionActionApiLive,
    reviseSetCompositionRecoveryReadApiLive,
    selectionEvidenceReadApiLive,
    setCompositionCurrentReadApiLive,
    setCompositionHistoryReadApiLive,
    setProductAttributeValuesActionApiLive,
    setProductAttributeValuesRecoveryReadApiLive,
    setProductBrandActionApiLive,
    setProductBrandRecoveryReadApiLive,
    setProductLocalizedFactsActionApiLive,
    setProductLocalizedFactsRecoveryReadApiLive,
    setProductManufacturerActionApiLive,
    setProductManufacturerRecoveryReadApiLive,
    setProductTypeActionApiLive,
    setProductTypeRecoveryReadApiLive,
    setProductUnitTargetDivisibilityActionApiLive,
    setProductUnitTargetDivisibilityRecoveryReadApiLive,
    setVariantAttributeOverrideActionApiLive,
    setVariantAttributeOverrideRecoveryReadApiLive,
    setVariantLocalizedFactsActionApiLive,
    setVariantLocalizedFactsRecoveryReadApiLive,
    skuLookupReadApiLive,
    updateProductActionApiLive,
    updateProductRecoveryReadApiLive,
    variantHistoryReadApiLive,
    // </generated-governed-http-handler-layers>
  );
  const requestServicesLive = Layer.mergeAll(
    governedReadRuntimeLive,
    governedActionRuntimeLive,
    catalogSourceActionPersistenceLive,
    actionPrincipalVerifierLive,
    gatewayAssertionRedemption,
  ).pipe(
    Layer.provideMerge(nativeCompositionSourceLive),
    Layer.provideMerge(runtimeObservabilityLive),
    Layer.provideMerge(databaseIdentitiesLive),
    Layer.orDie,
  );
  type CatalogHandlerRequirements =
    | (typeof apiHandlersLive extends Layer.Layer<infer _Services, infer _Error, infer Requirements>
        ? Requirements
        : never)
    | HttpRouter.HttpRouter;
  const resolvedApiHandlersLive: EffectBffRuntimeAssembly<
    'CatalogApi',
    CatalogApiGroups,
    CatalogHandlerRequirements,
    Layer.Success<typeof requestServicesLive>
  >['handlers'] = apiHandlersLive.pipe(Layer.provide(RequestSchemaProblemLive));
  const transportLive = HttpRouter.cors({
    allowedHeaders: [...catalogCorsAllowedHeaders],
    allowedMethods: [...catalogCorsAllowedMethods],
    allowedOrigins: catalogCorsAllowedOrigins(readShellOrigin()),
    maxAge: 600,
  });

  return assembleEffectBffRuntime({
    api: catalogApi,
    handlers: resolvedApiHandlersLive,
    services: requestServicesLive,
    transport: transportLive,
  });
};

const apiRuntime: EffectBffDefinition<typeof catalogApi> & EffectBffRuntime<typeof catalogApi> = makeCatalogApiRuntime(
  catalogReadRuntime,
  catalogActionRuntime,
  productionGatewayAssertionRedemptionLive,
);

export default apiRuntime;

export { catalogActionRuntime };
