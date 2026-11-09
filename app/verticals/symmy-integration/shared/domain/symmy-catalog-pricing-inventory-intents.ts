import { BindInitialVariantSourcePayloadSchema } from '@app/catalog/api/bind-initial-variant-source-action';
import { CorrectProductPayloadSchema } from '@app/catalog/api/correct-product-action';
import { CreateProductPayloadSchema } from '@app/catalog/api/create-product-action';
import { CreateVariantPayloadSchema } from '@app/catalog/api/create-variant-action';
import { UpdateProductPayloadSchema } from '@app/catalog/api/update-product-action';
import { ProductActionInvocationIdSchema } from '@app/catalog/domain/product';
import { ProductRefSchema } from '@app/catalog/resources/product';
import { VariantRefSchema } from '@app/catalog/resources/variant';
import { CatalogSourceCorrelationSchema } from '@app/catalog/domain/catalog-source-correlation';
import { ImportSourceAssertionPayloadSchema } from '@app/inventory/source-import';
import { CreatePriceGroupPayloadSchema } from '@app/price-group-catalog/actions/create-price-group';
import { PriceGroupOperationReceiptSchema } from '@app/price-group-catalog/apis/price-group-result-lookup';
import { CreatePriceGroupDefinitionRevisionPayloadSchema } from '@app/price-group-catalog/actions/create-price-group-definition-revision';
import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { RevisePricePayloadSchema } from '@app/pricing/actions/revise-price';
import { Schema } from 'effect';

const dependencyKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u));
const productEffectReference = Schema.Struct({
  effectKey: dependencyKey.pipe(Schema.brand('SymmyExecutionEffectKey')),
  itemKey: dependencyKey.pipe(Schema.brand('SymmyExecutionItemKey')),
});
const newRealization = CreateVariantPayloadSchema.fields.classification.members[0].fields;
const successorRealization = CreateVariantPayloadSchema.fields.classification.members[1].fields;
const deferredVariantClassification = Schema.Union([
  Schema.Struct({
    affectsOpenSelection: newRealization.affectsOpenSelection,
    evidenceRefs: newRealization.evidenceRefs,
    kind: newRealization.kind,
    newVariantRef: newRealization.newVariantRef,
    reason: newRealization.reason,
  }),
  Schema.Struct({
    affectsOpenSelection: successorRealization.affectsOpenSelection,
    evidenceRefs: successorRealization.evidenceRefs,
    kind: successorRealization.kind,
    newVariantRef: successorRealization.newVariantRef,
    previousVariantRef: successorRealization.previousVariantRef,
    reason: successorRealization.reason,
  }),
]);
/** Only the parent Product reference is deferred; all remaining owner facts stay explicit. */
const variantFromProductEffectPayload = Schema.Struct({
  classification: deferredVariantClassification,
  evidenceRefs: CreateVariantPayloadSchema.fields.evidenceRefs,
  expectedProductRevision: CreateVariantPayloadSchema.fields.expectedProductRevision,
  reason: CreateVariantPayloadSchema.fields.reason,
  sourceCorrelation: CreateVariantPayloadSchema.fields.sourceCorrelation,
  variantRef: CreateVariantPayloadSchema.fields.variantRef,
});

const definePriceFromGroupEffectPayload = Schema.Struct({
  ...DefinePricePayloadSchema.fields,
  identityKey: Schema.Struct({
    ...DefinePricePayloadSchema.fields.identityKey.fields,
    priceGroupSelector: Schema.Struct({ kind: Schema.Literal('PRICE_GROUP') }),
  }),
});

export const SymmyCatalogPricingInventoryReceiptSchema = Schema.Union([
  Schema.TaggedStruct('ProductCreated', {
    actionInvocationId: ProductActionInvocationIdSchema,
    initialVariantRef: VariantRefSchema,
    productRef: ProductRefSchema,
  }).check(
    Schema.makeFilter(
      ({ initialVariantRef, productRef }) =>
        productRef.tenantId === initialVariantRef.tenantId ||
        'Created Product and initial Variant must belong to one Tenant',
    ),
  ),
  Schema.TaggedStruct('VariantCreated', { productRef: ProductRefSchema, variantRef: VariantRefSchema }),
  Schema.TaggedStruct('PriceGroupCreated', {
    actionInvocationId: PriceGroupOperationReceiptSchema.fields.actionInvocationId,
    businessOriginalInvocationId: PriceGroupOperationReceiptSchema.fields.actionInvocationId,
    priceGroupRef: PriceGroupOperationReceiptSchema.fields.priceGroupRef,
  }),
]);
export type SymmyCatalogPricingInventoryReceipt = typeof SymmyCatalogPricingInventoryReceiptSchema.Type;

/** Internal normalized contracts: these are explicit owner facts, not an asserted Symmy wire format. */
export const SymmyCatalogPricingInventoryIntentSchema = Schema.Union([
  Schema.TaggedStruct('CatalogCreateProduct', { payload: CreateProductPayloadSchema }),
  Schema.TaggedStruct('CatalogCreateVariant', {
    payload: CreateVariantPayloadSchema,
    productSource: CatalogSourceCorrelationSchema,
  }),
  Schema.TaggedStruct('CatalogUpdateProduct', { payload: UpdateProductPayloadSchema }),
  Schema.TaggedStruct('CatalogCorrectProduct', { payload: CorrectProductPayloadSchema }),
  Schema.TaggedStruct('CatalogBindInitialVariantSource', { payload: BindInitialVariantSourcePayloadSchema }),
  Schema.TaggedStruct('PriceGroupCreate', { payload: CreatePriceGroupPayloadSchema }),
  Schema.TaggedStruct('PriceGroupRevise', { payload: CreatePriceGroupDefinitionRevisionPayloadSchema }),
  Schema.TaggedStruct('PriceDefine', { payload: DefinePricePayloadSchema }),
  Schema.TaggedStruct('PriceRevise', { payload: RevisePricePayloadSchema }),
  Schema.TaggedStruct('InventoryImport', {
    payload: ImportSourceAssertionPayloadSchema.check(
      Schema.makeFilter(({ items }) => items.length === 1 || 'Each replayable stock effect has exactly one source row'),
    ),
  }),
  Schema.TaggedStruct('CatalogCreateVariantFromProductEffect', {
    parent: productEffectReference,
    payload: variantFromProductEffectPayload,
    productSource: CatalogSourceCorrelationSchema,
  }),
  Schema.TaggedStruct('PriceDefineFromGroupEffect', {
    fromPriceGroupEffect: productEffectReference,
    payload: definePriceFromGroupEffectPayload,
  }),
]);
export type SymmyCatalogPricingInventoryIntent = typeof SymmyCatalogPricingInventoryIntentSchema.Type;
