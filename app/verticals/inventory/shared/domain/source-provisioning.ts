import { CatalogSelectionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import { ProductUnitRefSchema } from '@app/catalog-selection-contracts/resources/product-unit';
import { Order, Schema, SchemaGetter, Struct } from 'effect';

import { InventoryBackendOriginSchema } from './external-stock-correlation.ts';
import { ExactCatalogSelectionMeaningSchema } from './stock-item.ts';
import { CustomerConfigurationIdSchema } from '../inventory-launch-scope.ts';
import { CatalogToStockBindingRefSchema } from '../resources/catalog-to-stock-binding.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';
import { InventoryBackendConfigurationRefSchema } from '../resources/inventory-backend-configuration.ts';
import { SourceProvisioningPolicyRefSchema } from '../resources/source-provisioning-policy.ts';
import { StockItemRefSchema } from '../resources/stock-item.ts';
import { StockLocationRefSchema } from '../resources/stock-location.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

const boundedText = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(300));
const instant = Schema.toEncoded(Schema.DateTimeUtcFromString);

/** The ERP's own literal key of an item or a warehouse location, meaningful only inside one policy. */
export const SourceExternalKeySchema = boundedText.pipe(Schema.brand('InventorySourceExternalKey'));

export const SourceProvisioningLocationSchema = Schema.Struct({
  locationKey: SourceExternalKeySchema,
  stockLocationRef: StockLocationRefSchema,
});
export type SourceProvisioningLocation = typeof SourceProvisioningLocationSchema.Type;

const distinctLocations = Schema.makeFilter((locations: readonly SourceProvisioningLocation[]) => {
  if (new Set(locations.map(({ locationKey }) => locationKey)).size !== locations.length) {
    return 'Every allowed location key must be distinct';
  }
  return new Set(locations.map(({ stockLocationRef }) => stockLocationRef.resourceId)).size === locations.length
    ? undefined
    : 'Every allowed Stock Location must be distinct';
});

export const SourceProvisioningLocationsSchema = Schema.Array(SourceProvisioningLocationSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
  distinctLocations,
);

/**
 * The one-time rule of one external Inventory Backend configuration. Every ERP item provisioned under it gets one
 * Stock Item in `unitRef`, one Stock Position at each allowed location, its ITEM correlation qualified by
 * (customer configuration, issuer, namespace, external scope) and its Catalog binding. It is immutable.
 */
export const SourceProvisioningPolicySchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  definedAt: instant,
  /** The instant from which the provisioned correlations hold: the selection instant of the backend. */
  effectiveFrom: instant,
  externalScope: boundedText,
  issuer: InventoryBackendOriginSchema,
  locations: SourceProvisioningLocationsSchema,
  namespace: boundedText,
  ownerConfigurationRef: InventoryBackendConfigurationRefSchema,
  policyRef: SourceProvisioningPolicyRefSchema,
  unitRef: ProductUnitRefSchema,
}).check(
  Schema.makeFilter(({ locations, ownerConfigurationRef, policyRef, unitRef }) =>
    [
      String(ownerConfigurationRef.tenantId),
      unitRef.tenantId,
      ...locations.map(({ stockLocationRef }) => stockLocationRef.tenantId),
    ].every((tenantId) => tenantId === policyRef.tenantId)
      ? undefined
      : 'A Source Provisioning Policy and everything it names must share one Tenant',
  ),
);
export type SourceProvisioningPolicy = typeof SourceProvisioningPolicySchema.Type;

/** The caller's enrolled terms, not authority to alter the referenced Inventory policy. */
export const SourceProvisioningExpectedPolicySchema = Schema.Struct({
  customerConfigurationId: SourceProvisioningPolicySchema.fields.customerConfigurationId,
  externalScope: SourceProvisioningPolicySchema.fields.externalScope,
  issuer: SourceProvisioningPolicySchema.fields.issuer,
  locations: SourceProvisioningPolicySchema.fields.locations,
  namespace: SourceProvisioningPolicySchema.fields.namespace,
  unitRef: SourceProvisioningPolicySchema.fields.unitRef,
});
export type SourceProvisioningExpectedPolicy = typeof SourceProvisioningExpectedPolicySchema.Type;

export const canonicalSourceProvisioningExpectedPolicy = (policy: SourceProvisioningExpectedPolicy) => ({
  ...Struct.pick(policy, Struct.keys(SourceProvisioningExpectedPolicySchema.fields)),
  locations: policy.locations.toSorted((left, right) => Order.String(left.locationKey, right.locationKey)),
});

export const ProvisioningDispositionSchema = Schema.Literals(['ESTABLISHED', 'ADOPTED']);
export type ProvisioningDisposition = typeof ProvisioningDispositionSchema.Type;

const provisionSourceStockItem = Schema.Struct({
  catalogSelection: CatalogSelectionSchema,
  exactSelectionMeaning: ExactCatalogSelectionMeaningSchema,
  expectedPolicy: SourceProvisioningExpectedPolicySchema,
  itemKey: SourceExternalKeySchema,
  policyRef: SourceProvisioningPolicyRefSchema,
});
const sameProvisioningTenant = Schema.makeFilter(
  ({ catalogSelection, policyRef }: typeof provisionSourceStockItem.Type) =>
    catalogSelection.productRef.tenantId === policyRef.tenantId
      ? undefined
      : 'The Catalog selection and the provisioning policy must share one Tenant',
);
export const ProvisionSourceStockItemInputSchema = provisionSourceStockItem.check(sameProvisioningTenant);
export type ProvisionSourceStockItemInput = typeof ProvisionSourceStockItemInputSchema.Type;

// Core hashes the encoded Action payload before calling Inventory. Receipts retain their original input order.
const canonicalTerms = SchemaGetter.transform(canonicalSourceProvisioningExpectedPolicy);
export const ProvisionSourceStockItemPayloadSchema = Schema.Struct({
  ...provisionSourceStockItem.fields,
  expectedPolicy: provisionSourceStockItem.fields.expectedPolicy.pipe(
    Schema.decode({ decode: canonicalTerms, encode: canonicalTerms }),
  ),
}).check(sameProvisioningTenant);
export type ProvisionSourceStockItemPayload = typeof ProvisionSourceStockItemPayloadSchema.Type;

/** The refs one provisioned ERP item resolves to. A repeated call returns the same refs, every part ADOPTED. */
export const SourceStockItemProvisioningSchema = Schema.Struct({
  binding: Schema.Struct({ disposition: ProvisioningDispositionSchema, ref: CatalogToStockBindingRefSchema }),
  itemCorrelation: Schema.Struct({
    disposition: ProvisioningDispositionSchema,
    ref: ExternalStockCorrelationRefSchema,
  }),
  itemKey: SourceExternalKeySchema,
  policyRef: SourceProvisioningPolicyRefSchema,
  positions: Schema.Array(
    Schema.Struct({
      disposition: ProvisioningDispositionSchema,
      locationKey: SourceExternalKeySchema,
      positionRef: StockPositionRefSchema,
      stockLocationRef: StockLocationRefSchema,
    }),
  ).check(Schema.isMinLength(1)),
  stockItem: Schema.Struct({ disposition: ProvisioningDispositionSchema, ref: StockItemRefSchema }),
});
export type SourceStockItemProvisioning = typeof SourceStockItemProvisioningSchema.Type;

export const SourceStockItemProvisioningInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('InventorySourceStockItemProvisioningInvocationId'),
);
export type SourceStockItemProvisioningInvocationId = typeof SourceStockItemProvisioningInvocationIdSchema.Type;

/** The durable receipt of one committed provisioning invocation. */
export const SourceStockItemProvisioningReceiptSchema = Schema.Struct({
  actionInvocationId: SourceStockItemProvisioningInvocationIdSchema,
  input: ProvisionSourceStockItemInputSchema,
  provisioning: SourceStockItemProvisioningSchema,
  recordedAt: instant,
});
export type SourceStockItemProvisioningReceipt = typeof SourceStockItemProvisioningReceiptSchema.Type;
