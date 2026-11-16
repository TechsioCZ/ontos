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
import type { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { ProductActionInvocationIdSchema } from '@app/catalog/domain/product';
import type { ProductRef } from '@app/catalog/resources/product';
import {
  executeImportSourceAssertionWithAuthorization,
  executeInventorySourceImportReceiptWithAuthorization,
} from '@app/inventory/api/client';
import { InventorySourceImportActionInvocationIdSchema } from '@app/inventory/source-import-outcome';
import type { InventorySourceImportOutcome } from '@app/inventory/source-import-outcome';
import {
  executeCreatePriceGroupWithAuthorization,
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
import { Context, Crypto, Effect, Layer, Match, Option, Schema } from 'effect';

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
      CatalogSetVariantLocalizedFacts: ({ payload }) =>
        entityKind === 'VARIANT' && expectedTarget(payload.variantRef) && payload.productRef.tenantId === tenantId,
      CatalogUpdateProduct: ({ payload }) => entityKind === 'PRODUCT' && expectedTarget(payload.productRef),
      InventoryImport: ({ payload }) =>
        input.inventoryBackendId !== undefined &&
        expectedTarget(payload.authorizationTargetRef) &&
        payload.items.every((item) => item.issuer.backendId === input.inventoryBackendId),
      PriceDefine: ({ payload }) =>
        expectedTarget(payload.priceRef) && priceSourceMatches(input, payload.sourceAssertion),
      PriceDefineFromGroupEffect: () => false,
      PriceGroupCreate: ({ payload }) =>
        target === undefined && priceGroupSourceMatches(input, payload.sourceCorrelation),
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

const priceGroupAudience = 'price-group-catalog';
const priceGroupModuleId = 'pricing.price-group-catalog';
const catalogAudience = 'catalog';
const catalogModuleId = 'commerce.catalog';
const symmyCatalogPricingInventoryContracts: readonly AdapterContract[] = [
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
    declarationKey: 'commerce.inventory.source-assertion.import',
    entrypointKey: 'commerce.inventory.import-source-assertion',
    moduleId: 'commerce.inventory',
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
      callingAppId: 'symmy-integration',
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
        const parents = input.dependencies.filter(
          (dependency) =>
            dependency.itemKey === intent.parent.itemKey && dependency.effect.effectKey === intent.parent.effectKey,
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
        if (!Schema.is(settledParentOutcomeSchema)(parent.outcome.value.status)) {
          return yield* symmyJobWorkerInvalid();
        }
        const declared = hasDeclaredParentDependency(input.effect, parent.effect.itemId, intent.parent);
        if (!declared) {
          return yield* symmyJobWorkerInvalid();
        }
        const receipt = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryReceiptSchema.members[0])(
          Option.getOrUndefined(Option.flatten(Option.fromUndefinedOr(parent.ownerReceipt))),
        ).pipe(Effect.mapError(symmyJobWorkerInvalid));
        if (receipt.productRef.tenantId !== input.effect.ref.occurrence.record.route.tenantId) {
          return yield* symmyJobWorkerInvalid();
        }
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
    Match.orElse(() => Effect.succeed(input)),
  );
});

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
        yield* input.recordOwnerReceipt(receipt);
        return actionInvocationId;
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
        CatalogSetVariantLocalizedFacts: () => Option.some(occurrenceSource),
        CatalogUpdateProduct: () => Option.some(occurrenceSource),
        InventoryImport: () => Option.none(),
        PriceDefine: () => Option.none(),
        PriceDefineFromGroupEffect: () => Option.none(),
        PriceGroupCreate: () => Option.none(),
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
        return createdSourceOutcome(input, invocationId, businessOriginalCreateId);
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
      PriceDefine: () => price,
      PriceDefineFromGroupEffect: () => Effect.fail(symmyJobWorkerInvalid()),
      PriceGroupCreate: () => group,
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
      callingAppId: 'symmy-integration',
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
          return createdSourceOutcome(input, currentInvocationId, businessOriginalCreateId);
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
const verifySelectedPriceGroup = Effect.fn('SymmyOwnerAdapters.verifySelectedPriceGroup')(function* selectedGroup(
  input: SymmyEffectAdapterInput,
  requestIntent: SymmyCatalogPricingInventoryIntent,
  contract: AdapterContract,
  crypto: Crypto.Crypto,
) {
  if (input.selector === undefined || !Schema.is(listPriceWriteTag)(requestIntent._tag)) {
    return true;
  }
  const { selector } = input;
  if (
    !Schema.is(Schema.Literal('PRICE_GROUP'))(selector.kind) ||
    selector.source.entityKind !== 'PRICE_GROUP' ||
    selector.target === undefined ||
    selector.target.moduleId !== priceGroupModuleId ||
    selector.source.route.tenantId !== input.effect.ref.occurrence.record.route.tenantId
  ) {
    return false;
  }
  const selected = yield* Match.value(requestIntent).pipe(
    Match.tag('PriceDefine', ({ payload }) => Effect.succeed(Option.some(payload.identityKey.priceGroupSelector))),
    Match.tag(
      'PriceRevise',
      Effect.fn('SymmyOwnerAdapters.readSelectedPriceGroup')(function* readCurrentGroup({
        payload,
      }: Extract<SymmyCatalogPricingInventoryIntent, { readonly _tag: 'PriceRevise' }>) {
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
          { priceRef: payload.priceRef },
          wire.credential,
          wire.requestCorrelation,
          wire.options,
        ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
        return Match.value(result).pipe(
          Match.when({ outcome: 'PRICE_DEFINITION_CURRENT' }, ({ definition }) =>
            Option.some(definition.identityKey.priceGroupSelector),
          ),
          Match.orElse(() => Option.none()),
        );
      }),
    ),
    Match.orElse(() => Effect.fail(symmyJobWorkerInvalid())),
  );
  if (Option.isNone(selected)) {
    return false;
  }
  const requestedTarget = Match.value(selected.value).pipe(
    Match.when({ kind: 'PRICE_GROUP' }, ({ priceGroupRef }) => Option.some(priceGroupRef)),
    Match.orElse(() => Option.none()),
  );
  if (Option.isNone(requestedTarget) || !sameRef(requestedTarget.value, selector.target)) {
    return false;
  }
  const groupContract = {
    ...contract,
    audience: priceGroupAudience,
    recoveryDeclarationKey: 'pricing.price-group-catalog.price-group-source-associations.read',
    recoveryEntrypointKey: 'pricing.price-group-catalog.api.price-group-source-associations',
  };
  const wire = yield* freshGateway(input, groupContract, true, crypto);
  const { source } = selector;
  const result = yield* executePriceGroupSourceAssociationsWithAuthorization(
    {
      issuer: source.issuerId,
      limit: 2,
      namespace: source.sourceNamespace,
      offset: 0,
      recordKey: source.sourceRecordId,
      routeId: source.route.integrationRouteId,
    },
    wire.credential,
    wire.requestCorrelation,
    wire.options,
  ).pipe(Effect.mapError(symmyJobWorkerUnavailable));
  const [association] = result.associations;
  return (
    result.count === 1 &&
    result.associations.length === 1 &&
    association !== undefined &&
    sameRef(association.priceGroupRef, selector.target)
  );
});

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
    const parentIntent = yield* Schema.decodeUnknownEffect(SymmyCatalogPricingInventoryIntentSchema.members[5])(
      parent.effect.intent,
    ).pipe(Effect.mapError(symmyJobWorkerInvalid));
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
  if (
    input.selector !== undefined ||
    (input.routeKey !== 'priceListsBatchUpsert' && input.routeKey !== 'priceListPricesBatch') ||
    !Schema.is(listPriceWriteTag)(intent._tag)
  ) {
    return true;
  }
  const requestedGroup = Match.value(intent).pipe(
    Match.tag('PriceDefine', ({ payload }) => {
      const selector = payload.identityKey.priceGroupSelector;
      return selector.kind === 'PRICE_GROUP' ? Option.some(selector.priceGroupRef) : Option.none();
    }),
    Match.orElse(() => Option.none()),
  );
  if (input.routeKey !== 'priceListsBatchUpsert' || Option.isNone(requestedGroup)) {
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
  if (Schema.is(problemStatus)(error) && error.status === 409) {
    return safeOutcome(input, 'conflict');
  }
  return yield* symmyJobWorkerUnavailable(error);
});

const makeAdapter = (contract: AdapterContract, crypto: Crypto.Crypto): SymmyEffectAdapter => ({
  execute: Effect.fn('SymmyOwnerAdapters.execute')(function* execute(originalInput) {
    const productInput = yield* resolveProductDependency(originalInput, contract, crypto);
    const input = yield* resolveGroupDependency(productInput, contract, crypto);
    const intent = yield* checkedIntent(input);
    if (!Schema.is(Schema.Literal(contract.tag))(intent._tag)) {
      return yield* symmyJobWorkerInvalid();
    }
    if (!input.canExecuteNewEffects) {
      return yield* symmyJobWorkerInvalid();
    }
    const selectedGroupMatches = yield* verifySelectedPriceGroup(input, intent, contract, crypto);
    if (
      !selectedGroupMatches ||
      !(yield* verifyPriceListDependency(input, originalInput.effect, intent, contract, crypto))
    ) {
      return safeOutcome(input, 'unresolved');
    }
    const boundTarget = yield* verifyExistingCatalogTarget(input, intent, contract, crypto);
    if (!boundTarget) {
      return safeOutcome(input, 'unresolved');
    }
    const wire = yield* freshGateway(input, contract, false, crypto);
    if (wire.machineContext === undefined) {
      return yield* symmyJobWorkerUnavailable();
    }
    const originalRequestHash = yield* prepareSymmyCatalogPricingInventoryRequestHash(
      intent,
      { principalId: wire.machineContext.principalId, tenantId: input.effect.ref.occurrence.record.route.tenantId },
      input.legalEntityId,
    );
    if (
      (input.originalExecutorPrincipalId !== undefined &&
        input.originalExecutorPrincipalId !== wire.machineContext.principalId) ||
      (input.originalAuthContextRef !== undefined &&
        input.originalAuthContextRef !== wire.machineContext.authContextRef) ||
      (input.originalRequestHash !== undefined && input.originalRequestHash !== originalRequestHash)
    ) {
      return yield* symmyJobWorkerInvalid();
    }
    yield* input.recordOwnerRequest({
      authContextRef: wire.machineContext.authContextRef,
      executorPrincipalId: wire.machineContext.principalId,
      requestHash: originalRequestHash,
    });
    const executionInput = {
      ...input,
      originalAuthContextRef: wire.machineContext.authContextRef,
      originalExecutorPrincipalId: wire.machineContext.principalId,
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
    const original = yield* readOriginalOwnerAttempt(originalInput);
    if (original.status !== 'committed') {
      return original;
    }
    const productInput = yield* resolveProductDependency(originalInput, contract, crypto);
    const input = yield* resolveGroupDependency(productInput, contract, crypto);
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
