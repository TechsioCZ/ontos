import { Effect, Schema } from 'effect';

const BoundedIdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
export const CustomerConfigurationIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('CustomerConfigurationId'));
const CatalogSelectionIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('CatalogSelectionId'));
const PurchaseDemandOccurrenceIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('PurchaseDemandOccurrenceId'));
const StockItemIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('StockItemId'));
export const OrderCommitmentAttemptIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('OrderCommitmentAttemptId'));

export const InventoryBackendSchema = Schema.Literals(['external_business_system', 'ontos_wms']);
export type InventoryBackend = typeof InventoryBackendSchema.Type;

export const InventoryBackendConfigurationInputSchema = Schema.Struct({
  customerConfigurationId: CustomerConfigurationIdSchema,
  selectedBackends: Schema.Array(InventoryBackendSchema),
});
export type InventoryBackendConfigurationInput = typeof InventoryBackendConfigurationInputSchema.Type;

export const ValidatedInventoryBackendConfigurationSchema = Schema.Struct({
  backend: InventoryBackendSchema,
  customerConfigurationId: CustomerConfigurationIdSchema,
});
export type ValidatedInventoryBackendConfiguration = typeof ValidatedInventoryBackendConfigurationSchema.Type;

const LaunchQuantitySchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  Schema.isMaxLength(80),
);
const LaunchUnitSchema = BoundedIdentifierSchema.pipe(Schema.brand('InventoryLaunchUnit'));

const UsableStockItemBindingSchema = Schema.Struct({
  status: Schema.Literal('usable'),
  stockItemId: StockItemIdSchema,
});
const UnusableStockItemBindingSchema = Schema.Struct({
  reason: Schema.Literals(['incompatible_meaning', 'not_current']),
  status: Schema.Literal('unusable'),
});
// oxlint-disable-next-line effect-native/no-nullable-schema-field -- null is the established launch-cutline wire sentinel for a missing binding; expires: 2027-03-31.
export const InventoryStockItemBindingSchema = Schema.NullOr(
  Schema.Union([UsableStockItemBindingSchema, UnusableStockItemBindingSchema]),
);

export const InventoryStockDemandInputSchema = Schema.Struct({
  binding: InventoryStockItemBindingSchema,
  catalogSelectionId: CatalogSelectionIdSchema,
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
  quantity: LaunchQuantitySchema,
  unit: LaunchUnitSchema,
});
export type InventoryStockDemandInput = typeof InventoryStockDemandInputSchema.Type;

export const InventoryStockRequirementSchema = Schema.Struct({
  catalogSelectionId: CatalogSelectionIdSchema,
  purchaseDemandOccurrenceId: PurchaseDemandOccurrenceIdSchema,
  quantity: LaunchQuantitySchema,
  stockItemId: StockItemIdSchema,
  unit: LaunchUnitSchema,
});
export type InventoryStockRequirement = typeof InventoryStockRequirementSchema.Type;

export const InventoryPurchaseKindSchema = Schema.Literals(['b2c', 'b2b']);
export type InventoryPurchaseKind = typeof InventoryPurchaseKindSchema.Type;

export const InventoryCommitmentInputSchema = Schema.Struct({
  attemptId: OrderCommitmentAttemptIdSchema,
  purchaseKind: InventoryPurchaseKindSchema,
});
export type InventoryCommitmentInput = typeof InventoryCommitmentInputSchema.Type;

export class InventoryLaunchCutlineRejected extends Schema.TaggedError<InventoryLaunchCutlineRejected>()(
  'InventoryLaunchCutlineRejected',
  {
    attemptId: Schema.optionalKey(OrderCommitmentAttemptIdSchema),
    catalogSelectionId: Schema.optionalKey(CatalogSelectionIdSchema),
    code: Schema.Literal('inventory_launch_cutline_rejected'),
    customerConfigurationId: Schema.optionalKey(CustomerConfigurationIdSchema),
    purchaseKind: Schema.optionalKey(InventoryPurchaseKindSchema),
    reason: Schema.Literals([
      'exactly_one_backend_required',
      'usable_stock_item_binding_required',
      'owner_enforceable_reservation_protection_required',
    ]),
    selectedBackends: Schema.optionalKey(Schema.Array(InventoryBackendSchema)),
  },
) {}

export const validateLaunchInventoryBackend = (
  input: InventoryBackendConfigurationInput,
): Effect.Effect<ValidatedInventoryBackendConfiguration, InventoryLaunchCutlineRejected> => {
  const [backend] = input.selectedBackends;
  if (input.selectedBackends.length !== 1 || backend === undefined) {
    return Effect.fail(
      new InventoryLaunchCutlineRejected({
        code: 'inventory_launch_cutline_rejected',
        customerConfigurationId: input.customerConfigurationId,
        reason: 'exactly_one_backend_required',
        selectedBackends: [...input.selectedBackends],
      }),
    );
  }

  return Effect.succeed({
    backend,
    customerConfigurationId: input.customerConfigurationId,
  });
};

export const resolveLaunchStockRequirement = (
  input: InventoryStockDemandInput,
): Effect.Effect<InventoryStockRequirement, InventoryLaunchCutlineRejected> => {
  if (input.binding === null || input.binding.status !== 'usable') {
    return Effect.fail(
      new InventoryLaunchCutlineRejected({
        catalogSelectionId: input.catalogSelectionId,
        code: 'inventory_launch_cutline_rejected',
        reason: 'usable_stock_item_binding_required',
      }),
    );
  }

  return Effect.succeed({
    catalogSelectionId: input.catalogSelectionId,
    purchaseDemandOccurrenceId: input.purchaseDemandOccurrenceId,
    quantity: input.quantity,
    stockItemId: input.binding.stockItemId,
    unit: input.unit,
  });
};

export const requireLaunchCommitmentProtection = (
  input: InventoryCommitmentInput,
): Effect.Effect<never, InventoryLaunchCutlineRejected> =>
  Effect.fail(
    new InventoryLaunchCutlineRejected({
      attemptId: input.attemptId,
      code: 'inventory_launch_cutline_rejected',
      purchaseKind: input.purchaseKind,
      reason: 'owner_enforceable_reservation_protection_required',
    }),
  );

export const inventoryLaunchCapabilityKeys = [
  'single_customer_configuration_backend',
  'exact_selection_stock_item_binding',
  'quantity_and_unit_preservation',
  'owner_enforceable_reservation_protection',
] as const;
