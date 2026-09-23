import {
  MicroVerticalBuildMarkerSchema,
  MicroVerticalReadinessSchema,
  createMicroVerticalOperationContext,
} from '@modern-js/bff-effect/microvertical-api';
import type { MicroVerticalOperationContext } from '@modern-js/bff-effect/microvertical-api';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import { identity } from 'effect';

// <generated-governed-http-api-imports>
import { ActivateLocalOverrideActionApi } from './apis/activate-local-override-action.ts';
import { ActivateLocalOverrideRecoveryApi } from './apis/activate-local-override-recovery.ts';
import { ActivatePackageDefinitionActionApi } from './apis/activate-package-definition-action.ts';
import { ActivatePackageDefinitionRecoveryApi } from './apis/activate-package-definition-recovery.ts';
import { ActivatePackageOptionActionApi } from './apis/activate-package-option-action.ts';
import { ActivatePackageOptionRecoveryApi } from './apis/activate-package-option-recovery.ts';
import { AddProductCategoryAssignmentActionApi } from './apis/add-product-category-assignment-action.ts';
import { AddProductCategoryAssignmentRecoveryApi } from './apis/add-product-category-assignment-recovery.ts';
import { AssertSizeEquivalenceActionApi } from './apis/assert-size-equivalence-action.ts';
import { AssertSizeEquivalenceRecoveryApi } from './apis/assert-size-equivalence-recovery.ts';
import { AssignCatalogMediaActionApi } from './apis/assign-catalog-media-action.ts';
import { AssignCatalogMediaRecoveryApi } from './apis/assign-catalog-media-recovery.ts';
import { AssignSkuActionApi } from './apis/assign-sku-action.ts';
import { AssignSkuRecoveryApi } from './apis/assign-sku-recovery.ts';
import { BrandCurrentApi } from './apis/brand-current.ts';
import { BrandHistoryApi } from './apis/brand-history.ts';
import { CatalogDocumentCurrentApi } from './apis/catalog-document-current.ts';
import { CatalogMediaCurrentApi } from './apis/catalog-media-current.ts';
import { CatalogSourceResolutionApi } from './apis/catalog-source-resolution.ts';
import { ChangeLocalOverrideActionApi } from './apis/change-local-override-action.ts';
import { ChangeLocalOverrideRecoveryApi } from './apis/change-local-override-recovery.ts';
import { ChangeProductManufacturerActionApi } from './apis/change-product-manufacturer-action.ts';
import { ChangeProductManufacturerRecoveryApi } from './apis/change-product-manufacturer-recovery.ts';
import { ChangeProductRelationshipActionApi } from './apis/change-product-relationship-action.ts';
import { ChangeProductRelationshipRecoveryApi } from './apis/change-product-relationship-recovery.ts';
import { ChangeVariantActionApi } from './apis/change-variant-action.ts';
import { ChangeVariantRecoveryApi } from './apis/change-variant-recovery.ts';
import { ColorCurrentApi } from './apis/color-current.ts';
import { ColorHistoryApi } from './apis/color-history.ts';
import { ConfirmGtinActionApi } from './apis/confirm-gtin-action.ts';
import { ConfirmGtinRecoveryApi } from './apis/confirm-gtin-recovery.ts';
import { ConfirmVariantCombinationActionApi } from './apis/confirm-variant-combination-action.ts';
import { ConfirmVariantCombinationRecoveryApi } from './apis/confirm-variant-combination-recovery.ts';
import { CorrectGtinActionApi } from './apis/correct-gtin-action.ts';
import { CorrectGtinRecoveryApi } from './apis/correct-gtin-recovery.ts';
import { CorrectProductActionApi } from './apis/correct-product-action.ts';
import { CorrectProductRecoveryApi } from './apis/correct-product-recovery.ts';
import { CorrectSkuActionApi } from './apis/correct-sku-action.ts';
import { CorrectSkuRecoveryApi } from './apis/correct-sku-recovery.ts';
import { CreateAttributeDefinitionActionApi } from './apis/create-attribute-definition-action.ts';
import { CreateAttributeDefinitionRecoveryApi } from './apis/create-attribute-definition-recovery.ts';
import { CreateBrandActionApi } from './apis/create-brand-action.ts';
import { CreateBrandRecoveryApi } from './apis/create-brand-recovery.ts';
import { CreateConfigurationUnitActionApi } from './apis/create-configuration-unit-action.ts';
import { CreateConfigurationUnitRecoveryApi } from './apis/create-configuration-unit-recovery.ts';
import { CreateControlledAttributeValueActionApi } from './apis/create-controlled-attribute-value-action.ts';
import { CreateControlledAttributeValueRecoveryApi } from './apis/create-controlled-attribute-value-recovery.ts';
import { CreatePackageDefinitionActionApi } from './apis/create-package-definition-action.ts';
import { CreatePackageDefinitionRecoveryApi } from './apis/create-package-definition-recovery.ts';
import { CreateProductActionApi } from './apis/create-product-action.ts';
import { CreateProductCategoryActionApi } from './apis/create-product-category-action.ts';
import { CreateProductCategoryRecoveryApi } from './apis/create-product-category-recovery.ts';
import { CreateProductRecoveryApi } from './apis/create-product-recovery.ts';
import { CreateProductRelationshipActionApi } from './apis/create-product-relationship-action.ts';
import { CreateProductRelationshipRecoveryApi } from './apis/create-product-relationship-recovery.ts';
import { CreateProductTypeActionApi } from './apis/create-product-type-action.ts';
import { CreateProductTypeRecoveryApi } from './apis/create-product-type-recovery.ts';
import { CreateProductUnitActionApi } from './apis/create-product-unit-action.ts';
import { CreateProductUnitRecoveryApi } from './apis/create-product-unit-recovery.ts';
import { CreateSetCompositionActionApi } from './apis/create-set-composition-action.ts';
import { CreateSetCompositionRecoveryApi } from './apis/create-set-composition-recovery.ts';
import { CreateVariantActionApi } from './apis/create-variant-action.ts';
import { CreateVariantRecoveryApi } from './apis/create-variant-recovery.ts';
import { DecideProductTypeUnnecessaryActionApi } from './apis/decide-product-type-unnecessary-action.ts';
import { DecideProductTypeUnnecessaryRecoveryApi } from './apis/decide-product-type-unnecessary-recovery.ts';
import { EffectiveAttributeValuesCurrentApi } from './apis/effective-attribute-values-current.ts';
import { ExternalTargetResolutionApi } from './apis/external-target-resolution.ts';
import { GovernProductAttributeApplicabilityActionApi } from './apis/govern-product-attribute-applicability-action.ts';
import { GovernProductAttributeApplicabilityRecoveryApi } from './apis/govern-product-attribute-applicability-recovery.ts';
import { GovernVariantAllowedValuesActionApi } from './apis/govern-variant-allowed-values-action.ts';
import { GovernVariantAllowedValuesRecoveryApi } from './apis/govern-variant-allowed-values-recovery.ts';
import { GovernVariantAxesActionApi } from './apis/govern-variant-axes-action.ts';
import { GovernVariantAxesRecoveryApi } from './apis/govern-variant-axes-recovery.ts';
import { GtinCurrentApi } from './apis/gtin-current.ts';
import { GtinHistoryApi } from './apis/gtin-history.ts';
import { ImportSourceAssertionActionApi } from './apis/import-source-assertion-action.ts';
import { ImportSourceAssertionRecoveryApi } from './apis/import-source-assertion-recovery.ts';
import { ListRecordedVariantsApi } from './apis/list-recorded-variants.ts';
import { ManufacturerRelationCurrentApi } from './apis/manufacturer-relation-current.ts';
import { ManufacturerRelationHistoryApi } from './apis/manufacturer-relation-history.ts';
import { MarkGtinUnresolvedActionApi } from './apis/mark-gtin-unresolved-action.ts';
import { MarkGtinUnresolvedRecoveryApi } from './apis/mark-gtin-unresolved-recovery.ts';
import { MoveProductCategoryActionApi } from './apis/move-product-category-action.ts';
import { MoveProductCategoryRecoveryApi } from './apis/move-product-category-recovery.ts';
import { PackageDefinitionHistoryApi } from './apis/package-definition-history.ts';
import { PackageOptionHistoryApi } from './apis/package-option-history.ts';
import { ProductBrandCurrentApi } from './apis/product-brand-current.ts';
import { ProductBrandHistoryApi } from './apis/product-brand-history.ts';
import { ProductCategoryClassificationApi } from './apis/product-category-classification.ts';
import { ProductCategoryHistoryApi } from './apis/product-category-history.ts';
import { ProductDetailApi } from './apis/product-detail.ts';
import { ProductHistoryApi } from './apis/product-history.ts';
import { ProductRelationshipCurrentApi } from './apis/product-relationship-current.ts';
import { ProductRelationshipHistoryApi } from './apis/product-relationship-history.ts';
import { ProductSizeCurrentApi } from './apis/product-size-current.ts';
import { PromotePackageDefinitionActionApi } from './apis/promote-package-definition-action.ts';
import { PromotePackageDefinitionRecoveryApi } from './apis/promote-package-definition-recovery.ts';
import { PublishProductConfigurationActionApi } from './apis/publish-product-configuration-action.ts';
import { PublishProductConfigurationRecoveryApi } from './apis/publish-product-configuration-recovery.ts';
import { QuantityPreparationApi } from './apis/quantity-preparation.ts';
import { ReactivateBrandActionApi } from './apis/reactivate-brand-action.ts';
import { ReactivateBrandRecoveryApi } from './apis/reactivate-brand-recovery.ts';
import { ReactivateControlledAttributeValueActionApi } from './apis/reactivate-controlled-attribute-value-action.ts';
import { ReactivateControlledAttributeValueRecoveryApi } from './apis/reactivate-controlled-attribute-value-recovery.ts';
import { ReactivateProductActionApi } from './apis/reactivate-product-action.ts';
import { ReactivateProductRecoveryApi } from './apis/reactivate-product-recovery.ts';
import { ReactivateVariantActionApi } from './apis/reactivate-variant-action.ts';
import { ReactivateVariantRecoveryApi } from './apis/reactivate-variant-recovery.ts';
import { ReleaseLocalOverrideActionApi } from './apis/release-local-override-action.ts';
import { ReleaseLocalOverrideRecoveryApi } from './apis/release-local-override-recovery.ts';
import { RemoveCatalogMediaActionApi } from './apis/remove-catalog-media-action.ts';
import { RemoveCatalogMediaRecoveryApi } from './apis/remove-catalog-media-recovery.ts';
import { RemoveProductAttributeValuesActionApi } from './apis/remove-product-attribute-values-action.ts';
import { RemoveProductAttributeValuesRecoveryApi } from './apis/remove-product-attribute-values-recovery.ts';
import { RemoveProductCategoryAssignmentActionApi } from './apis/remove-product-category-assignment-action.ts';
import { RemoveProductCategoryAssignmentRecoveryApi } from './apis/remove-product-category-assignment-recovery.ts';
import { RemoveProductLocalizedFactsActionApi } from './apis/remove-product-localized-facts-action.ts';
import { RemoveProductLocalizedFactsRecoveryApi } from './apis/remove-product-localized-facts-recovery.ts';
import { RemoveProductManufacturerActionApi } from './apis/remove-product-manufacturer-action.ts';
import { RemoveProductManufacturerRecoveryApi } from './apis/remove-product-manufacturer-recovery.ts';
import { RemoveProductRelationshipActionApi } from './apis/remove-product-relationship-action.ts';
import { RemoveProductRelationshipRecoveryApi } from './apis/remove-product-relationship-recovery.ts';
import { RemoveVariantAttributeOverrideActionApi } from './apis/remove-variant-attribute-override-action.ts';
import { RemoveVariantAttributeOverrideRecoveryApi } from './apis/remove-variant-attribute-override-recovery.ts';
import { RemoveVariantLocalizedFactsActionApi } from './apis/remove-variant-localized-facts-action.ts';
import { RemoveVariantLocalizedFactsRecoveryApi } from './apis/remove-variant-localized-facts-recovery.ts';
import { RenameAttributeDefinitionActionApi } from './apis/rename-attribute-definition-action.ts';
import { RenameAttributeDefinitionRecoveryApi } from './apis/rename-attribute-definition-recovery.ts';
import { RenameBrandActionApi } from './apis/rename-brand-action.ts';
import { RenameBrandRecoveryApi } from './apis/rename-brand-recovery.ts';
import { RenameControlledAttributeValueActionApi } from './apis/rename-controlled-attribute-value-action.ts';
import { RenameControlledAttributeValueRecoveryApi } from './apis/rename-controlled-attribute-value-recovery.ts';
import { RenameProductCategoryActionApi } from './apis/rename-product-category-action.ts';
import { RenameProductCategoryRecoveryApi } from './apis/rename-product-category-recovery.ts';
import { RenameSkuActionApi } from './apis/rename-sku-action.ts';
import { RenameSkuRecoveryApi } from './apis/rename-sku-recovery.ts';
import { ReorderCatalogMediaActionApi } from './apis/reorder-catalog-media-action.ts';
import { ReorderCatalogMediaRecoveryApi } from './apis/reorder-catalog-media-recovery.ts';
import { ReplaceProductSizesActionApi } from './apis/replace-product-sizes-action.ts';
import { ReplaceProductSizesRecoveryApi } from './apis/replace-product-sizes-recovery.ts';
import { RetireBrandActionApi } from './apis/retire-brand-action.ts';
import { RetireBrandRecoveryApi } from './apis/retire-brand-recovery.ts';
import { RetireConfigurationUnitActionApi } from './apis/retire-configuration-unit-action.ts';
import { RetireConfigurationUnitRecoveryApi } from './apis/retire-configuration-unit-recovery.ts';
import { RetireControlledAttributeValueActionApi } from './apis/retire-controlled-attribute-value-action.ts';
import { RetireControlledAttributeValueRecoveryApi } from './apis/retire-controlled-attribute-value-recovery.ts';
import { RetireGtinActionApi } from './apis/retire-gtin-action.ts';
import { RetireGtinRecoveryApi } from './apis/retire-gtin-recovery.ts';
import { RetirePackageDefinitionActionApi } from './apis/retire-package-definition-action.ts';
import { RetirePackageDefinitionRecoveryApi } from './apis/retire-package-definition-recovery.ts';
import { RetirePackageOptionActionApi } from './apis/retire-package-option-action.ts';
import { RetirePackageOptionRecoveryApi } from './apis/retire-package-option-recovery.ts';
import { RetireProductActionApi } from './apis/retire-product-action.ts';
import { RetireProductCategoryActionApi } from './apis/retire-product-category-action.ts';
import { RetireProductCategoryRecoveryApi } from './apis/retire-product-category-recovery.ts';
import { RetireProductRecoveryApi } from './apis/retire-product-recovery.ts';
import { RetireProductUnitActionApi } from './apis/retire-product-unit-action.ts';
import { RetireProductUnitRecoveryApi } from './apis/retire-product-unit-recovery.ts';
import { RetireVariantActionApi } from './apis/retire-variant-action.ts';
import { RetireVariantRecoveryApi } from './apis/retire-variant-recovery.ts';
import { ReviseAttributeDefinitionActionApi } from './apis/revise-attribute-definition-action.ts';
import { ReviseAttributeDefinitionRecoveryApi } from './apis/revise-attribute-definition-recovery.ts';
import { ReviseConfigurationUnitActionApi } from './apis/revise-configuration-unit-action.ts';
import { ReviseConfigurationUnitRecoveryApi } from './apis/revise-configuration-unit-recovery.ts';
import { RevisePackageDefinitionActionApi } from './apis/revise-package-definition-action.ts';
import { RevisePackageDefinitionRecoveryApi } from './apis/revise-package-definition-recovery.ts';
import { ReviseProductTypeActionApi } from './apis/revise-product-type-action.ts';
import { ReviseProductTypeRecoveryApi } from './apis/revise-product-type-recovery.ts';
import { ReviseProductUnitActionApi } from './apis/revise-product-unit-action.ts';
import { ReviseProductUnitRecoveryApi } from './apis/revise-product-unit-recovery.ts';
import { ReviseSetCompositionActionApi } from './apis/revise-set-composition-action.ts';
import { ReviseSetCompositionRecoveryApi } from './apis/revise-set-composition-recovery.ts';
import { SelectionEvidenceApi } from './apis/selection-evidence.ts';
import { SetCompositionCurrentApi } from './apis/set-composition-current.ts';
import { SetCompositionHistoryApi } from './apis/set-composition-history.ts';
import { SetProductAttributeValuesActionApi } from './apis/set-product-attribute-values-action.ts';
import { SetProductAttributeValuesRecoveryApi } from './apis/set-product-attribute-values-recovery.ts';
import { SetProductBrandActionApi } from './apis/set-product-brand-action.ts';
import { SetProductBrandRecoveryApi } from './apis/set-product-brand-recovery.ts';
import { SetProductLocalizedFactsActionApi } from './apis/set-product-localized-facts-action.ts';
import { SetProductLocalizedFactsRecoveryApi } from './apis/set-product-localized-facts-recovery.ts';
import { SetProductManufacturerActionApi } from './apis/set-product-manufacturer-action.ts';
import { SetProductManufacturerRecoveryApi } from './apis/set-product-manufacturer-recovery.ts';
import { SetProductTypeActionApi } from './apis/set-product-type-action.ts';
import { SetProductTypeRecoveryApi } from './apis/set-product-type-recovery.ts';
import { SetProductUnitTargetDivisibilityActionApi } from './apis/set-product-unit-target-divisibility-action.ts';
import { SetProductUnitTargetDivisibilityRecoveryApi } from './apis/set-product-unit-target-divisibility-recovery.ts';
import { SetVariantAttributeOverrideActionApi } from './apis/set-variant-attribute-override-action.ts';
import { SetVariantAttributeOverrideRecoveryApi } from './apis/set-variant-attribute-override-recovery.ts';
import { SetVariantLocalizedFactsActionApi } from './apis/set-variant-localized-facts-action.ts';
import { SetVariantLocalizedFactsRecoveryApi } from './apis/set-variant-localized-facts-recovery.ts';
import { SkuLookupApi } from './apis/sku-lookup.ts';
import { UpdateProductActionApi } from './apis/update-product-action.ts';
import { UpdateProductRecoveryApi } from './apis/update-product-recovery.ts';
import { VariantHistoryApi } from './apis/variant-history.ts';
// </generated-governed-http-api-imports>
import { ProductActionInvocationIdSchema } from './domain/product.ts';

export const catalogMarkerSchema: Schema.Codec<typeof MicroVerticalBuildMarkerSchema.Type> =
  MicroVerticalBuildMarkerSchema;
export type CatalogMarker = typeof catalogMarkerSchema.Type;

export const catalogReadinessSchema: Schema.Codec<typeof MicroVerticalReadinessSchema.Type> =
  MicroVerticalReadinessSchema;
export type CatalogReadiness = typeof catalogReadinessSchema.Type;

export type OperationContext = MicroVerticalOperationContext;

export const catalogFoundationApi = HttpApi.make('CatalogApiFoundation').add(
  HttpApiGroup.make('foundation').add(
    HttpApiEndpoint.get('readiness', '/catalog/readiness', {
      success: catalogReadinessSchema,
    }),
  ),
);

type GroupsOf<Api> = Api extends HttpApi.HttpApi<string, infer Groups> ? Groups : never;

type CatalogApiGroups = GroupsOf<
  | typeof catalogFoundationApi
  | typeof ActivateLocalOverrideActionApi
  | typeof ActivateLocalOverrideRecoveryApi
  | typeof ActivatePackageDefinitionActionApi
  | typeof ActivatePackageDefinitionRecoveryApi
  | typeof ActivatePackageOptionActionApi
  | typeof ActivatePackageOptionRecoveryApi
  | typeof AddProductCategoryAssignmentActionApi
  | typeof AddProductCategoryAssignmentRecoveryApi
  | typeof AssertSizeEquivalenceActionApi
  | typeof AssertSizeEquivalenceRecoveryApi
  | typeof AssignCatalogMediaActionApi
  | typeof AssignCatalogMediaRecoveryApi
  | typeof AssignSkuActionApi
  | typeof AssignSkuRecoveryApi
  | typeof BrandCurrentApi
  | typeof BrandHistoryApi
  | typeof CatalogDocumentCurrentApi
  | typeof CatalogMediaCurrentApi
  | typeof CatalogSourceResolutionApi
  | typeof ChangeLocalOverrideActionApi
  | typeof ChangeLocalOverrideRecoveryApi
  | typeof ChangeProductManufacturerActionApi
  | typeof ChangeProductManufacturerRecoveryApi
  | typeof ChangeProductRelationshipActionApi
  | typeof ChangeProductRelationshipRecoveryApi
  | typeof ChangeVariantActionApi
  | typeof ChangeVariantRecoveryApi
  | typeof ColorCurrentApi
  | typeof ColorHistoryApi
  | typeof ConfirmGtinActionApi
  | typeof ConfirmGtinRecoveryApi
  | typeof ConfirmVariantCombinationActionApi
  | typeof ConfirmVariantCombinationRecoveryApi
  | typeof CorrectGtinActionApi
  | typeof CorrectGtinRecoveryApi
  | typeof CorrectProductActionApi
  | typeof CorrectProductRecoveryApi
  | typeof CorrectSkuActionApi
  | typeof CorrectSkuRecoveryApi
  | typeof CreateAttributeDefinitionActionApi
  | typeof CreateAttributeDefinitionRecoveryApi
  | typeof CreateBrandActionApi
  | typeof CreateBrandRecoveryApi
  | typeof CreateConfigurationUnitActionApi
  | typeof CreateConfigurationUnitRecoveryApi
  | typeof CreateControlledAttributeValueActionApi
  | typeof CreateControlledAttributeValueRecoveryApi
  | typeof CreatePackageDefinitionActionApi
  | typeof CreatePackageDefinitionRecoveryApi
  | typeof CreateProductActionApi
  | typeof CreateProductCategoryActionApi
  | typeof CreateProductCategoryRecoveryApi
  | typeof CreateProductRecoveryApi
  | typeof CreateProductRelationshipActionApi
  | typeof CreateProductRelationshipRecoveryApi
  | typeof CreateProductTypeActionApi
  | typeof CreateProductTypeRecoveryApi
  | typeof CreateProductUnitActionApi
  | typeof CreateProductUnitRecoveryApi
  | typeof CreateSetCompositionActionApi
  | typeof CreateSetCompositionRecoveryApi
  | typeof CreateVariantActionApi
  | typeof CreateVariantRecoveryApi
  | typeof DecideProductTypeUnnecessaryActionApi
  | typeof DecideProductTypeUnnecessaryRecoveryApi
  | typeof EffectiveAttributeValuesCurrentApi
  | typeof ExternalTargetResolutionApi
  | typeof GovernProductAttributeApplicabilityActionApi
  | typeof GovernProductAttributeApplicabilityRecoveryApi
  | typeof GovernVariantAllowedValuesActionApi
  | typeof GovernVariantAllowedValuesRecoveryApi
  | typeof GovernVariantAxesActionApi
  | typeof GovernVariantAxesRecoveryApi
  | typeof GtinCurrentApi
  | typeof GtinHistoryApi
  | typeof ImportSourceAssertionActionApi
  | typeof ImportSourceAssertionRecoveryApi
  | typeof ListRecordedVariantsApi
  | typeof ManufacturerRelationCurrentApi
  | typeof ManufacturerRelationHistoryApi
  | typeof MarkGtinUnresolvedActionApi
  | typeof MarkGtinUnresolvedRecoveryApi
  | typeof MoveProductCategoryActionApi
  | typeof MoveProductCategoryRecoveryApi
  | typeof PackageDefinitionHistoryApi
  | typeof PackageOptionHistoryApi
  | typeof ProductBrandCurrentApi
  | typeof ProductBrandHistoryApi
  | typeof ProductCategoryClassificationApi
  | typeof ProductCategoryHistoryApi
  | typeof ProductDetailApi
  | typeof ProductHistoryApi
  | typeof ProductRelationshipCurrentApi
  | typeof ProductRelationshipHistoryApi
  | typeof ProductSizeCurrentApi
  | typeof PromotePackageDefinitionActionApi
  | typeof PromotePackageDefinitionRecoveryApi
  | typeof PublishProductConfigurationActionApi
  | typeof PublishProductConfigurationRecoveryApi
  | typeof QuantityPreparationApi
  | typeof ReactivateBrandActionApi
  | typeof ReactivateBrandRecoveryApi
  | typeof ReactivateControlledAttributeValueActionApi
  | typeof ReactivateControlledAttributeValueRecoveryApi
  | typeof ReactivateProductActionApi
  | typeof ReactivateProductRecoveryApi
  | typeof ReactivateVariantActionApi
  | typeof ReactivateVariantRecoveryApi
  | typeof ReleaseLocalOverrideActionApi
  | typeof ReleaseLocalOverrideRecoveryApi
  | typeof RemoveCatalogMediaActionApi
  | typeof RemoveCatalogMediaRecoveryApi
  | typeof RemoveProductAttributeValuesActionApi
  | typeof RemoveProductAttributeValuesRecoveryApi
  | typeof RemoveProductCategoryAssignmentActionApi
  | typeof RemoveProductCategoryAssignmentRecoveryApi
  | typeof RemoveProductLocalizedFactsActionApi
  | typeof RemoveProductLocalizedFactsRecoveryApi
  | typeof RemoveProductManufacturerActionApi
  | typeof RemoveProductManufacturerRecoveryApi
  | typeof RemoveProductRelationshipActionApi
  | typeof RemoveProductRelationshipRecoveryApi
  | typeof RemoveVariantAttributeOverrideActionApi
  | typeof RemoveVariantAttributeOverrideRecoveryApi
  | typeof RemoveVariantLocalizedFactsActionApi
  | typeof RemoveVariantLocalizedFactsRecoveryApi
  | typeof RenameAttributeDefinitionActionApi
  | typeof RenameAttributeDefinitionRecoveryApi
  | typeof RenameBrandActionApi
  | typeof RenameBrandRecoveryApi
  | typeof RenameControlledAttributeValueActionApi
  | typeof RenameControlledAttributeValueRecoveryApi
  | typeof RenameProductCategoryActionApi
  | typeof RenameProductCategoryRecoveryApi
  | typeof RenameSkuActionApi
  | typeof RenameSkuRecoveryApi
  | typeof ReorderCatalogMediaActionApi
  | typeof ReorderCatalogMediaRecoveryApi
  | typeof ReplaceProductSizesActionApi
  | typeof ReplaceProductSizesRecoveryApi
  | typeof RetireBrandActionApi
  | typeof RetireBrandRecoveryApi
  | typeof RetireConfigurationUnitActionApi
  | typeof RetireConfigurationUnitRecoveryApi
  | typeof RetireControlledAttributeValueActionApi
  | typeof RetireControlledAttributeValueRecoveryApi
  | typeof RetireGtinActionApi
  | typeof RetireGtinRecoveryApi
  | typeof RetirePackageDefinitionActionApi
  | typeof RetirePackageDefinitionRecoveryApi
  | typeof RetirePackageOptionActionApi
  | typeof RetirePackageOptionRecoveryApi
  | typeof RetireProductActionApi
  | typeof RetireProductCategoryActionApi
  | typeof RetireProductCategoryRecoveryApi
  | typeof RetireProductRecoveryApi
  | typeof RetireProductUnitActionApi
  | typeof RetireProductUnitRecoveryApi
  | typeof RetireVariantActionApi
  | typeof RetireVariantRecoveryApi
  | typeof ReviseAttributeDefinitionActionApi
  | typeof ReviseAttributeDefinitionRecoveryApi
  | typeof ReviseConfigurationUnitActionApi
  | typeof ReviseConfigurationUnitRecoveryApi
  | typeof RevisePackageDefinitionActionApi
  | typeof RevisePackageDefinitionRecoveryApi
  | typeof ReviseProductTypeActionApi
  | typeof ReviseProductTypeRecoveryApi
  | typeof ReviseProductUnitActionApi
  | typeof ReviseProductUnitRecoveryApi
  | typeof ReviseSetCompositionActionApi
  | typeof ReviseSetCompositionRecoveryApi
  | typeof SelectionEvidenceApi
  | typeof SetCompositionCurrentApi
  | typeof SetCompositionHistoryApi
  | typeof SetProductAttributeValuesActionApi
  | typeof SetProductAttributeValuesRecoveryApi
  | typeof SetProductBrandActionApi
  | typeof SetProductBrandRecoveryApi
  | typeof SetProductLocalizedFactsActionApi
  | typeof SetProductLocalizedFactsRecoveryApi
  | typeof SetProductManufacturerActionApi
  | typeof SetProductManufacturerRecoveryApi
  | typeof SetProductTypeActionApi
  | typeof SetProductTypeRecoveryApi
  | typeof SetProductUnitTargetDivisibilityActionApi
  | typeof SetProductUnitTargetDivisibilityRecoveryApi
  | typeof SetVariantAttributeOverrideActionApi
  | typeof SetVariantAttributeOverrideRecoveryApi
  | typeof SetVariantLocalizedFactsActionApi
  | typeof SetVariantLocalizedFactsRecoveryApi
  | typeof SkuLookupApi
  | typeof UpdateProductActionApi
  | typeof UpdateProductRecoveryApi
  | typeof VariantHistoryApi
>;

type CatalogApi = HttpApi.HttpApi<'CatalogApi', CatalogApiGroups>;

export const catalogApi: CatalogApi = HttpApi.make('CatalogApi')
  .addHttpApi(catalogFoundationApi)
  // <generated-governed-http-api-additions>
  .addHttpApi(ActivateLocalOverrideActionApi)
  .addHttpApi(ActivateLocalOverrideRecoveryApi)
  .addHttpApi(ActivatePackageDefinitionActionApi)
  .addHttpApi(ActivatePackageDefinitionRecoveryApi)
  .addHttpApi(ActivatePackageOptionActionApi)
  .addHttpApi(ActivatePackageOptionRecoveryApi)
  .addHttpApi(AddProductCategoryAssignmentActionApi)
  .addHttpApi(AddProductCategoryAssignmentRecoveryApi)
  .addHttpApi(AssertSizeEquivalenceActionApi)
  .addHttpApi(AssertSizeEquivalenceRecoveryApi)
  .addHttpApi(AssignCatalogMediaActionApi)
  .addHttpApi(AssignCatalogMediaRecoveryApi)
  .addHttpApi(AssignSkuActionApi)
  .addHttpApi(AssignSkuRecoveryApi)
  .addHttpApi(BrandCurrentApi)
  .addHttpApi(BrandHistoryApi)
  .addHttpApi(CatalogDocumentCurrentApi)
  .addHttpApi(CatalogMediaCurrentApi)
  .addHttpApi(CatalogSourceResolutionApi)
  .addHttpApi(ChangeLocalOverrideActionApi)
  .addHttpApi(ChangeLocalOverrideRecoveryApi)
  .addHttpApi(ChangeProductManufacturerActionApi)
  .addHttpApi(ChangeProductManufacturerRecoveryApi)
  .addHttpApi(ChangeProductRelationshipActionApi)
  .addHttpApi(ChangeProductRelationshipRecoveryApi)
  .addHttpApi(ChangeVariantActionApi)
  .addHttpApi(ChangeVariantRecoveryApi)
  .addHttpApi(ColorCurrentApi)
  .addHttpApi(ColorHistoryApi)
  .addHttpApi(ConfirmGtinActionApi)
  .addHttpApi(ConfirmGtinRecoveryApi)
  .addHttpApi(ConfirmVariantCombinationActionApi)
  .addHttpApi(ConfirmVariantCombinationRecoveryApi)
  .addHttpApi(CorrectGtinActionApi)
  .addHttpApi(CorrectGtinRecoveryApi)
  .addHttpApi(CorrectProductActionApi)
  .addHttpApi(CorrectProductRecoveryApi)
  .addHttpApi(CorrectSkuActionApi)
  .addHttpApi(CorrectSkuRecoveryApi)
  .addHttpApi(CreateAttributeDefinitionActionApi)
  .addHttpApi(CreateAttributeDefinitionRecoveryApi)
  .addHttpApi(CreateBrandActionApi)
  .addHttpApi(CreateBrandRecoveryApi)
  .addHttpApi(CreateConfigurationUnitActionApi)
  .addHttpApi(CreateConfigurationUnitRecoveryApi)
  .addHttpApi(CreateControlledAttributeValueActionApi)
  .addHttpApi(CreateControlledAttributeValueRecoveryApi)
  .addHttpApi(CreatePackageDefinitionActionApi)
  .addHttpApi(CreatePackageDefinitionRecoveryApi)
  .addHttpApi(CreateProductActionApi)
  .addHttpApi(CreateProductCategoryActionApi)
  .addHttpApi(CreateProductCategoryRecoveryApi)
  .addHttpApi(CreateProductRecoveryApi)
  .addHttpApi(CreateProductRelationshipActionApi)
  .addHttpApi(CreateProductRelationshipRecoveryApi)
  .addHttpApi(CreateProductTypeActionApi)
  .addHttpApi(CreateProductTypeRecoveryApi)
  .addHttpApi(CreateProductUnitActionApi)
  .addHttpApi(CreateProductUnitRecoveryApi)
  .addHttpApi(CreateSetCompositionActionApi)
  .addHttpApi(CreateSetCompositionRecoveryApi)
  .addHttpApi(CreateVariantActionApi)
  .addHttpApi(CreateVariantRecoveryApi)
  .addHttpApi(DecideProductTypeUnnecessaryActionApi)
  .addHttpApi(DecideProductTypeUnnecessaryRecoveryApi)
  .addHttpApi(EffectiveAttributeValuesCurrentApi)
  .addHttpApi(ExternalTargetResolutionApi)
  .addHttpApi(GovernProductAttributeApplicabilityActionApi)
  .addHttpApi(GovernProductAttributeApplicabilityRecoveryApi)
  .addHttpApi(GovernVariantAllowedValuesActionApi)
  .addHttpApi(GovernVariantAllowedValuesRecoveryApi)
  .addHttpApi(GovernVariantAxesActionApi)
  .addHttpApi(GovernVariantAxesRecoveryApi)
  .addHttpApi(GtinCurrentApi)
  .addHttpApi(GtinHistoryApi)
  .addHttpApi(ImportSourceAssertionActionApi)
  .addHttpApi(ImportSourceAssertionRecoveryApi)
  .addHttpApi(ListRecordedVariantsApi)
  .addHttpApi(ManufacturerRelationCurrentApi)
  .addHttpApi(ManufacturerRelationHistoryApi)
  .addHttpApi(MarkGtinUnresolvedActionApi)
  .addHttpApi(MarkGtinUnresolvedRecoveryApi)
  .addHttpApi(MoveProductCategoryActionApi)
  .addHttpApi(MoveProductCategoryRecoveryApi)
  .addHttpApi(PackageDefinitionHistoryApi)
  .addHttpApi(PackageOptionHistoryApi)
  .addHttpApi(ProductBrandCurrentApi)
  .addHttpApi(ProductBrandHistoryApi)
  .addHttpApi(ProductCategoryClassificationApi)
  .addHttpApi(ProductCategoryHistoryApi)
  .addHttpApi(ProductDetailApi)
  .addHttpApi(ProductHistoryApi)
  .addHttpApi(ProductRelationshipCurrentApi)
  .addHttpApi(ProductRelationshipHistoryApi)
  .addHttpApi(ProductSizeCurrentApi)
  .addHttpApi(PromotePackageDefinitionActionApi)
  .addHttpApi(PromotePackageDefinitionRecoveryApi)
  .addHttpApi(PublishProductConfigurationActionApi)
  .addHttpApi(PublishProductConfigurationRecoveryApi)
  .addHttpApi(QuantityPreparationApi)
  .addHttpApi(ReactivateBrandActionApi)
  .addHttpApi(ReactivateBrandRecoveryApi)
  .addHttpApi(ReactivateControlledAttributeValueActionApi)
  .addHttpApi(ReactivateControlledAttributeValueRecoveryApi)
  .addHttpApi(ReactivateProductActionApi)
  .addHttpApi(ReactivateProductRecoveryApi)
  .addHttpApi(ReactivateVariantActionApi)
  .addHttpApi(ReactivateVariantRecoveryApi)
  .addHttpApi(ReleaseLocalOverrideActionApi)
  .addHttpApi(ReleaseLocalOverrideRecoveryApi)
  .addHttpApi(RemoveCatalogMediaActionApi)
  .addHttpApi(RemoveCatalogMediaRecoveryApi)
  .addHttpApi(RemoveProductAttributeValuesActionApi)
  .addHttpApi(RemoveProductAttributeValuesRecoveryApi)
  .addHttpApi(RemoveProductCategoryAssignmentActionApi)
  .addHttpApi(RemoveProductCategoryAssignmentRecoveryApi)
  .addHttpApi(RemoveProductLocalizedFactsActionApi)
  .addHttpApi(RemoveProductLocalizedFactsRecoveryApi)
  .addHttpApi(RemoveProductManufacturerActionApi)
  .addHttpApi(RemoveProductManufacturerRecoveryApi)
  .addHttpApi(RemoveProductRelationshipActionApi)
  .addHttpApi(RemoveProductRelationshipRecoveryApi)
  .addHttpApi(RemoveVariantAttributeOverrideActionApi)
  .addHttpApi(RemoveVariantAttributeOverrideRecoveryApi)
  .addHttpApi(RemoveVariantLocalizedFactsActionApi)
  .addHttpApi(RemoveVariantLocalizedFactsRecoveryApi)
  .addHttpApi(RenameAttributeDefinitionActionApi)
  .addHttpApi(RenameAttributeDefinitionRecoveryApi)
  .addHttpApi(RenameBrandActionApi)
  .addHttpApi(RenameBrandRecoveryApi)
  .addHttpApi(RenameControlledAttributeValueActionApi)
  .addHttpApi(RenameControlledAttributeValueRecoveryApi)
  .addHttpApi(RenameProductCategoryActionApi)
  .addHttpApi(RenameProductCategoryRecoveryApi)
  .addHttpApi(RenameSkuActionApi)
  .addHttpApi(RenameSkuRecoveryApi)
  .addHttpApi(ReorderCatalogMediaActionApi)
  .addHttpApi(ReorderCatalogMediaRecoveryApi)
  .addHttpApi(ReplaceProductSizesActionApi)
  .addHttpApi(ReplaceProductSizesRecoveryApi)
  .addHttpApi(RetireBrandActionApi)
  .addHttpApi(RetireBrandRecoveryApi)
  .addHttpApi(RetireConfigurationUnitActionApi)
  .addHttpApi(RetireConfigurationUnitRecoveryApi)
  .addHttpApi(RetireControlledAttributeValueActionApi)
  .addHttpApi(RetireControlledAttributeValueRecoveryApi)
  .addHttpApi(RetireGtinActionApi)
  .addHttpApi(RetireGtinRecoveryApi)
  .addHttpApi(RetirePackageDefinitionActionApi)
  .addHttpApi(RetirePackageDefinitionRecoveryApi)
  .addHttpApi(RetirePackageOptionActionApi)
  .addHttpApi(RetirePackageOptionRecoveryApi)
  .addHttpApi(RetireProductActionApi)
  .addHttpApi(RetireProductCategoryActionApi)
  .addHttpApi(RetireProductCategoryRecoveryApi)
  .addHttpApi(RetireProductRecoveryApi)
  .addHttpApi(RetireProductUnitActionApi)
  .addHttpApi(RetireProductUnitRecoveryApi)
  .addHttpApi(RetireVariantActionApi)
  .addHttpApi(RetireVariantRecoveryApi)
  .addHttpApi(ReviseAttributeDefinitionActionApi)
  .addHttpApi(ReviseAttributeDefinitionRecoveryApi)
  .addHttpApi(ReviseConfigurationUnitActionApi)
  .addHttpApi(ReviseConfigurationUnitRecoveryApi)
  .addHttpApi(RevisePackageDefinitionActionApi)
  .addHttpApi(RevisePackageDefinitionRecoveryApi)
  .addHttpApi(ReviseProductTypeActionApi)
  .addHttpApi(ReviseProductTypeRecoveryApi)
  .addHttpApi(ReviseProductUnitActionApi)
  .addHttpApi(ReviseProductUnitRecoveryApi)
  .addHttpApi(ReviseSetCompositionActionApi)
  .addHttpApi(ReviseSetCompositionRecoveryApi)
  .addHttpApi(SelectionEvidenceApi)
  .addHttpApi(SetCompositionCurrentApi)
  .addHttpApi(SetCompositionHistoryApi)
  .addHttpApi(SetProductAttributeValuesActionApi)
  .addHttpApi(SetProductAttributeValuesRecoveryApi)
  .addHttpApi(SetProductBrandActionApi)
  .addHttpApi(SetProductBrandRecoveryApi)
  .addHttpApi(SetProductLocalizedFactsActionApi)
  .addHttpApi(SetProductLocalizedFactsRecoveryApi)
  .addHttpApi(SetProductManufacturerActionApi)
  .addHttpApi(SetProductManufacturerRecoveryApi)
  .addHttpApi(SetProductTypeActionApi)
  .addHttpApi(SetProductTypeRecoveryApi)
  .addHttpApi(SetProductUnitTargetDivisibilityActionApi)
  .addHttpApi(SetProductUnitTargetDivisibilityRecoveryApi)
  .addHttpApi(SetVariantAttributeOverrideActionApi)
  .addHttpApi(SetVariantAttributeOverrideRecoveryApi)
  .addHttpApi(SetVariantLocalizedFactsActionApi)
  .addHttpApi(SetVariantLocalizedFactsRecoveryApi)
  .addHttpApi(SkuLookupApi)
  .addHttpApi(UpdateProductActionApi)
  .addHttpApi(UpdateProductRecoveryApi)
  .addHttpApi(VariantHistoryApi)
  // </generated-governed-http-api-additions>
  .pipe(identity);

export const catalogOperationContexts = {
  readiness: createMicroVerticalOperationContext({
    method: 'GET',
    operationId: 'CatalogApi:catalog:readiness',
    routePath: '/catalog/readiness',
  }),
} satisfies Record<string, OperationContext>;

export const catalogApiContract = {
  apiPrefix: '/catalog-api',
  basePath: '/catalog-api/catalog',
  ownerId: 'catalog',
  readinessPath: '/catalog-api/catalog/readiness',
} as const;

/**
 * Versioned Catalog operation inventory. Each key is an atomic Core authorization
 * identity, not a runtime role check. Bundles are provisioning aids only: adding
 * an operation here never grants it to an existing Principal. `scope` names the
 * Core authorization boundary; `businessTarget` names the Product domain target.
 * Catalog authorizes reads by explicit context permission and Actions by
 * Action executor grants. `scope` is the tenant entrypoint boundary; a read
 * may additionally declare a module permission target or resource check.
 * `businessTarget: 'product'` does not imply a per-Product SpiceDB grant.
 * Owner-local tenant guards still apply.
 * Import and Local Override permissions remain separate so deployments can grant source ingestion
 * without granting authority to replace Catalog Current facts.
 */
const productCategoryBusinessTarget = 'product-category';
const attributeDefinitionBusinessTarget = 'attribute-definition';
const controlledAttributeValueBusinessTarget = 'controlled-attribute-value';
const packageDefinitionBusinessTarget = 'package-definition';
const productRelationshipBusinessTarget = 'product-relationship';
const productUnitBusinessTarget = 'product-unit';
const configurationUnitBusinessTarget = 'configuration-unit';
const brandBusinessTarget = 'brand';
const manufacturerRelationBusinessTarget = 'manufacturer-relation';
const productTypeBusinessTarget = 'product-type';
const setCompositionBusinessTarget = 'set-composition';
const catalogSourceBusinessTarget = 'catalog-source';

export const catalogPublicOperationContracts = {
  'commerce.catalog.activate-local-override': {
    authorityBundle: 'CATALOG_OVERRIDE_MANAGER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.activate-local-override',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.activate-package-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.activate-package-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.activate-package-option': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.activate-package-option',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.add-product-category-assignment': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.add-product-category-assignment',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.activate-local-override-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.activate-local-override-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.activate-package-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.activate-package-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.activate-package-option-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.activate-package-option-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.add-product-category-assignment-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.add-product-category-assignment-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.assert-size-equivalence-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'size-equivalence',
    permission: 'commerce.catalog.read.assert-size-equivalence-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.assign-catalog-media-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.assign-catalog-media-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.assign-sku-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.assign-sku-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.brand-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.brand-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.brand-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.brand-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.catalog-document-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'catalog-document',
    permission: 'commerce.catalog.read.catalog-document-current',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.catalog-media-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'catalog-media',
    permission: 'commerce.catalog.read.media',
    permissionKind: 'context_permission',
    permissionTarget: 'resource',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.catalog-source-resolution': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.catalog-source-resolution',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.change-local-override-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.change-local-override-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.change-product-manufacturer-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.change-product-manufacturer-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.change-product-relationship-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.read.change-product-relationship-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.change-variant-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.change-variant-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.color-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.color-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.color-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.color-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.confirm-gtin-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.confirm-gtin-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.confirm-variant-combination-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.confirm-variant-combination-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.correct-gtin-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.correct-gtin-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.correct-product-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.correct-product-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.correct-sku-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.correct-sku-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-attribute-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.create-attribute-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-brand-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.create-brand-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-configuration-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.read.create-configuration-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-controlled-attribute-value-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.create-controlled-attribute-value-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-package-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.create-package-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-product-category-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.create-product-category-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-product-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.create-product-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-product-relationship-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.read.create-product-relationship-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-product-type-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productTypeBusinessTarget,
    permission: 'commerce.catalog.read.create-product-type-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-product-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.read.create-product-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-set-composition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.read.create-set-composition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.create-variant-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.create-variant-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.decide-product-type-unnecessary-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.decide-product-type-unnecessary-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.effective-attribute-values-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.effective-attribute-values-current',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.external-target-resolution': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.external-target-resolution',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.govern-product-attribute-applicability-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.govern-product-attribute-applicability-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.govern-variant-allowed-values-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.govern-variant-allowed-values-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.govern-variant-axes-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.govern-variant-axes-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.gtin-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.gtin-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.gtin-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.gtin-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.import-source-assertion-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.import-source-assertion-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.list-recorded-variants': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.list-recorded-variants',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.manufacturer-relation-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: manufacturerRelationBusinessTarget,
    permission: 'commerce.catalog.read.manufacturer-relation-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.manufacturer-relation-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: manufacturerRelationBusinessTarget,
    permission: 'commerce.catalog.read.manufacturer-relation-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.mark-gtin-unresolved-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.mark-gtin-unresolved-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.move-product-category-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.move-product-category-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.package-definition-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.package-definition-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.package-option-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.package-option-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-brand-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.product-brand-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-brand-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.product-brand-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-category-classification': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.product-category-classification',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-category-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.product-category-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-detail': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.product-detail',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.product-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-relationship-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.read.product-relationship',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-relationship-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.read.product-relationship-history',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.product-size-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.product-size-current',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.promote-package-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.promote-package-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.publish-product-configuration-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.publish-product-configuration-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.quantity-preparation': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.quantity-preparation',
    permissionKind: 'context_permission',
    permissionTarget: 'resource',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.reactivate-brand-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.reactivate-brand-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.reactivate-controlled-attribute-value-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.reactivate-controlled-attribute-value-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.reactivate-product-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.reactivate-product-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.reactivate-variant-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.reactivate-variant-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.release-local-override-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.read.release-local-override-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-catalog-media-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.remove-catalog-media-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-product-attribute-values-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.remove-product-attribute-values-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-product-category-assignment-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.remove-product-category-assignment-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-product-localized-facts-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.remove-product-localized-facts-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-product-manufacturer-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: manufacturerRelationBusinessTarget,
    permission: 'commerce.catalog.read.remove-product-manufacturer-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-product-relationship-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.read.remove-product-relationship-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-variant-attribute-override-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.remove-variant-attribute-override-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.remove-variant-localized-facts-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.remove-variant-localized-facts-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.rename-attribute-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.rename-attribute-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.rename-brand-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.rename-brand-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.rename-controlled-attribute-value-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.rename-controlled-attribute-value-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.rename-product-category-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.rename-product-category-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.rename-sku-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.rename-sku-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.reorder-catalog-media-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.reorder-catalog-media-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.replace-product-sizes-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.replace-product-sizes-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-brand-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.read.retire-brand-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-configuration-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.read.retire-configuration-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-controlled-attribute-value-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.read.retire-controlled-attribute-value-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-gtin-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.retire-gtin-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-package-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.retire-package-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-package-option-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.retire-package-option-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-product-category-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.read.retire-product-category-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-product-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.retire-product-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-product-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.read.retire-product-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.retire-variant-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.retire-variant-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-attribute-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.revise-attribute-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-configuration-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.read.revise-configuration-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-package-definition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.read.revise-package-definition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-product-type-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productTypeBusinessTarget,
    permission: 'commerce.catalog.read.revise-product-type-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-product-unit-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.read.revise-product-unit-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.revise-set-composition-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.read.revise-set-composition-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.selection-evidence': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'selection-evidence',
    permission: 'commerce.catalog.read.selection-evidence',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-composition-current': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.read.set-composition-current',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-composition-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.read.set-composition-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-attribute-values-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.set-product-attribute-values-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-brand-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.set-product-brand-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-localized-facts-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.set-product-localized-facts-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-manufacturer-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.set-product-manufacturer-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-type-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.set-product-type-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-product-unit-target-divisibility-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product-unit',
    permission: 'commerce.catalog.read.set-product-unit-target-divisibility-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-variant-attribute-override-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.set-variant-attribute-override-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.set-variant-localized-facts-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.set-variant-localized-facts-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.sku-lookup': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.sku-lookup',
    permissionKind: 'context_permission',
    permissionTarget: 'module',
    resourcePermission: 'read',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.update-product-recovery': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'product',
    permission: 'commerce.catalog.read.update-product-recovery',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.api.variant-history': {
    authorityBundle: 'CATALOG_READER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.read.variant-history',
    permissionKind: 'context_permission',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.assert-size-equivalence': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: 'size-equivalence',
    permission: 'commerce.catalog.assert-size-equivalence',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.assign-catalog-media': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.assign-catalog-media',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.assign-sku': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.assign-sku',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.change-local-override': {
    authorityBundle: 'CATALOG_OVERRIDE_MANAGER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.change-local-override',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.change-product-manufacturer': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.change-product-manufacturer',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.change-product-relationship': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.change-product-relationship',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.change-variant': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.change-variant',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.confirm-gtin': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.confirm-gtin',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.confirm-variant-combination': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.confirm-variant-combination',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.correct-gtin': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.correct-gtin',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.correct-product': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.correct-product',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.correct-sku': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.correct-sku',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-attribute-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.create-attribute-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-brand': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.create-brand',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-configuration-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.create-configuration-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-controlled-attribute-value': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.create-controlled-attribute-value',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-package-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.create-package-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-product': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.create-product',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-product-category': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.create-product-category',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-product-relationship': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.create-product-relationship',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-product-type': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productTypeBusinessTarget,
    permission: 'commerce.catalog.create-product-type',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-product-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.create-product-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-set-composition': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.create-set-composition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.create-variant': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.create-variant',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.decide-product-type-unnecessary': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.decide-product-type-unnecessary',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.govern-product-attribute-applicability': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.govern-product-attribute-applicability',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.govern-variant-allowed-values': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.govern-variant-allowed-values',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.govern-variant-axes': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.govern-variant-axes',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.import-source-assertion': {
    authorityBundle: 'CATALOG_IMPORTER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.import-source-assertion',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.mark-gtin-unresolved': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.mark-gtin-unresolved',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.move-product-category': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.move-product-category',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.promote-package-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.promote-package-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.publish-product-configuration': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.publish-product-configuration',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.reactivate-brand': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.reactivate-brand',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.reactivate-controlled-attribute-value': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.reactivate-controlled-attribute-value',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.reactivate-product': {
    authorityBundle: 'CATALOG_LIFECYCLE_MANAGER',
    businessTarget: 'product',
    permission: 'commerce.catalog.reactivate-product',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.reactivate-variant': {
    authorityBundle: 'CATALOG_LIFECYCLE_MANAGER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.reactivate-variant',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.release-local-override': {
    authorityBundle: 'CATALOG_OVERRIDE_MANAGER',
    businessTarget: catalogSourceBusinessTarget,
    permission: 'commerce.catalog.release-local-override',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-catalog-media': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.remove-catalog-media',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-product-attribute-values': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.remove-product-attribute-values',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-product-category-assignment': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.remove-product-category-assignment',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-product-localized-facts': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.remove-product-localized-facts',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-product-manufacturer': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.remove-product-manufacturer',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-product-relationship': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: productRelationshipBusinessTarget,
    permission: 'commerce.catalog.remove-product-relationship',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-variant-attribute-override': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.remove-variant-attribute-override',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.remove-variant-localized-facts': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.remove-variant-localized-facts',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.rename-attribute-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.rename-attribute-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.rename-brand': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.rename-brand',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.rename-controlled-attribute-value': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.rename-controlled-attribute-value',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.rename-product-category': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.rename-product-category',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.rename-sku': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.rename-sku',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.reorder-catalog-media': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.reorder-catalog-media',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.replace-product-sizes': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.replace-product-sizes',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-brand': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: brandBusinessTarget,
    permission: 'commerce.catalog.retire-brand',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-configuration-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.retire-configuration-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-controlled-attribute-value': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: controlledAttributeValueBusinessTarget,
    permission: 'commerce.catalog.retire-controlled-attribute-value',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-gtin': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.retire-gtin',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-package-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.retire-package-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-package-option': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.retire-package-option',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-product': {
    authorityBundle: 'CATALOG_LIFECYCLE_MANAGER',
    businessTarget: 'product',
    permission: 'commerce.catalog.retire-product',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-product-category': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productCategoryBusinessTarget,
    permission: 'commerce.catalog.retire-product-category',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-product-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.retire-product-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.retire-variant': {
    authorityBundle: 'CATALOG_LIFECYCLE_MANAGER',
    businessTarget: 'variant',
    permission: 'commerce.catalog.retire-variant',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-attribute-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: attributeDefinitionBusinessTarget,
    permission: 'commerce.catalog.revise-attribute-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-configuration-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: configurationUnitBusinessTarget,
    permission: 'commerce.catalog.revise-configuration-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-package-definition': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: packageDefinitionBusinessTarget,
    permission: 'commerce.catalog.revise-package-definition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-product-type': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productTypeBusinessTarget,
    permission: 'commerce.catalog.revise-product-type',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-product-unit': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.revise-product-unit',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.revise-set-composition': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: setCompositionBusinessTarget,
    permission: 'commerce.catalog.revise-set-composition',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-attribute-values': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.set-product-attribute-values',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-brand': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.set-product-brand',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-localized-facts': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.set-product-localized-facts',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-manufacturer': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.set-product-manufacturer',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-type': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.set-product-type',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-product-unit-target-divisibility': {
    authorityBundle: 'CATALOG_DEFINITION_MANAGER',
    businessTarget: productUnitBusinessTarget,
    permission: 'commerce.catalog.set-product-unit-target-divisibility',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-variant-attribute-override': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.set-variant-attribute-override',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.set-variant-localized-facts': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'variant',
    permission: 'commerce.catalog.set-variant-localized-facts',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
  'commerce.catalog.update-product': {
    authorityBundle: 'PRODUCT_EDITOR',
    businessTarget: 'product',
    permission: 'commerce.catalog.update-product',
    permissionKind: 'action_execution',
    scope: 'tenant',
    version: '1',
  },
} as const;

export const catalogAuthorityBundles = {
  CATALOG_DEFINITION_MANAGER: [
    'commerce.catalog.activate-package-definition',
    'commerce.catalog.activate-package-option',
    'commerce.catalog.assert-size-equivalence',
    'commerce.catalog.create-attribute-definition',
    'commerce.catalog.create-brand',
    'commerce.catalog.create-configuration-unit',
    'commerce.catalog.create-controlled-attribute-value',
    'commerce.catalog.create-package-definition',
    'commerce.catalog.create-product-category',
    'commerce.catalog.create-product-type',
    'commerce.catalog.create-product-unit',
    'commerce.catalog.move-product-category',
    'commerce.catalog.promote-package-definition',
    'commerce.catalog.reactivate-brand',
    'commerce.catalog.reactivate-controlled-attribute-value',
    'commerce.catalog.rename-attribute-definition',
    'commerce.catalog.rename-brand',
    'commerce.catalog.rename-controlled-attribute-value',
    'commerce.catalog.rename-product-category',
    'commerce.catalog.retire-brand',
    'commerce.catalog.retire-configuration-unit',
    'commerce.catalog.retire-controlled-attribute-value',
    'commerce.catalog.retire-package-definition',
    'commerce.catalog.retire-package-option',
    'commerce.catalog.retire-product-category',
    'commerce.catalog.retire-product-unit',
    'commerce.catalog.revise-attribute-definition',
    'commerce.catalog.revise-configuration-unit',
    'commerce.catalog.revise-package-definition',
    'commerce.catalog.revise-product-type',
    'commerce.catalog.revise-product-unit',
    'commerce.catalog.set-product-unit-target-divisibility',
  ],
  CATALOG_IMPORTER: ['commerce.catalog.import-source-assertion'],
  CATALOG_LIFECYCLE_MANAGER: [
    'commerce.catalog.reactivate-product',
    'commerce.catalog.reactivate-variant',
    'commerce.catalog.retire-product',
    'commerce.catalog.retire-variant',
  ],
  CATALOG_OVERRIDE_MANAGER: [
    'commerce.catalog.activate-local-override',
    'commerce.catalog.change-local-override',
    'commerce.catalog.release-local-override',
  ],
  CATALOG_READER: [
    'commerce.catalog.read.activate-local-override-recovery',
    'commerce.catalog.read.change-local-override-recovery',
    'commerce.catalog.read.import-source-assertion-recovery',
    'commerce.catalog.read.release-local-override-recovery',
    'commerce.catalog.read.catalog-document-current',
    'commerce.catalog.read.catalog-source-resolution',
    'commerce.catalog.read.external-target-resolution',
    'commerce.catalog.read.selection-evidence',
    'commerce.catalog.read.decide-product-type-unnecessary-recovery',
    'commerce.catalog.read.correct-sku-recovery',
    'commerce.catalog.read.correct-product-recovery',
    'commerce.catalog.read.correct-gtin-recovery',
    'commerce.catalog.read.confirm-gtin-recovery',
    'commerce.catalog.read.confirm-variant-combination-recovery',
    'commerce.catalog.read.change-variant-recovery',
    'commerce.catalog.read.change-product-relationship-recovery',
    'commerce.catalog.read.change-product-manufacturer-recovery',
    'commerce.catalog.read.assign-sku-recovery',
    'commerce.catalog.read.assign-catalog-media-recovery',
    'commerce.catalog.read.assert-size-equivalence-recovery',
    'commerce.catalog.read.add-product-category-assignment-recovery',
    'commerce.catalog.read.activate-package-option-recovery',
    'commerce.catalog.read.activate-package-definition-recovery',
    'commerce.catalog.read.create-attribute-definition-recovery',
    'commerce.catalog.read.create-brand-recovery',
    'commerce.catalog.read.create-configuration-unit-recovery',
    'commerce.catalog.read.create-controlled-attribute-value-recovery',
    'commerce.catalog.read.create-package-definition-recovery',
    'commerce.catalog.read.create-product-category-recovery',
    'commerce.catalog.read.create-product-relationship-recovery',
    'commerce.catalog.read.create-product-type-recovery',
    'commerce.catalog.read.create-product-unit-recovery',
    'commerce.catalog.read.create-set-composition-recovery',
    'commerce.catalog.read.revise-attribute-definition-recovery',
    'commerce.catalog.read.revise-configuration-unit-recovery',
    'commerce.catalog.read.revise-package-definition-recovery',
    'commerce.catalog.read.revise-product-type-recovery',
    'commerce.catalog.read.revise-product-unit-recovery',
    'commerce.catalog.read.revise-set-composition-recovery',
    'commerce.catalog.read.govern-product-attribute-applicability-recovery',
    'commerce.catalog.read.govern-variant-allowed-values-recovery',
    'commerce.catalog.read.govern-variant-axes-recovery',
    'commerce.catalog.read.mark-gtin-unresolved-recovery',
    'commerce.catalog.read.move-product-category-recovery',
    'commerce.catalog.read.promote-package-definition-recovery',
    'commerce.catalog.read.publish-product-configuration-recovery',
    'commerce.catalog.read.reactivate-brand-recovery',
    'commerce.catalog.read.reactivate-controlled-attribute-value-recovery',
    'commerce.catalog.read.reactivate-product-recovery',
    'commerce.catalog.read.reactivate-variant-recovery',
    'commerce.catalog.read.remove-catalog-media-recovery',
    'commerce.catalog.read.remove-product-attribute-values-recovery',
    'commerce.catalog.read.remove-product-category-assignment-recovery',
    'commerce.catalog.read.remove-product-localized-facts-recovery',
    'commerce.catalog.read.remove-product-manufacturer-recovery',
    'commerce.catalog.read.remove-product-relationship-recovery',
    'commerce.catalog.read.remove-variant-attribute-override-recovery',
    'commerce.catalog.read.remove-variant-localized-facts-recovery',
    'commerce.catalog.read.rename-attribute-definition-recovery',
    'commerce.catalog.read.rename-brand-recovery',
    'commerce.catalog.read.rename-controlled-attribute-value-recovery',
    'commerce.catalog.read.rename-product-category-recovery',
    'commerce.catalog.read.rename-sku-recovery',
    'commerce.catalog.read.reorder-catalog-media-recovery',
    'commerce.catalog.read.replace-product-sizes-recovery',
    'commerce.catalog.read.set-product-attribute-values-recovery',
    'commerce.catalog.read.set-product-brand-recovery',
    'commerce.catalog.read.set-product-localized-facts-recovery',
    'commerce.catalog.read.set-product-manufacturer-recovery',
    'commerce.catalog.read.set-product-type-recovery',
    'commerce.catalog.read.set-product-unit-target-divisibility-recovery',
    'commerce.catalog.read.set-variant-attribute-override-recovery',
    'commerce.catalog.read.set-variant-localized-facts-recovery',
    'commerce.catalog.read.retire-brand-recovery',
    'commerce.catalog.read.retire-configuration-unit-recovery',
    'commerce.catalog.read.retire-controlled-attribute-value-recovery',
    'commerce.catalog.read.retire-gtin-recovery',
    'commerce.catalog.read.retire-package-definition-recovery',
    'commerce.catalog.read.retire-package-option-recovery',
    'commerce.catalog.read.retire-product-recovery',
    'commerce.catalog.read.retire-product-category-recovery',
    'commerce.catalog.read.retire-product-unit-recovery',
    'commerce.catalog.read.retire-variant-recovery',
    'commerce.catalog.read.brand-current',
    'commerce.catalog.read.brand-history',
    'commerce.catalog.read.color-current',
    'commerce.catalog.read.color-history',
    'commerce.catalog.read.gtin-current',
    'commerce.catalog.read.gtin-history',
    'commerce.catalog.read.media',
    'commerce.catalog.read.manufacturer-relation-current',
    'commerce.catalog.read.manufacturer-relation-history',
    'commerce.catalog.read.create-product-recovery',
    'commerce.catalog.read.create-variant-recovery',
    'commerce.catalog.read.update-product-recovery',
    'commerce.catalog.read.product-category-classification',
    'commerce.catalog.read.product-category-history',
    'commerce.catalog.read.product-brand-current',
    'commerce.catalog.read.product-brand-history',
    'commerce.catalog.read.product-detail',
    'commerce.catalog.read.effective-attribute-values-current',
    'commerce.catalog.read.list-recorded-variants',
    'commerce.catalog.read.product-history',
    'commerce.catalog.read.variant-history',
    'commerce.catalog.read.package-definition-history',
    'commerce.catalog.read.package-option-history',
    'commerce.catalog.read.set-composition-current',
    'commerce.catalog.read.set-composition-history',
    'commerce.catalog.read.product-size-current',
    'commerce.catalog.read.product-relationship',
    'commerce.catalog.read.product-relationship-history',
    'commerce.catalog.read.quantity-preparation',
    'commerce.catalog.read.sku-lookup',
  ],
  PRODUCT_EDITOR: [
    'commerce.catalog.add-product-category-assignment',
    'commerce.catalog.assign-catalog-media',
    'commerce.catalog.assign-sku',
    'commerce.catalog.change-product-manufacturer',
    'commerce.catalog.change-product-relationship',
    'commerce.catalog.change-variant',
    'commerce.catalog.confirm-gtin',
    'commerce.catalog.confirm-variant-combination',
    'commerce.catalog.correct-gtin',
    'commerce.catalog.create-product',
    'commerce.catalog.create-product-relationship',
    'commerce.catalog.correct-product',
    'commerce.catalog.correct-sku',
    'commerce.catalog.create-set-composition',
    'commerce.catalog.create-variant',
    'commerce.catalog.decide-product-type-unnecessary',
    'commerce.catalog.govern-product-attribute-applicability',
    'commerce.catalog.govern-variant-allowed-values',
    'commerce.catalog.govern-variant-axes',
    'commerce.catalog.mark-gtin-unresolved',
    'commerce.catalog.remove-product-attribute-values',
    'commerce.catalog.remove-catalog-media',
    'commerce.catalog.remove-product-category-assignment',
    'commerce.catalog.remove-product-localized-facts',
    'commerce.catalog.remove-product-manufacturer',
    'commerce.catalog.remove-product-relationship',
    'commerce.catalog.remove-variant-attribute-override',
    'commerce.catalog.remove-variant-localized-facts',
    'commerce.catalog.publish-product-configuration',
    'commerce.catalog.replace-product-sizes',
    'commerce.catalog.rename-sku',
    'commerce.catalog.reorder-catalog-media',
    'commerce.catalog.revise-set-composition',
    'commerce.catalog.retire-gtin',
    'commerce.catalog.set-product-attribute-values',
    'commerce.catalog.set-product-brand',
    'commerce.catalog.set-product-localized-facts',
    'commerce.catalog.set-product-manufacturer',
    'commerce.catalog.set-product-type',
    'commerce.catalog.set-variant-attribute-override',
    'commerce.catalog.set-variant-localized-facts',
    'commerce.catalog.update-product',
  ],
} as const;

const safeOutcomeText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed());
const catalogOutcomeBase = {
  correlationId: safeOutcomeText,
};

/**
 * Business meanings are independent of HTTP and of the #479 Selection shape.
 * VALID_CURRENT carries only an owner-issued evidence reference; the evidence
 * contents and binding rules belong to the concrete Current-validation API.
 */
export const CatalogOperationOutcomeSchema = Schema.Union([
  Schema.Struct({
    ...catalogOutcomeBase,
    evidenceRef: safeOutcomeText,
    kind: Schema.Literal('VALID_CURRENT'),
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    kind: Schema.Literal('INVALID_SELECTION'),
    reasonCode: safeOutcomeText,
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    kind: Schema.Literal('NOT_FOUND'),
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    kind: Schema.Literal('CONFLICT'),
    reasonCode: safeOutcomeText,
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    kind: Schema.Literal('PERMISSION_DENIED'),
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    kind: Schema.Literal('UNAVAILABLE_OR_INDETERMINATE'),
  }),
  Schema.Struct({
    ...catalogOutcomeBase,
    invocationId: ProductActionInvocationIdSchema,
    kind: Schema.Literal('INDETERMINATE_WRITE_OUTCOME'),
    resolution: Schema.Literal('RESOLVE_COMMIT'),
    retryCommand: Schema.Literal(false),
  }),
]);
export type CatalogOperationOutcome = typeof CatalogOperationOutcomeSchema.Type;

export const catalogOutcomeHttpStatus = {
  CONFLICT: 409,
  INDETERMINATE_WRITE_OUTCOME: 503,
  INVALID_SELECTION: 422,
  NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  UNAVAILABLE_OR_INDETERMINATE: 503,
  VALID_CURRENT: 200,
} as const satisfies Record<CatalogOperationOutcome['kind'], number>;
