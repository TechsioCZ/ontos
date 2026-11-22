import { computeActionRequestHash, computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import {
  bindInitialVariantSourceRequestIdentity,
  correctProductRequestIdentity,
  createProductRequestIdentity,
  createVariantRequestIdentity,
  setVariantLocalizedFactsRequestIdentity,
  updateProductRequestIdentity,
} from '@app/catalog/api/native-action-request-identity';
import { CreateProductRecoveryRequestSchema } from '@app/catalog/api/create-product-recovery';
import { GovernVariantAxesPayloadSchema } from '@app/catalog/api/govern-variant-axes-action';
import { ConfirmVariantCombinationPayloadSchema } from '@app/catalog/api/confirm-variant-combination-action';
import { SetProductLocalizedFactsPayloadSchema } from '@app/catalog/api/set-product-localized-facts-action';
import { SetProductUnitTargetDivisibilityPayloadSchema } from '@app/catalog/api/set-product-unit-target-divisibility-action';
import { DecideProductTypeUnnecessaryPayloadSchema } from '@app/catalog/api/decide-product-type-unnecessary-action';
import { executeGovernVariantAxesWithAuthorization } from '@app/catalog/api/govern-variant-axes-action-client';
import { executeGovernVariantAxesRecoveryWithAuthorization } from '@app/catalog/api/govern-variant-axes-recovery-client';
import { executeConfirmVariantCombinationWithAuthorization } from '@app/catalog/api/confirm-variant-combination-action-client';
import { executeConfirmVariantCombinationRecoveryWithAuthorization } from '@app/catalog/api/confirm-variant-combination-recovery-client';
import { executeSetProductLocalizedFactsWithAuthorization } from '@app/catalog/api/set-product-localized-facts-action-client';
import { executeSetProductLocalizedFactsRecoveryWithAuthorization } from '@app/catalog/api/set-product-localized-facts-recovery-client';
import { executeSetProductUnitTargetDivisibilityWithAuthorization } from '@app/catalog/api/set-product-unit-target-divisibility-action-client';
import { executeSetProductUnitTargetDivisibilityRecoveryWithAuthorization } from '@app/catalog/api/set-product-unit-target-divisibility-recovery-client';
import { executeDecideProductTypeUnnecessaryWithAuthorization } from '@app/catalog/api/decide-product-type-unnecessary-action-client';
import { executeDecideProductTypeUnnecessaryRecoveryWithAuthorization } from '@app/catalog/api/decide-product-type-unnecessary-recovery-client';
import {
  ProvisionSourceStockItemPayloadSchema,
  SourceProvisioningExpectedPolicySchema,
} from '@app/inventory/source-provisioning';
import type { SourceStockItemProvisioning } from '@app/inventory/source-provisioning';
import { SourceStockItemProvisioningReceiptRequestSchema } from '@app/inventory/api/source-stock-item-provisioning-receipt';
import { InventorySourceImportReceiptRequestSchema } from '@app/inventory/api/inventory-source-import-receipt';
import { prepareImportSourceAssertionRequestIdentity } from '@app/inventory/source-import';
import type { PriceGroupSourceCorrelation } from '@app/price-group-catalog/apis/price-group-source-associations';
import { PriceGroupResultLookupRequestSchema } from '@app/price-group-catalog/apis/price-group-result-lookup';
import {
  prepareCreatePriceGroupOriginalRequestIdentity,
  prepareCreatePriceGroupDefinitionRevisionOriginalRequestIdentity,
} from '@app/price-group-catalog/source-request-identity';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { PriceSourceResultLookupRequestSchema } from '@app/pricing/apis/price-source-result-lookup';
import {
  prepareDefinePriceOriginalRequestIdentity,
  prepareRevisePriceOriginalRequestIdentity,
} from '@app/pricing/source-request-identity';
import { executeBindInitialVariantSourceWithAuthorization } from '@app/catalog/api/bind-initial-variant-source-action-client';
import { executeBindInitialVariantSourceRecoveryWithAuthorization } from '@app/catalog/api/bind-initial-variant-source-recovery-client';
import { executeCatalogSourceProductsWithAuthorization } from '@app/catalog/api/catalog-source-products-client';
import { executeCorrectProductWithAuthorization } from '@app/catalog/api/correct-product-action-client';
import { executeCorrectProductRecoveryWithAuthorization } from '@app/catalog/api/correct-product-recovery-client';
import { executeCreateProductWithAuthorization } from '@app/catalog/api/create-product-action-client';
import { executeCreateProductRecoveryWithAuthorization } from '@app/catalog/api/create-product-recovery-client';
import { executeCreateVariantWithAuthorization } from '@app/catalog/api/create-variant-action-client';
import { executeCreateVariantRecoveryWithAuthorization } from '@app/catalog/api/create-variant-recovery-client';
import { executeSetVariantLocalizedFactsWithAuthorization } from '@app/catalog/api/set-variant-localized-facts-action-client';
import { executeSetVariantLocalizedFactsRecoveryWithAuthorization } from '@app/catalog/api/set-variant-localized-facts-recovery-client';
import { executeUpdateProductWithAuthorization } from '@app/catalog/api/update-product-action-client';
import { executeUpdateProductRecoveryWithAuthorization } from '@app/catalog/api/update-product-recovery-client';
import type { CreateProductRecoveryResponseSchema } from '@app/catalog/api/create-product-recovery';
import { CreateVariantPayloadSchema } from '@app/catalog/api/create-variant-action';
import { UpdateProductPayloadSchema } from '@app/catalog/api/update-product-action';
import type { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { ProductActionInvocationIdSchema } from '@app/catalog/domain/product';
import type { ProductRef } from '@app/catalog-selection-contracts/resources/product';
import {
  executeProvisionSourceStockItemWithAuthorization,
  executeSourceStockItemProvisioningReceiptWithAuthorization,
  executeImportSourceAssertionWithAuthorization,
  executeInventorySourceImportReceiptWithAuthorization,
} from '@app/inventory/api/client';
import { InventorySourceImportActionInvocationIdSchema } from '@app/inventory/source-import-outcome';
import type { InventorySourceImportOutcome } from '@app/inventory/source-import-outcome';
import { CreatePriceGroupPayloadSchema } from '@app/price-group-catalog/actions/create-price-group';
import {
  executeCreatePriceGroupWithAuthorization,
  executePriceGroupCatalogHeadWithAuthorization,
  executePriceGroupSourceAssociationsWithAuthorization,
  executeCreatePriceGroupDefinitionRevisionWithAuthorization,
  executePriceGroupResultLookupWithAuthorization,
} from '@app/price-group-catalog/api/client';
import {
  executeDefinePriceWithAuthorization,
  executePriceDefinitionWithAuthorization,
  executeRevisePriceWithAuthorization,
  executePriceSourceResultLookupWithAuthorization,
} from '@app/pricing/api/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import type { GatewayDelegationSubject } from '@app/shared-contracts/gateway-context-server';
import { Context, Crypto, Effect, Exit, Layer, Match, Option, Schema, Stream } from 'effect';

import {
  SymmyCatalogPricingInventoryReceiptSchema,
  SymmyCatalogPricingInventoryIntentSchema,
} from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import type {
  SymmyCatalogPricingInventoryReceipt,
  SymmyCatalogPricingInventoryIntent,
} from '../../shared/domain/symmy-catalog-pricing-inventory-intents.ts';
import { symmyOwnerOperationRequirementKey } from '../../shared/domain/symmy-owner-operation-requirements.ts';
import { SymmyPinnedEffectSchema } from '../../shared/domain/symmy-job-execution.ts';
import type { SymmyExecutionOutcome, SymmyPinnedEffect } from '../../shared/domain/symmy-job-execution.ts';
import type {
  SymmyEffectAdapter,
  SymmyEffectAdapterInput,
  SymmyOriginalEffectRecovery,
} from './symmy-effect-adapters.service.ts';
import { symmyJobWorkerInvalid, symmyJobWorkerUnavailable } from './symmy-job-worker-error.ts';
import { readOriginalOwnerAttempt } from './symmy-owner-request-recovery.ts';

const committedEvidence = Schema.Struct({ invocationId: ProductActionInvocationIdSchema });
const problemStatus = Schema.Struct({ status: Schema.Int });
const readinessActivateKey = 'readiness-activate';
const decodeReadinessInput = <Decoded>(schema: Schema.Decoder<Decoded>, value: typeof Schema.Json.Type) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(symmyJobWorkerInvalid));
const sameRef = (
  left: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
  right: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
    readonly tenantId: string;
  },
) =>
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId &&
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType;
const safeOutcome = (
  input: SymmyEffectAdapterInput,
  status:
    | 'accepted_change'
    | 'accepted_no_change'
    | 'stale'
    | 'conflict'
    | 'denied'
    | 'indeterminate'
    | 'unresolved'
    | 'invalid'
    | 'unavailable',
): SymmyExecutionOutcome => ({
  effectId: input.effect.ref.effectId,
  owner: input.effect.ref.operation.moduleId,
  status,
});
const readinessResolvedIntentSchema = Schema.Union([
  Schema.TaggedStruct('CatalogReadinessAxes', {}),
  Schema.TaggedStruct('CatalogReadinessConfirm', {}),
  Schema.TaggedStruct('CatalogReadinessName', {}),
  Schema.TaggedStruct('CatalogReadinessUnit', {}),
  Schema.TaggedStruct('CatalogReadinessUntyped', {}),
]);
const readinessEffectInPlan = (input: SymmyEffectAdapterInput) => {
  const item = input.acceptedPlan?.items.find(({ itemId }) => itemId === input.effect.itemId);
  return (
    item !== undefined &&
    input.acceptedPlan?.items.some(({ effects }) =>
      effects.some(({ intent }) =>
        Schema.is(
          Schema.TaggedStruct('CatalogProductDependentEffect', {
            parent: Schema.Struct({
              effectKey: Schema.Literal(input.effect.effectKey),
              itemKey: Schema.Literal(item.itemKey),
            }),
            request: Schema.TaggedStruct('CatalogReadiness', {}),
          }),
        )(intent),
      ),
    ) === true
  );
};

const provisioningOutcome = (
  input: SymmyEffectAdapterInput,
  provisioning: SourceStockItemProvisioning,
): SymmyExecutionOutcome =>
  safeOutcome(
    input,
    [provisioning.stockItem, provisioning.binding, provisioning.itemCorrelation, ...provisioning.positions].some(
      ({ disposition }) => disposition === 'ESTABLISHED',
    )
      ? 'accepted_change'
      : 'accepted_no_change',
  );

const initialVariantBindingOutcome = (input: SymmyEffectAdapterInput, { changed }: { readonly changed?: boolean }) => {
  if (changed === undefined) {
    return safeOutcome(input, 'unresolved');
  }
  return safeOutcome(input, changed ? 'accepted_change' : 'accepted_no_change');
};

const projectSymmyInventoryOutcome = (
  input: SymmyEffectAdapterInput,
  result: InventorySourceImportOutcome,
): SymmyExecutionOutcome =>
  Match.value(result).pipe(
    Match.discriminatorsExhaustive('status')({
      ACCEPTED: () => safeOutcome(input, 'accepted_change'),
      DUPLICATE: (): SymmyExecutionOutcome => ({
        effectId: input.effect.ref.effectId,
        originalStatus: 'accepted_change',
        owner: input.effect.ref.operation.moduleId,
        status: 'duplicate',
      }),
      INDETERMINATE: () => safeOutcome(input, 'indeterminate'),
      REJECTED: ({ reason }) =>
        Match.value(reason).pipe(
          Match.when('No selected Inventory Backend exists for the source assertion scope', () =>
            safeOutcome(input, 'unavailable'),
          ),
          Match.when('ASSERTION_ID_CONFLICT', () => safeOutcome(input, 'conflict')),
          Match.orElse(() => safeOutcome(input, 'invalid')),
        ),
      STALE: () => safeOutcome(input, 'stale'),
    }),
  );

const settledParentOutcomeSchema = Schema.Literals(['accepted_change', 'accepted_no_change', 'duplicate']);

const qualifiedSource = (
  input: SymmyEffectAdapterInput,
  source:
    | {
        readonly issuerId: string;
        readonly mappingRevision: string;
        readonly recordId: string;
        readonly recordNamespace: string;
        readonly routeScope: string;
        readonly sourceOccurrenceId?: string;
      }
    | undefined,
) => {
  const { ref } = input.effect;
  const { record } = ref.occurrence;
  return (
    source !== undefined &&
    source.issuerId === record.issuerId &&
    source.routeScope === record.route.integrationRouteId &&
    source.recordNamespace === record.sourceNamespace &&
    source.recordId === record.sourceRecordId &&
    source.mappingRevision === ref.mappingVersion &&
    source.sourceOccurrenceId === ref.occurrence.occurrenceId
  );
};

const priceSourceMatches = (
  input: SymmyEffectAdapterInput,
  source: {
    readonly mapping: { readonly mappingContractVersion: string };
    readonly sourceRecord: {
      readonly sourceRecordRef: string;
      readonly sourceSystem: { readonly ownerModuleId: string; readonly sourceSystemRef: string };
    };
  },
) =>
  input.pricingSourceSystem !== undefined &&
  source.sourceRecord.sourceSystem.ownerModuleId === input.pricingSourceSystem.ownerModuleId &&
  source.sourceRecord.sourceSystem.sourceSystemRef === input.pricingSourceSystem.sourceSystemRef &&
  source.sourceRecord.sourceRecordRef === input.effect.ref.occurrence.record.sourceRecordId &&
  source.mapping.mappingContractVersion === input.effect.ref.mappingVersion;

const priceGroupSourceMatches = (
  input: SymmyEffectAdapterInput,
  source:
    | {
        readonly issuer: string;
        readonly mappingVersion: string;
        readonly namespace: string;
        readonly recordKey: string;
        readonly routeId: string;
        readonly sourceOccurrenceId?: string;
      }
    | undefined,
) => {
  const { record } = input.effect.ref.occurrence;
  return (
    source !== undefined &&
    source.issuer === record.issuerId &&
    source.routeId === record.route.integrationRouteId &&
    source.namespace === record.sourceNamespace &&
    source.recordKey === record.sourceRecordId &&
    source.mappingVersion === input.effect.ref.mappingVersion &&
    source.sourceOccurrenceId === input.effect.ref.occurrence.occurrenceId
  );
};
/** The live association identifies the stable source record; occurrence evidence stays in its immutable operation receipt. */
const samePriceGroupBinding = (actual: PriceGroupSourceCorrelation, original: PriceGroupSourceCorrelation) =>
  actual.issuer === original.issuer &&
  actual.routeId === original.routeId &&
  actual.namespace === original.namespace &&
  actual.recordKey === original.recordKey &&
  actual.mappingVersion === original.mappingVersion;

/** The occurrence is an explicit admitted source fact, never a job ID or a record-key default. */
export const materializeSymmyCatalogPricingInventorySourceOccurrence = (
  requestIntent: SymmyCatalogPricingInventoryIntent,
  sourceOccurrenceId: string,
): SymmyCatalogPricingInventoryIntent =>
  Match.value(requestIntent).pipe(
    Match.tag('CatalogCreateProduct', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.tag('CatalogCreateVariant', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.tag('CatalogCreateVariantFromProductEffect', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.tag('CatalogBindInitialVariantSource', (intent) => {
      const source = intent.payload.productSource;
      return source.sourceOccurrenceId === undefined
        ? { ...intent, payload: { ...intent.payload, productSource: { ...source, sourceOccurrenceId } } }
        : intent;
    }),
    Match.tag('PriceGroupCreate', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.tag('PriceGroupCreateAtCatalogHead', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.tag('PriceGroupRevise', (intent) => {
      const source = intent.payload.sourceCorrelation;
      return source === undefined || source.sourceOccurrenceId !== undefined
        ? intent
        : { ...intent, payload: { ...intent.payload, sourceCorrelation: { ...source, sourceOccurrenceId } } };
    }),
    Match.orElse((intent) => intent),
  );

const checkedIntent = Effect.fn('SymmyOwnerAdapters.checkedIntent')(function* checked(input: SymmyEffectAdapterInput) {
  const decodedIntent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema, {
    onExcessProperty: 'error',
  })(input.effect.intent).pipe(Effect.mapError(symmyJobWorkerInvalid));
  const { entityKind, route } = input.effect.ref.occurrence.record;
  const { tenantId } = route;
  const { originalTarget: target } = input.effect.ref;
  const expectedTarget = (ref: Parameters<typeof sameRef>[0]) =>
    ref.tenantId === tenantId && target !== undefined && sameRef(target, ref);
  const valid = Match.value(decodedIntent).pipe(
    Match.tags({
      CatalogBindInitialVariantSource: ({ payload }) =>
        target !== undefined && qualifiedSource(input, payload.productSource),
      CatalogCorrectProduct: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      CatalogCreateProduct: ({ payload }) =>
        entityKind === 'PRODUCT' && target === undefined && qualifiedSource(input, payload.sourceCorrelation),
      CatalogCreateVariant: ({ payload }) =>
        expectedTarget(payload.productRef) &&
        payload.variantRef.tenantId === tenantId &&
        qualifiedSource(input, payload.sourceCorrelation),
      CatalogCreateVariantFromProductEffect: () => false,
      CatalogProductDependentEffect: () => false,
      CatalogReadinessAxes: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      CatalogReadinessConfirm: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      CatalogReadinessName: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      CatalogReadinessUnit: ({ payload }) =>
        entityKind === 'PRODUCT' && expectedTarget(payload.expectedSources.product.resourceRef),
      CatalogReadinessUntyped: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      CatalogSetVariantLocalizedFacts: ({ payload }) =>
        entityKind === 'VARIANT' && expectedTarget(payload.variantRef) && payload.productRef.tenantId === tenantId,
      CatalogUpdateProduct: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      InventoryImport: ({ payload }) =>
        input.inventoryBackendId !== undefined &&
        expectedTarget(payload.authorizationTargetRef) &&
        payload.items.every((item) => item.issuer.backendId === input.inventoryBackendId),
      InventoryProvision: ({ payload, source }) =>
        input.inventoryBackendId === source.issuer.backendId &&
        expectedTarget(payload.policyRef) &&
        sameRef(payload.policyRef, source.policyRef) &&
        payload.catalogSelection.productRef.tenantId === tenantId,
      PriceDefine: ({ payload }) =>
        expectedTarget(payload.priceRef) && priceSourceMatches(input, payload.sourceAssertion),
      PriceDefineFromGroupEffect: () => false,
      PriceGroupCreate: ({ payload }) =>
        target === undefined && priceGroupSourceMatches(input, payload.sourceCorrelation),
      PriceGroupCreateAtCatalogHead: () => false,
      PriceGroupRevise: ({ payload }) =>
        expectedTarget(payload.expectedCurrent.priceGroupRef) &&
        priceGroupSourceMatches(input, payload.sourceCorrelation),
      PriceRevise: ({ payload }) =>
        expectedTarget(payload.priceRef) &&
        Match.value(payload).pipe(
          Match.when({ intent: 'RETIRE_CURRENT' }, () => false),
          Match.orElse((value) => priceSourceMatches(input, value.sourceAssertion)),
        ),
    }),
    Match.exhaustive,
  );
  return valid ? decodedIntent : yield* symmyJobWorkerInvalid();
});

type IntentTag = SymmyCatalogPricingInventoryIntent['_tag'];
interface AdapterContract {
  readonly audience: string;
  readonly declarationKey: string;
  readonly entrypointKey: string;
  readonly moduleId: 'commerce.catalog' | 'commerce.pricing' | 'pricing.price-group-catalog' | 'commerce.inventory';
  readonly recoveryDeclarationKey: string;
  readonly recoveryEntrypointKey: string;
  readonly schemaVersion: string;
  readonly tag: IntentTag;
}

const inventoryModuleId = 'commerce.inventory';
const inventoryProvisionActionKey = 'commerce.inventory.provision-source-stock-item';
const inventoryProvisioningReceiptRead = 'commerce.inventory.api.source-stock-item-provisioning-receipt';
const priceGroupAudience = 'price-group-catalog';
const priceGroupModuleId = 'pricing.price-group-catalog';
const catalogAudience = 'catalog';
const catalogModuleId = 'commerce.catalog' as const;
const symmyCatalogPricingInventoryContracts: readonly AdapterContract[] = [
  ...(
    [
      ['govern-variant-axes', 'variant-axes.govern', 'CatalogReadinessAxes'],
      ['confirm-variant-combination', 'variant-combination.confirm', 'CatalogReadinessConfirm'],
      ['set-product-localized-facts', 'product-localized-facts.set', 'CatalogReadinessName'],
      ['set-product-unit-target-divisibility', 'product-unit-target-divisibility.set', 'CatalogReadinessUnit'],
      ['decide-product-type-unnecessary', 'product-type-unnecessary.decide', 'CatalogReadinessUntyped'],
    ] as const
  ).map(([action, declaration, tag]) => ({
    audience: catalogAudience,
    declarationKey: `commerce.catalog.${declaration}`,
    entrypointKey: `commerce.catalog.${action}`,
    moduleId: catalogModuleId,
    recoveryDeclarationKey: `commerce.catalog.${action}-recovery.read`,
    recoveryEntrypointKey: `commerce.catalog.api.${action}-recovery`,
    schemaVersion: '1',
    tag,
  })),
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.product.create',
    entrypointKey: 'commerce.catalog.create-product',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.create-product-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.create-product-recovery',
    schemaVersion: '2',
    tag: 'CatalogCreateProduct',
  },
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.variant.create',
    entrypointKey: 'commerce.catalog.create-variant',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.create-variant-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.create-variant-recovery',
    schemaVersion: '2',
    tag: 'CatalogCreateVariant',
  },
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.product.update',
    entrypointKey: 'commerce.catalog.update-product',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.update-product-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.update-product-recovery',
    schemaVersion: '1',
    tag: 'CatalogUpdateProduct',
  },
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.variant-localized-facts.set',
    entrypointKey: 'commerce.catalog.set-variant-localized-facts',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.set-variant-localized-facts-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.set-variant-localized-facts-recovery',
    schemaVersion: '1',
    tag: 'CatalogSetVariantLocalizedFacts',
  },
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.product.correct',
    entrypointKey: 'commerce.catalog.correct-product',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.correct-product-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.correct-product-recovery',
    schemaVersion: '1',
    tag: 'CatalogCorrectProduct',
  },
  {
    audience: catalogAudience,
    declarationKey: 'commerce.catalog.initial-variant-source.bind',
    entrypointKey: 'commerce.catalog.bind-initial-variant-source',
    moduleId: catalogModuleId,
    recoveryDeclarationKey: 'commerce.catalog.bind-initial-variant-source-recovery.read',
    recoveryEntrypointKey: 'commerce.catalog.api.bind-initial-variant-source-recovery',
    schemaVersion: '1',
    tag: 'CatalogBindInitialVariantSource',
  },
  {
    audience: priceGroupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group.create',
    entrypointKey: 'pricing.price-group-catalog.create-price-group',
    moduleId: priceGroupModuleId,
    recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-result-lookup.read',
    recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-result-lookup',
    schemaVersion: '1',
    tag: 'PriceGroupCreate',
  },
  {
    audience: priceGroupAudience,
    declarationKey: 'pricing.price-group-catalog.price-group-definition-revision.create',
    entrypointKey: 'pricing.price-group-catalog.create-price-group-definition-revision',
    moduleId: priceGroupModuleId,
    recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-result-lookup.read',
    recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-result-lookup',
    schemaVersion: '1',
    tag: 'PriceGroupRevise',
  },
  {
    audience: 'pricing',
    declarationKey: 'commerce.pricing.price.define',
    entrypointKey: 'commerce.pricing.define-price',
    moduleId: 'commerce.pricing',
    recoveryDeclarationKey: 'commerce.pricing.price-source-result-lookup.read',
    recoveryEntrypointKey: 'commerce.pricing.api.price-source-result-lookup',
    schemaVersion: '2',
    tag: 'PriceDefine',
  },
  {
    audience: 'pricing',
    declarationKey: 'commerce.pricing.price.revise',
    entrypointKey: 'commerce.pricing.revise-price',
    moduleId: 'commerce.pricing',
    recoveryDeclarationKey: 'commerce.pricing.price-source-result-lookup.read',
    recoveryEntrypointKey: 'commerce.pricing.api.price-source-result-lookup',
    schemaVersion: '2',
    tag: 'PriceRevise',
  },
  {
    audience: 'inventory',
    declarationKey: 'commerce.inventory.source-stock-item.provision',
    entrypointKey: inventoryProvisionActionKey,
    moduleId: inventoryModuleId,
    recoveryDeclarationKey: 'commerce.inventory.source-stock-item-provisioning-receipt.read',
    recoveryEntrypointKey: inventoryProvisioningReceiptRead,
    schemaVersion: '1',
    tag: 'InventoryProvision',
  },
  {
    audience: 'inventory',
    declarationKey: 'commerce.inventory.source-assertion.import',
    entrypointKey: 'commerce.inventory.import-source-assertion',
    moduleId: inventoryModuleId,
    recoveryDeclarationKey: 'commerce.inventory.inventory-source-import-receipt.read',
    recoveryEntrypointKey: 'commerce.inventory.api.inventory-source-import-receipt',
    schemaVersion: '1',
    tag: 'InventoryImport',
  },
];

const freshGateway = Effect.fn('SymmyOwnerAdapters.freshGateway')(function* fresh(
  input: SymmyEffectAdapterInput,
  contract: AdapterContract,
  recovery: boolean,
  crypto: Crypto.Crypto,
) {
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const legalEntityId = contract.audience === 'pricing' ? input.legalEntityId : undefined;
  if (contract.audience === 'pricing' && legalEntityId === undefined) {
    return yield* symmyJobWorkerInvalid();
  }
  const declarationKey = recovery ? contract.recoveryDeclarationKey : contract.declarationKey;
  const providerEntrypointKey = recovery ? contract.recoveryEntrypointKey : contract.entrypointKey;
  const operationRequirementKey = symmyOwnerOperationRequirementKey(
    input.context === undefined ? 'admission' : 'worker',
    providerEntrypointKey,
  );
  let subject: GatewayDelegationSubject;
  if (input.context === undefined) {
    if (input.admission === undefined) {
      return yield* symmyJobWorkerInvalid();
    }
    subject = { ...input.admission, _tag: 'RegisteredAdmission', declarationKey, operationRequirementKey };
  } else {
    subject = { _tag: 'RegisteredWorkload', context: input.context, declarationKey, operationRequirementKey };
  }
  if (legalEntityId !== undefined) {
    subject = { ...subject, legalEntityId };
  }
  if (!recovery && input.originalExecutorPrincipalId !== undefined) {
    subject = { ...subject, expectedPrincipalId: input.originalExecutorPrincipalId };
  }
  const gateway = yield* acquireDelegatedGatewayContext(
    {
      audience: contract.audience,
      legalEntityScope: legalEntityId === undefined ? 'tenant' : 'subject',
      requestCorrelation,
      subject,
    },
    crypto,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  return {
    credential: gateway.authorization,
    machineContext: 'machineContext' in gateway ? gateway.machineContext : undefined,
    options: {
      baseUrl: gateway.apiBaseUrl,
      compositionRevision: gateway.compositionRevision,
      idempotencyKey: input.effect.ref.effectId,
    },
    requestCorrelation,
  };
});
type GatewayAttempt = Effect.Success<ReturnType<typeof freshGateway>>;

const readCatalogSourceProduct = Effect.fn('SymmyOwnerAdapters.readCatalogSourceProduct')(function* readSourceProduct(
  input: SymmyEffectAdapterInput,
  source: typeof CatalogSourceCorrelationSchema.Type,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const wire = yield* freshGateway(
    input,
    {
      ...contract,
      recoveryDeclarationKey: 'commerce.catalog.catalog-source-products.read',
      recoveryEntrypointKey: 'commerce.catalog.api.catalog-source-products',
    },
    true,
    crypto,
  );
  const result = yield* executeCatalogSourceProductsWithAuthorization(
    {
      entityKind: 'PRODUCT',
      issuerId: source.issuerId,
      operation: 'LOOKUP',
      recordId: source.recordId,
      recordNamespace: source.recordNamespace,
      routeScope: source.routeScope,
    },
    wire.credential,
    wire.requestCorrelation,
    wire.options,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const [item] = result.items;
  return result.outcome === 'FOUND' && result.items.length === 1 && item !== undefined
    ? item
    : yield* symmyJobWorkerUnavailable();
});

const hasDeclaredParentDependency = (
  effect: SymmyPinnedEffect,
  parentItemId: string,
  reference: { readonly effectKey: string; readonly itemKey: string },
) =>
  (effect.dependsOn ?? []).some((dependency) =>
    Schema.is(Schema.String)(dependency)
      ? dependency === reference.effectKey && parentItemId === effect.itemId
      : dependency.itemKey === reference.itemKey && dependency.effectKey === reference.effectKey,
  );

interface ProductEffectReference {
  readonly effectKey: string;
  readonly itemKey: string;
}

/**
 * The receipt of the Product create effect a dependent effect names: the parent must be this job's settled Product
 * create, declared in the dependent's own dependencies, and its receipt must belong to the route's tenant.
 */
const requireCreatedProductParent = Effect.fn('SymmyOwnerAdapters.requireCreatedProductParent')(function* createdParent(
  input: SymmyEffectAdapterInput,
  reference: ProductEffectReference,
) {
  const parents = input.dependencies.filter(
    (dependency) => dependency.itemKey === reference.itemKey && dependency.effect.effectKey === reference.effectKey,
  );
  const [parent] = parents;
  if (
    parents.length !== 1 ||
    parent === undefined ||
    parent.state !== 'settled' ||
    Option.isNone(parent.outcome) ||
    parent.effect.ref.operation.moduleId !== catalogModuleId ||
    parent.effect.ref.operation.entrypointKey !== 'commerce.catalog.create-product'
  ) {
    return yield* symmyJobWorkerInvalid();
  }
  if (
    !Schema.is(settledParentOutcomeSchema)(parent.outcome.value.status) ||
    !hasDeclaredParentDependency(input.effect, parent.effect.itemId, reference)
  ) {
    return yield* symmyJobWorkerInvalid();
  }
  const receipt = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryReceiptSchema.members[0])(
    Option.getOrUndefined(Option.flatten(Option.fromUndefinedOr(parent.ownerReceipt))),
  ).pipe(Effect.mapError(symmyJobWorkerInvalid));
  if (receipt.productRef.tenantId !== input.effect.ref.occurrence.record.route.tenantId) {
    return yield* symmyJobWorkerInvalid();
  }
  return receipt;
});

type ProductDependentIntent = Extract<
  SymmyCatalogPricingInventoryIntent,
  { readonly _tag: 'CatalogProductDependentEffect' }
>;
type ProductCreatedReceipt = Extract<SymmyCatalogPricingInventoryReceipt, { readonly _tag: 'ProductCreated' }>;

const readinessReceipt = Effect.fn('SymmyOwnerAdapters.readinessReceipt')(function* readinessReceipt(
  input: SymmyEffectAdapterInput,
  parent: ProductEffectReference,
  effectKey: string,
) {
  const candidates = input.dependencies.filter(
    (dependency) => dependency.itemKey === parent.itemKey && dependency.effect.effectKey === effectKey,
  );
  const [candidate] = candidates;
  if (
    candidates.length !== 1 ||
    candidate === undefined ||
    candidate.state !== 'settled' ||
    Option.isNone(candidate.outcome) ||
    !Schema.is(settledParentOutcomeSchema)(candidate.outcome.value.status) ||
    !hasDeclaredParentDependency(input.effect, candidate.effect.itemId, { effectKey, itemKey: parent.itemKey })
  ) {
    return yield* symmyJobWorkerInvalid();
  }
  return yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryReceiptSchema)(
    Option.getOrUndefined(Option.flatten(Option.fromUndefinedOr(candidate.ownerReceipt))),
  ).pipe(Effect.mapError(symmyJobWorkerInvalid));
});

/**
 * The Variant a text or a price of the Product is about: the further Variant its `variantParent` create effect
 * settled on (the owner's own answer, so a replayed source record keeps its Variant) or, without one, the initial
 * Variant of the Product the create receipt names.
 */
const requireCreatedVariant = Effect.fn('SymmyOwnerAdapters.requireCreatedVariant')(function* createdVariant(
  input: SymmyEffectAdapterInput,
  intent: ProductDependentIntent,
  product: ProductCreatedReceipt,
) {
  const reference = intent.variantParent;
  if (reference === undefined) {
    return product.initialVariantRef;
  }
  const parents = input.dependencies.filter(
    (dependency) => dependency.itemKey === reference.itemKey && dependency.effect.effectKey === reference.effectKey,
  );
  const [parent] = parents;
  if (
    parents.length !== 1 ||
    parent === undefined ||
    parent.state !== 'settled' ||
    Option.isNone(parent.outcome) ||
    !Schema.is(settledParentOutcomeSchema)(parent.outcome.value.status) ||
    parent.effect.ref.operation.moduleId !== catalogModuleId ||
    parent.effect.ref.operation.entrypointKey !== 'commerce.catalog.create-variant' ||
    !hasDeclaredParentDependency(input.effect, parent.effect.itemId, reference)
  ) {
    return yield* symmyJobWorkerInvalid();
  }
  const receipt = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryReceiptSchema.members[1])(
    Option.getOrUndefined(Option.flatten(Option.fromUndefinedOr(parent.ownerReceipt))),
  ).pipe(Effect.mapError(symmyJobWorkerInvalid));
  if (!sameRef(receipt.productRef, product.productRef) || receipt.variantRef.tenantId !== product.productRef.tenantId) {
    return yield* symmyJobWorkerInvalid();
  }
  return receipt.variantRef;
});

/**
 * The plain intent a command on the Product of this job becomes once the receipts of its create effects exist.
 * The Product update takes the Product as its owner target, a text takes its Variant and a price keeps the planned
 * Price ref and names the Variant.
 */
const productDependentIntent = Effect.fn('SymmyOwnerAdapters.productDependentIntent')(function* dependentIntent(
  input: SymmyEffectAdapterInput,
  intent: ProductDependentIntent,
  product: ProductCreatedReceipt,
) {
  const { originalTarget: target } = input.effect.ref;
  const { productRef } = product;
  return yield* Match.value(intent.request).pipe(
    Match.tag('UpdateProduct', ({ payload }) =>
      target === undefined
        ? Effect.succeed({
            intent: { _tag: 'CatalogUpdateProduct', payload: { ...payload, productRef } },
            target: productRef,
          })
        : Effect.fail(symmyJobWorkerInvalid()),
    ),
    Match.tag('SetVariantLocalizedFacts', ({ payload }) =>
      target === undefined
        ? requireCreatedVariant(input, intent, product).pipe(
            Effect.map((variantRef) => ({
              intent: { _tag: 'CatalogSetVariantLocalizedFacts', payload: { ...payload, productRef, variantRef } },
              target: variantRef,
            })),
          )
        : Effect.fail(symmyJobWorkerInvalid()),
    ),
    Match.tag(
      'CatalogReadiness',
      Effect.fn('SymmyOwnerAdapters.readinessIntent')(function* readiness(
        request: Extract<ProductDependentIntent['request'], { readonly _tag: 'CatalogReadiness' }>,
      ) {
        if (
          target !== undefined ||
          !input.canExecuteNewEffects ||
          product.productRevision === undefined ||
          product.variantRevision === undefined ||
          request.unitRef.tenantId !== productRef.tenantId
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const variantRef = yield* requireCreatedVariant(input, intent, product);
        const parent = input.dependencies.find(
          (dependency) =>
            dependency.itemKey === intent.parent.itemKey && dependency.effect.effectKey === intent.parent.effectKey,
        );
        if (parent === undefined || intent.variantParent !== undefined) {
          return yield* symmyJobWorkerInvalid();
        }
        const parentIntent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema)(
          parent.effect.intent,
        ).pipe(Effect.mapError(symmyJobWorkerInvalid));
        const sourceIntent = materializeSymmyCatalogPricingInventorySourceOccurrence(
          parentIntent,
          parent.effect.ref.occurrence.occurrenceId,
        );
        if (
          !Schema.is(SymmyCatalogPricingInventoryIntentSchema.members[0])(sourceIntent) ||
          !qualifiedSource({ ...input, effect: parent.effect }, sourceIntent.payload.sourceCorrelation)
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const sourceProduct = sourceIntent.payload;
        const reason = 'Symmy product import';
        const { evidenceRefs } = request;
        if (request.step === 'AXES') {
          const payload = yield* decodeReadinessInput(GovernVariantAxesPayloadSchema, {
            axes: [],
            classification: { evidenceRefs, kind: 'AXIS_INITIALIZATION', reason },
            expectedAxisRevision: 0,
            productRef,
            reason,
            sourceProduct,
          });
          return { intent: { _tag: 'CatalogReadinessAxes', payload }, target: productRef };
        }
        const axes = yield* readinessReceipt(input, intent.parent, 'readiness-axes');
        if (!Schema.is(SymmyCatalogPricingInventoryReceiptSchema.members[3])(axes)) {
          return yield* symmyJobWorkerInvalid();
        }
        if (request.step === 'CONFIRM') {
          const payload = yield* decodeReadinessInput(ConfirmVariantCombinationPayloadSchema, {
            evidenceRefs,
            expectedAxisRevision: axes.axisRevision,
            expectedVariantRevision: product.variantRevision,
            productRef,
            reason,
            sourceProduct,
            variantRef,
          });
          return { intent: { _tag: 'CatalogReadinessConfirm', payload }, target: productRef };
        }
        const confirmed = yield* readinessReceipt(input, intent.parent, 'readiness-confirm');
        if (!Schema.is(SymmyCatalogPricingInventoryReceiptSchema.members[4])(confirmed)) {
          return yield* symmyJobWorkerInvalid();
        }
        if (request.step === 'NAME') {
          const payload = yield* decodeReadinessInput(SetProductLocalizedFactsPayloadSchema, {
            evidenceRefs,
            expectedRevision: 0,
            facts: { name: request.name },
            locale: request.locale,
            productRef,
            reason,
            sourceProduct,
          });
          return { intent: { _tag: 'CatalogReadinessName', payload }, target: productRef };
        }
        if (request.step === 'ACTIVATE') {
          const payload = yield* decodeReadinessInput(UpdateProductPayloadSchema, {
            expectedRevision: product.productRevision,
            productRef,
            reason,
            sourceProduct,
            targetLifecycle: 'ACTIVE',
          });
          return { intent: { _tag: 'CatalogUpdateProduct', payload }, target: productRef };
        }
        const activated = yield* readinessReceipt(input, intent.parent, readinessActivateKey);
        if (!Schema.is(SymmyCatalogPricingInventoryReceiptSchema.members[5])(activated)) {
          return yield* symmyJobWorkerInvalid();
        }
        if (request.step === 'UNIT') {
          const payload = yield* decodeReadinessInput(SetProductUnitTargetDivisibilityPayloadSchema, {
            divisible: request.divisible,
            evidenceRefs,
            expectedSources: {
              product: { resourceRef: productRef, revision: activated.productRevision },
              variant: { resourceRef: variantRef, revision: confirmed.variantRevision },
            },
            reason,
            sourceProduct,
            target: {
              targetId: variantRef.resourceId,
              targetType: 'commerce.catalog.variant',
              tenantId: productRef.tenantId,
              unit: request.unitRef,
            },
          });
          return { intent: { _tag: 'CatalogReadinessUnit', payload }, target: productRef };
        }
        const payload = yield* decodeReadinessInput(DecideProductTypeUnnecessaryPayloadSchema, {
          decisionState: 'CONFIRMED',
          evidenceRefs,
          expectedAxisRevision: axes.axisRevision,
          expectedDecisionRevision: 0,
          expectedProductRevision: activated.productRevision,
          expectedValueRevisionTokens: [],
          expectedVariantRevisionTokens: [`${variantRef.resourceId}:${confirmed.variantRevision}`],
          productRef,
          reason,
          sourceProduct,
          structuredAttributesRequired: false,
          variantAxesRequired: false,
        });
        return { intent: { _tag: 'CatalogReadinessUntyped', payload }, target: productRef };
      }),
    ),
    Match.tag('ProvisionSourceStockItem', ({ itemKey, source }) =>
      target === undefined &&
      input.canExecuteNewEffects &&
      source.policyRef.tenantId === productRef.tenantId &&
      input.inventoryBackendId === source.issuer.backendId
        ? requireCreatedVariant(input, intent, product).pipe(
            Effect.flatMap((variantRef) =>
              Schema.decodeUnknownEffect(SourceProvisioningExpectedPolicySchema)({
                customerConfigurationId: source.customerConfigurationId,
                externalScope: source.externalScope,
                issuer: source.issuer,
                locations: source.locations,
                namespace: source.namespace,
                unitRef: source.unitRef,
              }).pipe(
                Effect.flatMap((expectedPolicy) =>
                  Schema.decodeUnknownEffect(ProvisionSourceStockItemPayloadSchema)({
                    catalogSelection: { productRef, variantRef },
                    exactSelectionMeaning: { id: `catalog-variant:${variantRef.resourceId}`, kind: 'PRODUCT_VARIANT' },
                    expectedPolicy,
                    itemKey,
                    policyRef: source.policyRef,
                  }),
                ),
              ),
            ),
            Effect.map((payload) => ({
              intent: { _tag: 'InventoryProvision', payload, source },
              target: source.policyRef,
            })),
            Effect.mapError(symmyJobWorkerInvalid),
          )
        : Effect.fail(symmyJobWorkerInvalid()),
    ),
    Match.tag('DefinePrice', ({ payload }) =>
      target !== undefined &&
      sameRef(target, payload.priceRef) &&
      input.canExecuteNewEffects &&
      priceSourceMatches(input, payload.sourceAssertion) &&
      input.legalEntityId === payload.identityKey.commercialScope.sellingLegalEntityId
        ? requireCreatedVariant(input, intent, product).pipe(
            Effect.map((variantRef) => ({
              intent: {
                _tag: 'PriceDefine',
                payload: {
                  ...payload,
                  identityKey: { ...payload.identityKey, catalogSelection: { productRef, variantRef } },
                },
              },
              target,
            })),
          )
        : Effect.fail(symmyJobWorkerInvalid()),
    ),
    Match.exhaustive,
  );
});

const resolveProductDependency = Effect.fn('SymmyOwnerAdapters.resolveProductDependency')(function* resolveDependency(
  input: SymmyEffectAdapterInput,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const requested = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema, {
    onExcessProperty: 'error',
  })(input.effect.intent).pipe(Effect.mapError(symmyJobWorkerInvalid));
  const sourceValid = Match.value(requested).pipe(
    Match.tag('CatalogCreateVariantFromProductEffect', ({ payload }) =>
      qualifiedSource(input, payload.sourceCorrelation),
    ),
    Match.orElse(() => true),
  );
  if (!sourceValid) {
    return yield* symmyJobWorkerInvalid();
  }
  return yield* Match.value(requested).pipe(
    Match.tag(
      'CatalogCreateVariantFromProductEffect',
      Effect.fn('SymmyOwnerAdapters.resolveVariantParent')(function* resolveVariantParent(
        intent: Extract<SymmyCatalogPricingInventoryIntent, { readonly _tag: 'CatalogCreateVariantFromProductEffect' }>,
      ) {
        if (
          input.originalExecutorPrincipalId !== undefined ||
          input.originalInvocationId !== undefined ||
          input.effect.ref.originalTarget !== undefined
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const { record } = input.effect.ref.occurrence;
        if (
          intent.productSource.issuerId !== record.issuerId ||
          intent.productSource.recordNamespace !== record.sourceNamespace ||
          intent.productSource.routeScope !== record.route.integrationRouteId ||
          intent.productSource.mappingRevision !== input.effect.ref.mappingVersion
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const receipt = yield* requireCreatedProductParent(input, intent.parent);
        const bound = yield* readCatalogSourceProduct(input, intent.productSource, contract, crypto);
        if (
          !sameRef(bound.product.productRef, receipt.productRef) ||
          bound.variantId !== receipt.initialVariantRef.resourceId ||
          bound.originalActionInvocationId !== receipt.actionInvocationId
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const payload = yield* Schema.decodeUnknownEffect(CreateVariantPayloadSchema)({
          ...intent.payload,
          classification: { ...intent.payload.classification, productRef: receipt.productRef },
          productRef: receipt.productRef,
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        const resolved = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
          ...input.effect,
          intent: { _tag: 'CatalogCreateVariant', payload, productSource: intent.productSource },
          ref: { ...input.effect.ref, originalTarget: receipt.productRef },
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        yield* input.recordResolvedEffect(resolved);
        return { ...input, effect: resolved };
      }),
    ),
    Match.tag(
      'CatalogProductDependentEffect',
      Effect.fn('SymmyOwnerAdapters.resolveProductDependent')(function* resolveProductDependent(
        intent: ProductDependentIntent,
      ) {
        if (input.originalExecutorPrincipalId !== undefined || input.originalInvocationId !== undefined) {
          return yield* symmyJobWorkerInvalid();
        }
        const receipt = yield* requireCreatedProductParent(input, intent.parent);
        const dependent = yield* productDependentIntent(input, intent, receipt);
        const resolved = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
          ...input.effect,
          intent: dependent.intent,
          ref: { ...input.effect.ref, originalTarget: dependent.target },
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        yield* input.recordResolvedEffect(resolved);
        return { ...input, effect: resolved };
      }),
    ),
    Match.orElse(() => Effect.succeed(input)),
  );
});

/** A persisted provisioning command is evidence, not authority to choose a different SKU or Catalog selection. */
const validateProvisioningResolution = Effect.fn('SymmyOwnerAdapters.validateProvisioningResolution')(
  function* validate(input: SymmyEffectAdapterInput) {
    const originals = input.acceptedPlan?.items.flatMap(({ effects }) =>
      effects.filter(({ ref }) => ref.effectId === input.effect.ref.effectId),
    );
    const [original] = originals ?? [];
    const resolvedProtected =
      input.effect.effectKey === readinessActivateKey ||
      Schema.is(Schema.Union([Schema.TaggedStruct('InventoryProvision', {}), readinessResolvedIntentSchema]))(
        input.effect.intent,
      );
    if (originals?.length !== 1 || original === undefined) {
      if (!resolvedProtected) {
        return yield* Effect.void;
      }
      return yield* symmyJobWorkerInvalid();
    }
    const decoded = Schema.decodeUnknownOption(SymmyCatalogPricingInventoryIntentSchema.members[11])(original.intent);
    if (Option.isNone(decoded)) {
      if (!resolvedProtected) {
        return yield* Effect.void;
      }
      return yield* symmyJobWorkerInvalid();
    }
    const admitted = decoded.value;
    if (
      !Schema.is(
        Schema.Union([
          Schema.TaggedStruct('ProvisionSourceStockItem', {}),
          Schema.TaggedStruct('CatalogReadiness', {}),
        ]),
      )(admitted.request)
    ) {
      if (!resolvedProtected) {
        return yield* Effect.void;
      }
      return yield* symmyJobWorkerInvalid();
    }
    if (Schema.is(SymmyCatalogPricingInventoryIntentSchema.members[11])(input.effect.intent)) {
      return yield* Effect.void;
    }
    const originalInput = { ...input, canExecuteNewEffects: true, effect: original };
    const receipt = yield* requireCreatedProductParent(originalInput, admitted.parent);
    const expected = yield* productDependentIntent(originalInput, admitted, receipt);
    const reconstructed = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
      ...original,
      intent: expected.intent,
      ref: { ...original.ref, originalTarget: expected.target },
    }).pipe(Effect.mapError(symmyJobWorkerInvalid));
    if (computeCanonicalValueHash(reconstructed) !== computeCanonicalValueHash(input.effect)) {
      return yield* symmyJobWorkerInvalid();
    }
    return yield* Effect.void;
  },
);

const recordCurrentNativeInvocation = Effect.fn('SymmyOwnerAdapters.recordCurrentNativeInvocation')(
  function* recordCurrent(input: SymmyEffectAdapterInput, contract: AdapterContract) {
    if (
      input.originalExecutorPrincipalId === undefined ||
      input.originalRequestHash === undefined ||
      input.originalAuthContextRef === undefined
    ) {
      return yield* symmyJobWorkerUnavailable();
    }
    const original = yield* input.readOriginalActionInvocation({
      actionKey: contract.entrypointKey,
      idempotencyKey: input.effect.ref.effectId,
      originalPrincipalId: input.originalExecutorPrincipalId,
      requestHash: input.originalRequestHash,
    });
    if (Option.isNone(original) || original.value.status !== 'succeeded') {
      return yield* symmyJobWorkerUnavailable();
    }
    yield* input.recordInvocationId(original.value.actionInvocationId);
    return original.value.actionInvocationId;
  },
);
const createdSourceOutcome = (
  input: SymmyEffectAdapterInput,
  currentInvocationId: string,
  businessOriginalCreateId: string,
): SymmyExecutionOutcome =>
  currentInvocationId === businessOriginalCreateId
    ? safeOutcome(input, 'accepted_change')
    : {
        effectId: input.effect.ref.effectId,
        originalStatus: 'accepted_change',
        owner: input.effect.ref.operation.moduleId,
        status: 'duplicate',
      };

const captureCreatedProduct = Effect.fn('SymmyOwnerAdapters.captureCreatedProduct')(function* captureProduct(
  input: SymmyEffectAdapterInput,
  result: typeof CreateProductRecoveryResponseSchema.Type,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
  expectedInvocationId?: string,
) {
  const intent = yield* checkedIntent(input);
  return yield* Match.value(intent).pipe(
    Match.tag(
      'CatalogCreateProduct',
      Effect.fn('SymmyOwnerAdapters.captureProductReceipt')(function* captureReceipt({
        payload,
      }: Extract<SymmyCatalogPricingInventoryIntent, { readonly _tag: 'CatalogCreateProduct' }>) {
        const source = payload.sourceCorrelation;
        if (source === undefined) {
          return yield* symmyJobWorkerInvalid();
        }
        const variants = result.product.variants.filter((variant) => variant.variantId === result.variantId);
        const [initialVariant] = variants;
        if (variants.length !== 1 || initialVariant === undefined) {
          return yield* symmyJobWorkerUnavailable();
        }
        const needsReadiness = readinessEffectInPlan(input);
        if (needsReadiness && result.initialVariantRevision === undefined) {
          return Option.none<string>();
        }
        let actionInvocationId = result.businessOriginalCreateInvocationId;
        if (actionInvocationId === undefined) {
          if (expectedInvocationId !== undefined) {
            return yield* symmyJobWorkerUnavailable();
          }
          const bound = yield* readCatalogSourceProduct(input, source, contract, crypto);
          if (!sameRef(bound.product.productRef, result.product.productRef) || bound.variantId !== result.variantId) {
            return yield* symmyJobWorkerUnavailable();
          }
          actionInvocationId = bound.originalActionInvocationId;
        }
        const receipt: SymmyCatalogPricingInventoryReceipt = {
          _tag: 'ProductCreated',
          actionInvocationId,
          initialVariantRef: initialVariant.variantRef,
          productRef: result.product.productRef,
        };
        if (needsReadiness) {
          Object.assign(receipt, {
            productRevision: result.product.revision,
            variantRevision: result.initialVariantRevision,
          });
        }
        yield* input.recordOwnerReceipt(receipt);
        return Option.some(actionInvocationId);
      }),
    ),
    Match.orElse(() => Effect.fail(symmyJobWorkerInvalid())),
  );
});

const verifyExistingCatalogTarget = Effect.fn('SymmyOwnerAdapters.verifyCatalogSourceTarget')(
  function* verifySourceTarget(
    input: SymmyEffectAdapterInput,
    requestIntent: SymmyCatalogPricingInventoryIntent,
    contract: AdapterContract,
    crypto: Crypto.Crypto,
  ) {
    const { record } = input.effect.ref.occurrence;
    const occurrenceSource = {
      issuerId: record.issuerId,
      mappingRevision: input.effect.ref.mappingVersion,
      recordId: record.sourceRecordId,
      recordNamespace: record.sourceNamespace,
      routeScope: record.route.integrationRouteId,
    };
    const selectedSource = Match.value(requestIntent).pipe(
      Match.tags({
        CatalogBindInitialVariantSource: ({ payload }) => Option.some(payload.productSource),
        CatalogCorrectProduct: () => Option.some(occurrenceSource),
        CatalogCreateProduct: () => Option.none(),
        CatalogCreateVariant: ({ productSource }) => Option.some(productSource),
        CatalogCreateVariantFromProductEffect: () => Option.none(),
        CatalogProductDependentEffect: () => Option.none(),
        CatalogReadinessAxes: () => Option.some(occurrenceSource),
        CatalogReadinessConfirm: () => Option.some(occurrenceSource),
        CatalogReadinessName: () => Option.some(occurrenceSource),
        CatalogReadinessUnit: () => Option.some(occurrenceSource),
        CatalogReadinessUntyped: () => Option.some(occurrenceSource),
        CatalogSetVariantLocalizedFacts: () => Option.some(occurrenceSource),
        CatalogUpdateProduct: () => Option.some(occurrenceSource),
        InventoryImport: () => Option.none(),
        InventoryProvision: () => Option.none(),
        PriceDefine: () => Option.none(),
        PriceDefineFromGroupEffect: () => Option.none(),
        PriceGroupCreate: () => Option.none(),
        PriceGroupCreateAtCatalogHead: () => Option.none(),
        PriceGroupRevise: () => Option.none(),
        PriceRevise: () => Option.none(),
      }),
      Match.exhaustive,
    );
    const source = Option.getOrUndefined(selectedSource);
    if (source === undefined) {
      return true;
    }
    if (
      source.issuerId !== record.issuerId ||
      source.mappingRevision !== input.effect.ref.mappingVersion ||
      source.recordNamespace !== record.sourceNamespace ||
      source.routeScope !== record.route.integrationRouteId
    ) {
      return false;
    }
    const target = input.effect.ref.originalTarget;
    if (target === undefined) {
      return false;
    }
    const variantProduct = Match.value(requestIntent).pipe(
      Match.tag('CatalogSetVariantLocalizedFacts', ({ payload }) => Option.some(payload.productRef)),
      Match.orElse(Option.none<ProductRef>),
    );
    const wire = yield* freshGateway(
      input,
      {
        ...contract,
        recoveryDeclarationKey: 'commerce.catalog.catalog-source-products.read',
        recoveryEntrypointKey: 'commerce.catalog.api.catalog-source-products',
      },
      true,
      crypto,
    );
    const result = yield* executeCatalogSourceProductsWithAuthorization(
      {
        entityKind: Option.isSome(variantProduct) ? 'VARIANT' : 'PRODUCT',
        issuerId: source.issuerId,
        operation: 'LOOKUP',
        recordId: source.recordId,
        recordNamespace: source.recordNamespace,
        routeScope: source.routeScope,
      },
      wire.credential,
      wire.requestCorrelation,
      wire.options,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const [item] = result.items;
    if (result.outcome !== 'FOUND' || result.items.length !== 1 || item === undefined) {
      return false;
    }
    if (Option.isSome(variantProduct)) {
      return (
        item.entityKind === 'VARIANT' &&
        item.source.mappingRevision === source.mappingRevision &&
        item.variantId === target.resourceId &&
        sameRef(item.product.productRef, variantProduct.value) &&
        item.product.variants.some((variant) => sameRef(variant.variantRef, target))
      );
    }
    return sameRef(item.product.productRef, target);
  },
);

const priceOutcome = (input: SymmyEffectAdapterInput, outcome: string): SymmyExecutionOutcome =>
  Match.value(outcome).pipe(
    Match.whenOr('CREATED', 'REVISED', 'PRICE_REVISION_CREATED', () => safeOutcome(input, 'accepted_change')),
    Match.whenOr('REUSED', 'UNCHANGED', 'PRICE_REVISION_UNCHANGED', () => safeOutcome(input, 'accepted_no_change')),
    Match.when('CONFLICT', () => safeOutcome(input, 'conflict')),
    Match.when('EFFECTIVE_TIME_INVALID', () => safeOutcome(input, 'invalid')),
    Match.orElse(() => safeOutcome(input, 'unresolved')),
  );

const recoveryOutcome = Effect.fn('SymmyOwnerAdapters.recoveryOutcome')(function* recover(
  input: SymmyEffectAdapterInput,
  requestIntent: SymmyCatalogPricingInventoryIntent,
  wire: GatewayAttempt,
  invocationId: string,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const { credential, options, requestCorrelation } = wire;
  const catalogRequest = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ invocationId: ProductActionInvocationIdSchema }),
  )({ invocationId }).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  return yield* Match.value(requestIntent).pipe(
    Match.tags({
      CatalogBindInitialVariantSource: Effect.fn('SymmyOwnerAdapters.CatalogBindInitialVariantSource')(
        function* CatalogBindInitialVariantSource() {
          const result = yield* executeBindInitialVariantSourceRecoveryWithAuthorization(
            catalogRequest,
            credential,
            requestCorrelation,
            options,
          ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
          return initialVariantBindingOutcome(input, result);
        },
      ),
      CatalogCorrectProduct: Effect.fn('SymmyOwnerAdapters.CatalogCorrectProduct')(function* CatalogCorrectProduct() {
        const result = yield* executeCorrectProductRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      CatalogCreateProduct: Effect.fn('SymmyOwnerAdapters.CatalogCreateProduct')(function* CatalogCreateProduct() {
        const result = yield* executeCreateProductRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        const businessOriginalCreateId = yield* captureCreatedProduct(input, result, contract, crypto, invocationId);
        if (Option.isNone(businessOriginalCreateId)) {
          return safeOutcome(input, 'unresolved');
        }
        return createdSourceOutcome(input, invocationId, businessOriginalCreateId.value);
      }),
      CatalogCreateVariant: Effect.fn('SymmyOwnerAdapters.CatalogCreateVariant')(function* CatalogCreateVariant() {
        const result = yield* executeCreateVariantRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (result.businessOriginalCreateInvocationId === undefined) {
          return yield* symmyJobWorkerUnavailable();
        }
        yield* input.recordOwnerReceipt({
          _tag: 'VariantCreated',
          productRef: result.variant.productRef,
          variantRef: result.variant.variantRef,
        });
        return createdSourceOutcome(input, invocationId, result.businessOriginalCreateInvocationId);
      }),
      CatalogCreateVariantFromProductEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogProductDependentEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogReadinessAxes: Effect.fn('SymmyOwnerAdapters.recoverReadinessAxes')(function* recoverAxes() {
        const result = yield* executeGovernVariantAxesRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        yield* input.recordOwnerReceipt({ _tag: 'ReadinessAxes', axisRevision: result.axisRevision });
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      CatalogReadinessConfirm: Effect.fn('SymmyOwnerAdapters.recoverReadinessConfirm')(function* recoverConfirm() {
        const receipt = yield* executeConfirmVariantCombinationRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return yield* Match.value(receipt).pipe(
          Match.tags({
            CurrentReceipt: Effect.fn('SymmyOwnerAdapters.currentConfirmationReceipt')(
              function* currentConfirmationReceipt({ result }) {
                if (result.variantRevision === undefined) {
                  return yield* symmyJobWorkerUnavailable();
                }
                yield* input.recordOwnerReceipt({ _tag: 'ReadinessVariant', variantRevision: result.variantRevision });
                return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
              },
            ),
            HistoricalReceipt: () => Effect.succeed(safeOutcome(input, 'unresolved')),
          }),
          Match.exhaustive,
        );
      }),
      CatalogReadinessName: Effect.fn('SymmyOwnerAdapters.recoverReadinessName')(function* recoverName() {
        const result = yield* executeSetProductLocalizedFactsRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      CatalogReadinessUnit: Effect.fn('SymmyOwnerAdapters.recoverReadinessUnit')(function* recoverUnit() {
        const receipt = yield* executeSetProductUnitTargetDivisibilityRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return Match.value(receipt).pipe(
          Match.tags({
            CurrentReceipt: ({ result }) =>
              safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change'),
            HistoricalReceipt: () => safeOutcome(input, 'unresolved'),
          }),
          Match.exhaustive,
        );
      }),
      CatalogReadinessUntyped: Effect.fn('SymmyOwnerAdapters.recoverReadinessUntyped')(function* recoverUntyped() {
        const receipt = yield* executeDecideProductTypeUnnecessaryRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return Match.value(receipt).pipe(
          Match.tags({
            CurrentReceipt: ({ result }) =>
              safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change'),
            HistoricalReceipt: () => safeOutcome(input, 'unresolved'),
          }),
          Match.exhaustive,
        );
      }),
      CatalogSetVariantLocalizedFacts: Effect.fn('SymmyOwnerAdapters.recoverVariantLocalizedFacts')(
        function* recoverVariantLocalizedFacts() {
          const result = yield* executeSetVariantLocalizedFactsRecoveryWithAuthorization(
            catalogRequest,
            credential,
            requestCorrelation,
            options,
          ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
          return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
        },
      ),
      CatalogUpdateProduct: Effect.fn('SymmyOwnerAdapters.CatalogUpdateProduct')(function* CatalogUpdateProduct() {
        const result = yield* executeUpdateProductRecoveryWithAuthorization(
          catalogRequest,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (input.effect.effectKey === readinessActivateKey) {
          yield* input.recordOwnerReceipt({ _tag: 'ReadinessProduct', productRevision: result.product.revision });
        }
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      InventoryImport: Effect.fn('SymmyOwnerAdapters.InventoryImport')(function* InventoryImport(intent) {
        const actionInvocationId = yield* Schema.decodeUnknownEffect(InventorySourceImportActionInvocationIdSchema)(
          invocationId,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        const [proposal] = intent.payload.items;
        if (proposal === undefined) {
          return yield* symmyJobWorkerInvalid();
        }
        const result = yield* executeInventorySourceImportReceiptWithAuthorization(
          { actionInvocationId, itemIndex: 0, proposal },
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return yield* Match.value(result).pipe(
          Match.tag('RECORDED', ({ receipt }) => Effect.succeed(projectSymmyInventoryOutcome(input, receipt.outcome))),
          Match.tag('INDETERMINATE', () => Effect.fail(symmyJobWorkerUnavailable())),
          Match.exhaustive,
        );
      }),
      InventoryProvision: Effect.fn('SymmyOwnerAdapters.recoverProvision')(function* recoverProvision({ payload }) {
        const request = yield* Schema.decodeUnknownEffect(SourceStockItemProvisioningReceiptRequestSchema)({
          actionInvocationId: invocationId,
          input: payload,
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        const result = yield* executeSourceStockItemProvisioningReceiptWithAuthorization(
          request,
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return yield* Match.value(result).pipe(
          Match.tag('INDETERMINATE', () => Effect.fail(symmyJobWorkerUnavailable())),
          Match.tag('RECORDED', ({ receipt }) =>
            receipt.actionInvocationId === invocationId &&
            computeCanonicalValueHash(receipt.input) === computeCanonicalValueHash(payload)
              ? Effect.succeed(provisioningOutcome(input, receipt.provisioning))
              : Effect.fail(symmyJobWorkerUnavailable()),
          ),
          Match.exhaustive,
        );
      }),
      PriceDefine: Effect.fn('SymmyOwnerAdapters.PriceDefine')(function* PriceDefine() {
        const result = yield* executePriceSourceResultLookupWithAuthorization(
          { actionInvocationId: invocationId },
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (result.outcome !== 'PRICE_ACTION_RESULT_FOUND') {
          return yield* symmyJobWorkerUnavailable();
        }
        return priceOutcome(input, result.result.outcome);
      }),
      PriceDefineFromGroupEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupCreate: Effect.fn('SymmyOwnerAdapters.PriceGroupCreate')(function* PriceGroupCreate() {
        const result = yield* executePriceGroupResultLookupWithAuthorization(
          { actionInvocationId: invocationId },
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (
          result.outcome !== 'PRICE_GROUP_OPERATION_FOUND' ||
          result.receipt.actionInvocationId !== invocationId ||
          result.receipt.operationKind !== 'CREATE_PRICE_GROUP'
        ) {
          return yield* symmyJobWorkerUnavailable();
        }
        yield* input.recordOwnerReceipt({
          _tag: 'PriceGroupCreated',
          actionInvocationId: result.receipt.actionInvocationId,
          businessOriginalInvocationId:
            result.receipt.businessOriginalInvocationId ?? result.receipt.actionInvocationId,
          priceGroupRef: result.receipt.priceGroupRef,
        });
        return createdSourceOutcome(
          input,
          invocationId,
          result.receipt.businessOriginalInvocationId ?? result.receipt.actionInvocationId,
        );
      }),
      PriceGroupCreateAtCatalogHead: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupRevise: Effect.fn('SymmyOwnerAdapters.PriceGroupRevise')(function* PriceGroupRevise() {
        const result = yield* executePriceGroupResultLookupWithAuthorization(
          { actionInvocationId: invocationId },
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (
          result.outcome !== 'PRICE_GROUP_OPERATION_FOUND' ||
          result.receipt.operationKind !== 'CREATE_DEFINITION_REVISION'
        ) {
          return yield* symmyJobWorkerUnavailable();
        }
        return createdSourceOutcome(
          input,
          invocationId,
          result.receipt.businessOriginalInvocationId ?? result.receipt.actionInvocationId,
        );
      }),
      PriceRevise: Effect.fn('SymmyOwnerAdapters.PriceRevise')(function* PriceRevise() {
        const result = yield* executePriceSourceResultLookupWithAuthorization(
          { actionInvocationId: invocationId },
          credential,
          requestCorrelation,
          options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        if (result.outcome !== 'PRICE_ACTION_RESULT_FOUND') {
          return yield* symmyJobWorkerUnavailable();
        }
        return priceOutcome(input, result.result.outcome);
      }),
    }),
    Match.exhaustive,
  );
});

const recoveryReadRequestHash = Effect.fn('SymmyOwnerAdapters.recoveryReadRequestHash')(function* readHash(
  requestIntent: SymmyCatalogPricingInventoryIntent,
  invocationId: string,
) {
  const catalog = Schema.decodeUnknownEffect(CreateProductRecoveryRequestSchema)({ invocationId });
  const price = Schema.decodeUnknownEffect(PriceSourceResultLookupRequestSchema)({ actionInvocationId: invocationId });
  const group = Schema.decodeUnknownEffect(PriceGroupResultLookupRequestSchema)({ actionInvocationId: invocationId });
  const result = yield* Match.value(requestIntent).pipe(
    Match.tags({
      CatalogBindInitialVariantSource: () => catalog,
      CatalogCorrectProduct: () => catalog,
      CatalogCreateProduct: () => catalog,
      CatalogCreateVariant: () => catalog,
      CatalogCreateVariantFromProductEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogProductDependentEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogReadinessAxes: () => catalog,
      CatalogReadinessConfirm: () => catalog,
      CatalogReadinessName: () => catalog,
      CatalogReadinessUnit: () => catalog,
      CatalogReadinessUntyped: () => catalog,
      CatalogSetVariantLocalizedFacts: () => catalog,
      CatalogUpdateProduct: () => catalog,
      InventoryImport: ({ payload }) => {
        const [proposal] = payload.items;
        return proposal === undefined
          ? Effect.fail(symmyJobWorkerInvalid())
          : Schema.encodeUnknownEffect(InventorySourceImportReceiptRequestSchema)({
              actionInvocationId: invocationId,
              itemIndex: 0,
              proposal,
            }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(InventorySourceImportReceiptRequestSchema)));
      },
      InventoryProvision: ({ payload }) =>
        Schema.decodeUnknownEffect(SourceStockItemProvisioningReceiptRequestSchema)({
          actionInvocationId: invocationId,
          input: payload,
        }),
      PriceDefine: () => price,
      PriceDefineFromGroupEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupCreate: () => group,
      PriceGroupCreateAtCatalogHead: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupRevise: () => group,
      PriceRevise: () => price,
    }),
    Match.exhaustive,
    Effect.mapError(symmyJobWorkerUnavailable),
  );
  return computeCanonicalValueHash(result);
});

const freshRecoveryGateway = Effect.fn('SymmyOwnerAdapters.freshRecoveryGateway')(function* recoveryGateway(
  input: SymmyEffectAdapterInput,
  intent: SymmyCatalogPricingInventoryIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
  invocationId: string,
) {
  if (
    input.originalExecutorPrincipalId === undefined ||
    input.originalRequestHash === undefined ||
    input.originalAuthContextRef === undefined
  ) {
    return yield* symmyJobWorkerUnavailable();
  }
  const requestHash = yield* recoveryReadRequestHash(intent, invocationId);
  const requestCorrelation = yield* crypto.randomUUIDv4().pipe(Effect.mapError(symmyJobWorkerUnavailable));
  type RecoverySubject = Extract<GatewayDelegationSubject, { readonly _tag: 'RegisteredRecovery' }>;
  let source: RecoverySubject['source'] =
    input.context === undefined
      ? { ...input.admission, _tag: 'Admission' }
      : { _tag: 'Worker', context: input.context };
  const legalEntityId = contract.audience === 'pricing' ? input.legalEntityId : undefined;
  if (legalEntityId !== undefined) {
    source = { ...source, legalEntityId };
  }
  const gateway = yield* acquireDelegatedGatewayContext(
    {
      audience: contract.audience,
      legalEntityScope: legalEntityId === undefined ? 'tenant' : 'subject',
      requestCorrelation,
      subject: {
        _tag: 'RegisteredRecovery',
        declarationKey: contract.recoveryDeclarationKey,
        operationRequirementKey: symmyOwnerOperationRequirementKey(
          input.context === undefined ? 'admission' : 'worker',
          contract.recoveryEntrypointKey,
        ),
        originalActionKey: contract.entrypointKey,
        originalIdempotencyKey: input.effect.ref.effectId,
        originalPrincipalId: input.originalExecutorPrincipalId,
        originalRequestHash: input.originalRequestHash,
        requestHash,
        source,
      },
    },
    crypto,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  return {
    credential: gateway.authorization,
    machineContext: gateway.machineContext,
    options: {
      baseUrl: gateway.apiBaseUrl,
      compositionRevision: gateway.compositionRevision,
      idempotencyKey: input.effect.ref.effectId,
    },
    requestCorrelation,
  };
});

const executeNative = Effect.fn('SymmyOwnerAdapters.executeNative')(function* execute(
  input: SymmyEffectAdapterInput,
  requestIntent: SymmyCatalogPricingInventoryIntent,
  wire: GatewayAttempt,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const { credential, options, requestCorrelation } = wire;
  return yield* Match.value(requestIntent).pipe(
    Match.tags({
      CatalogBindInitialVariantSource: Effect.fn('SymmyOwnerAdapters.CatalogBindInitialVariantSource')(
        function* CatalogBindInitialVariantSource(intent) {
          const result = yield* executeBindInitialVariantSourceWithAuthorization(
            intent.payload,
            credential,
            requestCorrelation,
            options,
          );
          return 'variantId' in result ? initialVariantBindingOutcome(input, result) : safeOutcome(input, 'unresolved');
        },
      ),
      CatalogCorrectProduct: Effect.fn('SymmyOwnerAdapters.CatalogCorrectProduct')(
        function* CatalogCorrectProduct(intent) {
          const result = yield* executeCorrectProductWithAuthorization(
            intent.payload,
            credential,
            requestCorrelation,
            options,
          );
          if (!('changed' in result)) {
            return safeOutcome(input, 'unresolved');
          }
          return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
        },
      ),
      CatalogCreateProduct: Effect.fn('SymmyOwnerAdapters.CatalogCreateProduct')(
        function* CatalogCreateProduct(intent) {
          const result = yield* executeCreateProductWithAuthorization(
            intent.payload,
            credential,
            requestCorrelation,
            options,
          );
          if (!('product' in result)) {
            return safeOutcome(input, 'unresolved');
          }
          const currentInvocationId = yield* recordCurrentNativeInvocation(input, contract);
          const businessOriginalCreateId = yield* captureCreatedProduct(input, result, contract, crypto);
          if (Option.isNone(businessOriginalCreateId)) {
            return safeOutcome(input, 'unresolved');
          }
          return createdSourceOutcome(input, currentInvocationId, businessOriginalCreateId.value);
        },
      ),
      CatalogCreateVariant: Effect.fn('SymmyOwnerAdapters.CatalogCreateVariant')(
        function* CatalogCreateVariant(intent) {
          const result = yield* executeCreateVariantWithAuthorization(
            intent.payload,
            credential,
            requestCorrelation,
            options,
          );
          if (!('variant' in result)) {
            return safeOutcome(input, 'unresolved');
          }
          const currentInvocationId = yield* recordCurrentNativeInvocation(input, contract);
          if (result.businessOriginalCreateInvocationId === undefined) {
            return yield* symmyJobWorkerUnavailable();
          }
          yield* input.recordOwnerReceipt({
            _tag: 'VariantCreated',
            productRef: result.variant.productRef,
            variantRef: result.variant.variantRef,
          });
          return createdSourceOutcome(input, currentInvocationId, result.businessOriginalCreateInvocationId);
        },
      ),
      CatalogCreateVariantFromProductEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogProductDependentEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogReadinessAxes: Effect.fn('SymmyOwnerAdapters.readinessAxes')(function* axes({ payload }) {
        const result = yield* executeGovernVariantAxesWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        if (!('axisRevision' in result)) {
          return safeOutcome(input, 'unresolved');
        }
        yield* input.recordOwnerReceipt({ _tag: 'ReadinessAxes', axisRevision: result.axisRevision });
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      CatalogReadinessConfirm: Effect.fn('SymmyOwnerAdapters.readinessConfirm')(function* confirm({ payload }) {
        const result = yield* executeConfirmVariantCombinationWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        if (!('variant' in result) || result.variantRevision === undefined) {
          return yield* symmyJobWorkerUnavailable();
        }
        yield* input.recordOwnerReceipt({ _tag: 'ReadinessVariant', variantRevision: result.variantRevision });
        return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
      }),
      CatalogReadinessName: Effect.fn('SymmyOwnerAdapters.readinessName')(function* name({ payload }) {
        const result = yield* executeSetProductLocalizedFactsWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        return 'changed' in result
          ? safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change')
          : safeOutcome(input, 'unresolved');
      }),
      CatalogReadinessUnit: Effect.fn('SymmyOwnerAdapters.readinessUnit')(function* unit({ payload }) {
        const result = yield* executeSetProductUnitTargetDivisibilityWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        return 'unit' in result
          ? safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change')
          : safeOutcome(input, 'unresolved');
      }),
      CatalogReadinessUntyped: Effect.fn('SymmyOwnerAdapters.readinessUntyped')(function* untyped({ payload }) {
        const result = yield* executeDecideProductTypeUnnecessaryWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        return 'decisionRevision' in result
          ? safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change')
          : safeOutcome(input, 'unresolved');
      }),
      CatalogSetVariantLocalizedFacts: Effect.fn('SymmyOwnerAdapters.setVariantLocalizedFacts')(
        function* setVariantLocalizedFacts({ payload }) {
          const result = yield* executeSetVariantLocalizedFactsWithAuthorization(
            payload,
            credential,
            requestCorrelation,
            options,
          );
          if (!('changed' in result)) {
            return safeOutcome(input, 'unresolved');
          }
          return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
        },
      ),
      CatalogUpdateProduct: Effect.fn('SymmyOwnerAdapters.CatalogUpdateProduct')(
        function* CatalogUpdateProduct(intent) {
          const result = yield* executeUpdateProductWithAuthorization(
            intent.payload,
            credential,
            requestCorrelation,
            options,
          );
          if (!('changed' in result)) {
            return safeOutcome(input, 'unresolved');
          }
          if (input.effect.effectKey === readinessActivateKey) {
            yield* input.recordOwnerReceipt({ _tag: 'ReadinessProduct', productRevision: result.product.revision });
          }
          return safeOutcome(input, result.changed ? 'accepted_change' : 'accepted_no_change');
        },
      ),
      InventoryImport: Effect.fn('SymmyOwnerAdapters.InventoryImport')(function* InventoryImport(intent) {
        const result = yield* executeImportSourceAssertionWithAuthorization(
          intent.payload,
          credential,
          requestCorrelation,
          options,
        );
        if (!('items' in result) || result.items.length !== 1 || result.items[0] === undefined) {
          return yield* symmyJobWorkerUnavailable();
        }
        return projectSymmyInventoryOutcome(input, result.items[0]);
      }),
      InventoryProvision: Effect.fn('SymmyOwnerAdapters.provision')(function* provision({ payload }) {
        const result = yield* executeProvisionSourceStockItemWithAuthorization(
          payload,
          credential,
          requestCorrelation,
          options,
        );
        if (!('stockItem' in result)) {
          return yield* symmyJobWorkerUnavailable();
        }
        return provisioningOutcome(input, result);
      }),
      PriceDefine: Effect.fn('SymmyOwnerAdapters.PriceDefine')(function* PriceDefine(intent) {
        const result = yield* executeDefinePriceWithAuthorization(
          intent.payload,
          credential,
          requestCorrelation,
          options,
        );
        const currentInvocationId = yield* recordCurrentNativeInvocation(input, contract);
        return yield* Match.value(result).pipe(
          Match.when(
            { outcome: 'PRICE_SOURCE_ASSERTION_CANONICAL_ACCEPTED' },
            Effect.fn('SymmyOwnerAdapters.resolveCanonicalPriceReceipt')(function* resolveCanonicalPriceReceipt() {
              const recoveryWire = yield* freshRecoveryGateway(input, intent, contract, crypto, currentInvocationId);
              return yield* recoveryOutcome(input, intent, recoveryWire, currentInvocationId, contract, crypto);
            }),
          ),
          Match.when({ outcome: 'PRICE_SOURCE_ASSERTION_KNOWN_INVALID' }, () =>
            Effect.succeed(safeOutcome(input, 'invalid')),
          ),
          Match.when({ outcome: 'PRICE_SOURCE_ASSERTION_UNRESOLVED_HELD' }, () =>
            Effect.succeed(safeOutcome(input, 'unresolved')),
          ),
          Match.when({ outcome: 'PRICE_SOURCE_ASSERTION_DEPENDENCY_UNAVAILABLE' }, () =>
            Effect.succeed(safeOutcome(input, 'unavailable')),
          ),
          Match.orElse(() => Effect.fail(symmyJobWorkerUnavailable())),
        );
      }),
      PriceDefineFromGroupEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupCreate: Effect.fn('SymmyOwnerAdapters.PriceGroupCreate')(function* PriceGroupCreate(intent) {
        const result = yield* executeCreatePriceGroupWithAuthorization(
          intent.payload,
          credential,
          requestCorrelation,
          options,
        );
        if ('invocationId' in result) {
          yield* input.recordInvocationId(result.invocationId);
          return yield* symmyJobWorkerUnavailable();
        }
        const currentInvocationId = yield* recordCurrentNativeInvocation(input, contract);
        const recoveryWire = yield* freshRecoveryGateway(input, intent, contract, crypto, currentInvocationId);
        return yield* recoveryOutcome(input, intent, recoveryWire, currentInvocationId, contract, crypto);
      }),
      PriceGroupCreateAtCatalogHead: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupRevise: Effect.fn('SymmyOwnerAdapters.PriceGroupRevise')(function* PriceGroupRevise(intent) {
        const result = yield* executeCreatePriceGroupDefinitionRevisionWithAuthorization(
          intent.payload,
          credential,
          requestCorrelation,
          options,
        );
        if ('invocationId' in result) {
          yield* input.recordInvocationId(result.invocationId);
          return yield* symmyJobWorkerUnavailable();
        }
        const currentInvocationId = yield* recordCurrentNativeInvocation(input, contract);
        return createdSourceOutcome(
          input,
          currentInvocationId,
          result.businessOriginalInvocationId ?? result.created.actionInvocationId,
        );
      }),
      PriceRevise: Effect.fn('SymmyOwnerAdapters.PriceRevise')(function* PriceRevise(intent) {
        const result = yield* executeRevisePriceWithAuthorization(
          intent.payload,
          credential,
          requestCorrelation,
          options,
        );
        return 'outcome' in result ? priceOutcome(input, result.outcome) : safeOutcome(input, 'unresolved');
      }),
    }),
    Match.exhaustive,
  );
});

type OriginalPrincipalFacts = Parameters<typeof computeActionRequestHash>[0]['principal'];

/** Pure native command fingerprint; this is checksum data, never a trusted Principal or permission. */
export const prepareSymmyCatalogPricingInventoryRequestHash = Effect.fn(
  'SymmyOwnerAdapters.prepareOriginalRequestHash',
)(function* prepareHash(
  requestIntent: SymmyCatalogPricingInventoryIntent,
  principal: OriginalPrincipalFacts,
  operationLegalEntityId?: string,
) {
  const tenantPrincipal = { principalId: principal.principalId, tenantId: principal.tenantId };
  const catalogReadinessHash = <Decoded, Encoded>(
    actionKey: string,
    schema: Schema.Codec<Decoded, Encoded>,
    payload: Decoded,
  ) =>
    Schema.encodeEffect(schema)(payload).pipe(
      Effect.map((normalizedPayload) =>
        computeActionRequestHash({
          actionKey,
          normalizedPayload,
          owningModuleKey: catalogModuleId,
          principal: tenantPrincipal,
          schemaVersion: '1',
          target: {},
        }),
      ),
    );
  const priceLegalEntity: Effect.Effect<string, ReturnType<typeof symmyJobWorkerInvalid>> = operationLegalEntityId ===
  undefined
    ? Effect.fail(symmyJobWorkerInvalid())
    : Effect.succeed(operationLegalEntityId);
  return yield* Match.value(requestIntent).pipe(
    Match.tags({
      CatalogBindInitialVariantSource: ({ payload }) =>
        bindInitialVariantSourceRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      CatalogCorrectProduct: ({ payload }) =>
        correctProductRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      CatalogCreateProduct: ({ payload }) =>
        createProductRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      CatalogCreateVariant: ({ payload }) =>
        createVariantRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      CatalogCreateVariantFromProductEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogProductDependentEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      CatalogReadinessAxes: ({ payload }) =>
        catalogReadinessHash('commerce.catalog.govern-variant-axes', GovernVariantAxesPayloadSchema, payload),
      CatalogReadinessConfirm: ({ payload }) =>
        catalogReadinessHash(
          'commerce.catalog.confirm-variant-combination',
          ConfirmVariantCombinationPayloadSchema,
          payload,
        ),
      CatalogReadinessName: ({ payload }) =>
        catalogReadinessHash(
          'commerce.catalog.set-product-localized-facts',
          SetProductLocalizedFactsPayloadSchema,
          payload,
        ),
      CatalogReadinessUnit: ({ payload }) =>
        catalogReadinessHash(
          'commerce.catalog.set-product-unit-target-divisibility',
          SetProductUnitTargetDivisibilityPayloadSchema,
          payload,
        ),
      CatalogReadinessUntyped: ({ payload }) =>
        catalogReadinessHash(
          'commerce.catalog.decide-product-type-unnecessary',
          DecideProductTypeUnnecessaryPayloadSchema,
          payload,
        ),
      CatalogSetVariantLocalizedFacts: ({ payload }) =>
        setVariantLocalizedFactsRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      CatalogUpdateProduct: ({ payload }) =>
        updateProductRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      InventoryImport: ({ payload }) =>
        prepareImportSourceAssertionRequestIdentity(payload).pipe(
          Effect.map((identity) => computeActionRequestHash({ ...identity, principal: tenantPrincipal })),
        ),
      InventoryProvision: ({ payload }) =>
        Schema.encodeEffect(ProvisionSourceStockItemPayloadSchema)(payload).pipe(
          Effect.map((normalizedPayload) =>
            computeActionRequestHash({
              actionKey: inventoryProvisionActionKey,
              normalizedPayload,
              owningModuleKey: inventoryModuleId,
              principal: tenantPrincipal,
              schemaVersion: '1',
              target: {},
            }),
          ),
        ),
      PriceDefine: ({ payload }) =>
        priceLegalEntity.pipe(
          Effect.flatMap((legalEntity) =>
            prepareDefinePriceOriginalRequestIdentity(payload, tenantPrincipal, legalEntity),
          ),
          Effect.map((identity) => identity.requestHash),
        ),
      PriceDefineFromGroupEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupCreate: ({ payload }) =>
        prepareCreatePriceGroupOriginalRequestIdentity(payload, tenantPrincipal).pipe(
          Effect.map((identity) => identity.requestHash),
        ),
      PriceGroupCreateAtCatalogHead: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupRevise: ({ payload }) =>
        prepareCreatePriceGroupDefinitionRevisionOriginalRequestIdentity(payload, tenantPrincipal).pipe(
          Effect.map((identity) => identity.requestHash),
        ),
      PriceRevise: ({ payload }) =>
        priceLegalEntity.pipe(
          Effect.flatMap((legalEntity) =>
            prepareRevisePriceOriginalRequestIdentity(payload, tenantPrincipal, legalEntity),
          ),
          Effect.map((identity) => identity.requestHash),
        ),
    }),
    Match.exhaustive,
    Effect.mapError(symmyJobWorkerUnavailable),
  );
});

const listPriceWriteTag = Schema.Literals(['PriceDefine', 'PriceRevise']);

/** The price list a price of the batch route is written to. The body names it, the route enrollment never does. */
const requestedPriceGroup = (requestIntent: SymmyCatalogPricingInventoryIntent) =>
  Match.value(requestIntent).pipe(
    Match.tag('PriceDefine', ({ payload }) => {
      const selector = payload.identityKey.priceGroupSelector;
      return selector.kind === 'PRICE_GROUP' ? Option.some(selector.priceGroupRef) : Option.none();
    }),
    Match.tag('PriceRevise', ({ priceGroupRef }) => Option.fromNullishOr(priceGroupRef)),
    Match.orElse(() => Option.none()),
  );

/** The price list the owner holds the price in now, or none when the price is not current in any list. */
const readCurrentPriceGroup = Effect.fn('SymmyOwnerAdapters.readCurrentPriceGroup')(function* readCurrentGroup(
  input: SymmyEffectAdapterInput,
  priceRef: Extract<SymmyCatalogPricingInventoryIntent, { readonly _tag: 'PriceRevise' }>['payload']['priceRef'],
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const wire = yield* freshGateway(
    input,
    {
      ...contract,
      recoveryDeclarationKey: 'commerce.pricing.price.read-definition',
      recoveryEntrypointKey: 'commerce.pricing.api.price-definition',
    },
    true,
    crypto,
  );
  const result = yield* executePriceDefinitionWithAuthorization(
    { priceRef },
    wire.credential,
    wire.requestCorrelation,
    wire.options,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  return Match.value(result).pipe(
    Match.when({ outcome: 'PRICE_DEFINITION_CURRENT' }, ({ definition }) => {
      const selector = definition.identityKey.priceGroupSelector;
      return selector.kind === 'PRICE_GROUP' ? Option.some(selector.priceGroupRef) : Option.none();
    }),
    Match.orElse(() => Option.none()),
  );
});

const sourceAssociationPageSize = 100;
/**
 * Whether Price Group Catalog holds the group as a list this route's source created: an association with the
 * issuer, namespace and source route of the price. The pages are read in order until the group is found.
 */
const sourceCreatedPriceGroup = Effect.fn('SymmyOwnerAdapters.sourceCreatedPriceGroup')(function* sourceCreatedGroup(
  input: SymmyEffectAdapterInput,
  priceGroupRef: Parameters<typeof sameRef>[0],
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const { record } = input.effect.ref.occurrence;
  const groupContract = {
    ...contract,
    audience: priceGroupAudience,
    recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-source-associations.read',
    recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
  };
  const readPage = Effect.fn('SymmyOwnerAdapters.readSourceAssociations')(function* readAssociations(offset: number) {
    const wire = yield* freshGateway(input, groupContract, true, crypto);
    const page = yield* executePriceGroupSourceAssociationsWithAuthorization(
      {
        issuer: record.issuerId,
        limit: sourceAssociationPageSize,
        namespace: record.sourceNamespace,
        offset,
        routeId: record.route.integrationRouteId,
      },
      wire.credential,
      wire.requestCorrelation,
      wire.options,
    ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
    const next = offset + page.associations.length;
    return [
      [page],
      page.associations.length === 0 || next >= page.count ? Option.none<number>() : Option.some(next),
    ] as const;
  });
  const found = yield* Stream.paginate(0, readPage).pipe(
    Stream.filter(({ associations }) =>
      associations.some((association) => sameRef(association.priceGroupRef, priceGroupRef)),
    ),
    Stream.runHead,
  );
  return Option.isSome(found);
});

/**
 * A price of the batch route is written only to the list its body named, and only when that list was created
 * by this route's own source. A REVISE additionally needs the price to be current in that same list.
 */
const verifyBatchPriceGroup = Effect.fn('SymmyOwnerAdapters.verifyBatchPriceGroup')(function* batchPriceGroup(
  input: SymmyEffectAdapterInput,
  requestIntent: SymmyCatalogPricingInventoryIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  if (input.routeKey !== 'priceListPricesBatch' || !Schema.is(listPriceWriteTag)(requestIntent._tag)) {
    return true;
  }
  const requested = requestedPriceGroup(requestIntent);
  if (Option.isNone(requested) || requested.value.tenantId !== input.effect.ref.occurrence.record.route.tenantId) {
    return false;
  }
  const revised = Match.value(requestIntent).pipe(
    Match.tag('PriceRevise', ({ payload }) => Option.some(payload.priceRef)),
    Match.orElse(() => Option.none()),
  );
  if (Option.isSome(revised)) {
    const current = yield* readCurrentPriceGroup(input, revised.value, contract, crypto);
    if (Option.isNone(current) || !sameRef(current.value, requested.value)) {
      return false;
    }
  }
  return yield* sourceCreatedPriceGroup(input, requested.value, contract, crypto);
});

type PriceGroupAtHeadIntent = Extract<
  SymmyCatalogPricingInventoryIntent,
  { readonly _tag: 'PriceGroupCreateAtCatalogHead' }
>;
type PriceFromGroupIntent = Extract<
  SymmyCatalogPricingInventoryIntent,
  { readonly _tag: 'PriceDefineFromGroupEffect' }
>;
const requireCreatedGroupDependency = Effect.fn('SymmyOwnerAdapters.requireCreatedGroupDependency')(
  function* groupParent(input: SymmyEffectAdapterInput, intent: PriceFromGroupIntent) {
    const parents = input.dependencies.filter(
      (parent) =>
        parent.itemKey === intent.fromPriceGroupEffect.itemKey &&
        parent.effect.effectKey === intent.fromPriceGroupEffect.effectKey,
    );
    const [parent] = parents;
    if (parents.length !== 1 || parent === undefined || parent.state !== 'settled' || Option.isNone(parent.outcome)) {
      return yield* symmyJobWorkerInvalid();
    }
    if (
      !Schema.is(settledParentOutcomeSchema)(parent.outcome.value.status) ||
      !hasDeclaredParentDependency(input.effect, parent.effect.itemId, intent.fromPriceGroupEffect)
    ) {
      return yield* symmyJobWorkerInvalid();
    }
    // The admitted parent is a create whose fence the adapter resolved when it ran, or one that never needed it.
    const parentIntent = yield* Schema.decodeUnknownEffect(
      Schema.Union([
        SymmyCatalogPricingInventoryIntentSchema.members[5],
        SymmyCatalogPricingInventoryIntentSchema.members[14],
      ]),
    )(parent.effect.intent).pipe(Effect.mapError(symmyJobWorkerInvalid));
    const receipt = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryReceiptSchema.members[2])(
      Option.getOrUndefined(Option.flatten(Option.fromUndefinedOr(parent.ownerReceipt))),
    ).pipe(Effect.mapError(symmyJobWorkerInvalid));
    const originalInvocationId = Option.getOrUndefined(
      Option.flatten(Option.fromUndefinedOr(parent.ownerInvocationId)),
    );
    if (
      receipt.actionInvocationId !== originalInvocationId ||
      receipt.priceGroupRef.tenantId !== input.effect.ref.occurrence.record.route.tenantId ||
      parent.effect.ref.operation.entrypointKey !== 'pricing.price-group-catalog.create-price-group' ||
      parent.effect.ref.operation.moduleId !== priceGroupModuleId ||
      !priceGroupSourceMatches({ ...input, effect: parent.effect }, parentIntent.payload.sourceCorrelation)
    ) {
      return yield* symmyJobWorkerInvalid();
    }
    const source = parentIntent.payload.sourceCorrelation;
    if (source === undefined) {
      return yield* symmyJobWorkerInvalid();
    }
    return { receipt, source };
  },
);

const readCreatedPriceGroup = Effect.fn('SymmyOwnerAdapters.readCreatedPriceGroup')(function* readCreatedGroup(
  input: SymmyEffectAdapterInput,
  intent: PriceFromGroupIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const { receipt, source } = yield* requireCreatedGroupDependency(input, intent);
  const wire = yield* freshGateway(
    input,
    {
      ...contract,
      audience: priceGroupAudience,
      moduleId: priceGroupModuleId,
      recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-source-associations.read',
      recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
    },
    true,
    crypto,
  );
  const bound = yield* executePriceGroupSourceAssociationsWithAuthorization(
    {
      issuer: source.issuer,
      limit: 2,
      namespace: source.namespace,
      offset: 0,
      recordKey: source.recordKey,
      routeId: source.routeId,
    },
    wire.credential,
    wire.requestCorrelation,
    wire.options,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const [association] = bound.associations;
  if (
    bound.count !== 1 ||
    bound.associations.length !== 1 ||
    association === undefined ||
    !sameRef(association.priceGroupRef, receipt.priceGroupRef) ||
    !samePriceGroupBinding(association.sourceCorrelation, source)
  ) {
    return yield* symmyJobWorkerInvalid();
  }
  return receipt.priceGroupRef;
});

/**
 * Reads the tenant catalog head right before a Price Group is created, so the fence of every create is the head
 * the create actually meets, whichever lists before it were created, existed already or ended otherwise.
 */
const readCatalogHead = Effect.fn('SymmyOwnerAdapters.readCatalogHead')(function* readHead(
  input: SymmyEffectAdapterInput,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const wire = yield* freshGateway(
    input,
    {
      ...contract,
      audience: priceGroupAudience,
      moduleId: priceGroupModuleId,
      recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-catalog-head.read',
      recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-catalog-head',
    },
    true,
    crypto,
  );
  const head = yield* executePriceGroupCatalogHeadWithAuthorization(
    {},
    wire.credential,
    wire.requestCorrelation,
    wire.options,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  return head.catalogRevision;
});

const resolveGroupDependency = Effect.fn('SymmyOwnerAdapters.resolveGroupDependency')(function* resolveGroup(
  input: SymmyEffectAdapterInput,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  const requestIntent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema)(
    input.effect.intent,
  ).pipe(Effect.mapError(symmyJobWorkerInvalid));
  return yield* Match.value(requestIntent).pipe(
    Match.tag(
      'PriceGroupCreateAtCatalogHead',
      Effect.fn('SymmyOwnerAdapters.resolveCatalogHead')(function* materializeFence(intent: PriceGroupAtHeadIntent) {
        // A resolved fence is recorded before the owner call and a resumed effect carries it, so only a new one resolves.
        if (
          input.originalExecutorPrincipalId !== undefined ||
          input.originalInvocationId !== undefined ||
          !input.canExecuteNewEffects ||
          input.effect.ref.originalTarget !== undefined
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const payload = yield* Schema.decodeUnknownEffect(CreatePriceGroupPayloadSchema)({
          ...intent.payload,
          expectedCatalogRevision: yield* readCatalogHead(input, contract, crypto),
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        const effect = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
          ...input.effect,
          intent: { _tag: 'PriceGroupCreate', payload },
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        yield* input.recordResolvedEffect(effect);
        return { ...input, effect };
      }),
    ),
    Match.tag(
      'PriceDefineFromGroupEffect',
      Effect.fn('SymmyOwnerAdapters.resolvePriceGroupParent')(function* materializePrice(intent: PriceFromGroupIntent) {
        if (
          input.originalExecutorPrincipalId !== undefined ||
          input.originalInvocationId !== undefined ||
          !input.canExecuteNewEffects ||
          input.effect.ref.originalTarget === undefined ||
          !sameRef(input.effect.ref.originalTarget, intent.payload.priceRef) ||
          !priceSourceMatches(input, intent.payload.sourceAssertion) ||
          input.legalEntityId !== intent.payload.identityKey.commercialScope.sellingLegalEntityId
        ) {
          return yield* symmyJobWorkerInvalid();
        }
        const priceGroupRef = yield* readCreatedPriceGroup(input, intent, contract, crypto);
        const payload = yield* Schema.decodeUnknownEffect(DefinePricePayloadSchema)({
          ...intent.payload,
          identityKey: {
            ...intent.payload.identityKey,
            priceGroupSelector: { kind: 'PRICE_GROUP', priceGroupRef },
          },
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        const effect = yield* Schema.decodeUnknownEffect(SymmyPinnedEffectSchema)({
          ...input.effect,
          intent: { _tag: 'PriceDefine', payload },
          ref: { ...input.effect.ref, originalTarget: payload.priceRef },
        }).pipe(Effect.mapError(symmyJobWorkerInvalid));
        yield* input.recordResolvedEffect(effect);
        return { ...input, effect };
      }),
    ),
    Match.orElse(() => Effect.succeed(input)),
  );
});

const priceGroupDependency = (intent: SymmyPinnedEffect['intent']) =>
  Match.value(intent).pipe(
    Match.tag('PriceDefineFromGroupEffect', (selected) => Option.some(selected)),
    Match.orElse(() => Option.none()),
  );

const verifyPriceListDependency = Effect.fn('SymmyOwnerAdapters.verifyPriceListDependency')(function* verifyDependency(
  input: SymmyEffectAdapterInput,
  originalEffect: SymmyPinnedEffect,
  intent: SymmyCatalogPricingInventoryIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  if (input.routeKey !== 'priceListsBatchUpsert' || !Schema.is(listPriceWriteTag)(intent._tag)) {
    return true;
  }
  const requestedGroup = requestedPriceGroup(intent);
  if (Option.isNone(requestedGroup)) {
    return false;
  }
  // Fresh dependency resolution checked the named parent receipt and current owner source binding.
  if (Option.isSome(priceGroupDependency(originalEffect.intent))) {
    return true;
  }
  // A resumed materialized command must still prove that its original admitted intent named that parent.
  const admittedEffect = input.acceptedPlan?.items
    .find((item) => item.itemId === input.effect.itemId)
    ?.effects.find((effect) => effect.ref.effectId === input.effect.ref.effectId);
  const dependency = priceGroupDependency(admittedEffect?.intent);
  if (Option.isNone(dependency)) {
    return false;
  }
  const priceGroupRef = yield* readCreatedPriceGroup(input, dependency.value, contract, crypto);
  return sameRef(priceGroupRef, requestedGroup.value);
});

const isPriceRevise = Schema.is(Schema.TaggedStruct('PriceRevise', {}));
const heldPriceReviseCode = Schema.Literals([
  'price_schedule_absent',
  'price_schedule_acknowledgement_required',
  'revise_price_source_held',
]);
/**
 * The owner refuses a revision as a problem, not as a result: a price it does not hold, a change that needs an
 * acknowledgement it cannot be given, or held source evidence leaves the item unresolved with nothing written, and
 * any other refusal makes the revision invalid. Neither is retried.
 */
const priceReviseRefusalStatus = (error: typeof problemStatus.Type): 'invalid' | 'unresolved' =>
  Schema.is(Schema.Struct({ code: heldPriceReviseCode }))(error) ? 'unresolved' : 'invalid';

const recoverCommandFailure = Effect.fn('SymmyOwnerAdapters.commandFailure')(function* commandFailure(
  input: SymmyEffectAdapterInput,
  intent: SymmyCatalogPricingInventoryIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
  error: Effect.Error<ReturnType<typeof executeNative>>,
) {
  if (Schema.is(committedEvidence)(error)) {
    yield* input.recordInvocationId(error.invocationId);
    const recoveryWire = yield* freshRecoveryGateway(input, intent, contract, crypto, error.invocationId);
    return yield* recoveryOutcome(input, intent, recoveryWire, error.invocationId, contract, crypto);
  }
  if (Schema.is(problemStatus)(error) && (error.status === 401 || error.status === 403)) {
    return safeOutcome(input, 'denied');
  }
  if (
    Schema.is(problemStatus)(error) &&
    (error.status === 400 || error.status === 422) &&
    (Schema.is(SymmyCatalogPricingInventoryIntentSchema.members[15])(intent) ||
      (input.effect.effectKey === readinessActivateKey &&
        Schema.is(SymmyCatalogPricingInventoryIntentSchema.members[2])(intent)) ||
      Schema.is(readinessResolvedIntentSchema)(intent))
  ) {
    return safeOutcome(input, 'invalid');
  }
  if (Schema.is(problemStatus)(error) && error.status === 409) {
    return safeOutcome(input, 'conflict');
  }
  if (Schema.is(problemStatus)(error) && (error.status === 404 || error.status === 422) && isPriceRevise(intent)) {
    return safeOutcome(input, priceReviseRefusalStatus(error));
  }
  return yield* symmyJobWorkerUnavailable(error);
});

const preDispatchStage = Schema.Literals([
  'product-dependency',
  'group-dependency',
  'provisioning-validation',
  'intent-validation',
  'batch-price-group',
  'price-list-dependency',
  'target-validation',
  'fresh-gateway',
  'machine-context',
  'request-hash',
  'request-identity',
  'record-owner-request',
]);

const makeAdapter = (contract: AdapterContract, crypto: Crypto.Crypto): SymmyEffectAdapter => ({
  execute: Effect.fn('SymmyOwnerAdapters.execute')(function* execute(originalInput) {
    const observe = <A, E, R>(stage: typeof preDispatchStage.Type, effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.logInfo('Symmy owner pre-dispatch stage', {
            effectId: originalInput.effect.ref.effectId,
            operation: contract.tag,
            stage,
            status: Exit.isSuccess(exit) ? 'succeeded' : 'failed',
          }).pipe(Effect.ignoreCause),
        ),
      );
    const productInput = yield* observe(
      'product-dependency',
      resolveProductDependency(originalInput, contract, crypto),
    );
    const input = yield* observe('group-dependency', resolveGroupDependency(productInput, contract, crypto));
    yield* observe('provisioning-validation', validateProvisioningResolution(input));
    const intent = yield* observe('intent-validation', checkedIntent(input));
    if (!Schema.is(Schema.Literal(contract.tag))(intent._tag)) {
      return yield* symmyJobWorkerInvalid();
    }
    if (!input.canExecuteNewEffects) {
      return yield* symmyJobWorkerInvalid();
    }
    const batchGroupMatches = yield* observe(
      'batch-price-group',
      verifyBatchPriceGroup(input, intent, contract, crypto),
    );
    if (
      !batchGroupMatches ||
      !(yield* observe(
        'price-list-dependency',
        verifyPriceListDependency(input, originalInput.effect, intent, contract, crypto),
      ))
    ) {
      return safeOutcome(input, 'unresolved');
    }
    const boundTarget = yield* observe(
      'target-validation',
      verifyExistingCatalogTarget(input, intent, contract, crypto),
    );
    if (!boundTarget) {
      return safeOutcome(input, 'unresolved');
    }
    const wire = yield* observe('fresh-gateway', freshGateway(input, contract, false, crypto));
    const machineContext = yield* observe(
      'machine-context',
      wire.machineContext === undefined
        ? Effect.fail(symmyJobWorkerUnavailable())
        : Effect.succeed(wire.machineContext),
    );
    const originalRequestHash = yield* observe(
      'request-hash',
      prepareSymmyCatalogPricingInventoryRequestHash(
        intent,
        { principalId: machineContext.principalId, tenantId: input.effect.ref.occurrence.record.route.tenantId },
        input.legalEntityId,
      ),
    );
    yield* observe(
      'request-identity',
      (input.originalExecutorPrincipalId !== undefined &&
        input.originalExecutorPrincipalId !== machineContext.principalId) ||
        (input.originalAuthContextRef !== undefined &&
          input.originalAuthContextRef !== machineContext.authContextRef) ||
        (input.originalRequestHash !== undefined && input.originalRequestHash !== originalRequestHash)
        ? Effect.fail(symmyJobWorkerInvalid())
        : Effect.void,
    );
    yield* observe(
      'record-owner-request',
      input.recordOwnerRequest({
        authContextRef: machineContext.authContextRef,
        executorPrincipalId: machineContext.principalId,
        requestHash: originalRequestHash,
      }),
    );
    const executionInput = {
      ...input,
      originalAuthContextRef: machineContext.authContextRef,
      originalExecutorPrincipalId: machineContext.principalId,
      originalRequestHash,
    };
    return yield* executeNative(executionInput, intent, wire, contract, crypto).pipe(
      Effect.flatMap((outcome) =>
        Schema.is(
          Schema.Literals([
            'CatalogCreateProduct',
            'CatalogCreateVariant',
            'PriceDefine',
            'PriceGroupCreate',
            'PriceGroupRevise',
          ]),
        )(intent._tag)
          ? Effect.succeed(outcome)
          : recordCurrentNativeInvocation(executionInput, contract).pipe(Effect.as(outcome)),
      ),
      Effect.catch((error) => recoverCommandFailure(executionInput, intent, contract, crypto, error)),
    );
  }),
  operation: {
    entrypointKey: contract.entrypointKey,
    moduleId: contract.moduleId,
    schemaVersion: contract.schemaVersion,
  },
  recover: Effect.fn('SymmyOwnerAdapters.recover')(function* recover(originalInput): Effect.fn.Return<
    SymmyOriginalEffectRecovery,
    ReturnType<typeof symmyJobWorkerUnavailable>
  > {
    yield* validateProvisioningResolution(originalInput);
    const original = yield* readOriginalOwnerAttempt(originalInput);
    if (original.status !== 'committed') {
      return original;
    }
    const productInput = yield* resolveProductDependency(originalInput, contract, crypto);
    const input = yield* resolveGroupDependency(productInput, contract, crypto);
    yield* validateProvisioningResolution(input);
    const intent = yield* checkedIntent(input);
    if (!Schema.is(Schema.Literal(contract.tag))(intent._tag)) {
      return yield* symmyJobWorkerInvalid();
    }
    const { invocationId } = original;
    if (input.originalInvocationId === undefined) {
      yield* input.recordInvocationId(invocationId);
    }
    const wire = yield* freshRecoveryGateway(input, intent, contract, crypto, invocationId);
    const outcome = yield* recoveryOutcome(input, intent, wire, invocationId, contract, crypto);
    return { outcome, status: 'settled' };
  }),
});

export const makeSymmyCatalogPricingInventoryAdapters = Effect.gen(function* makeOwnerAdapters() {
  const crypto = yield* Crypto.Crypto;
  return symmyCatalogPricingInventoryContracts.map((contract) => makeAdapter(contract, crypto));
});

export class SymmyCatalogPricingInventoryAdapters extends Context.Service<
  SymmyCatalogPricingInventoryAdapters,
  { readonly adapters: readonly SymmyEffectAdapter[] }
>()('@app/symmy-integration/services/symmy-catalog-pricing-inventory-adapters/SymmyCatalogPricingInventoryAdapters') {}

export const SymmyCatalogPricingInventoryAdaptersLive = Layer.effect(
  SymmyCatalogPricingInventoryAdapters,
  makeSymmyCatalogPricingInventoryAdapters.pipe(Effect.map((adapters) => ({ adapters }))),
);
