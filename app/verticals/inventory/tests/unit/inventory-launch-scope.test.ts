import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  InventoryBackendConfigurationInputSchema,
  InventoryCommitmentInputSchema,
  InventoryLaunchCutlineRejected,
  InventoryStockDemandInputSchema,
  inventoryLaunchCapabilityKeys,
  requireLaunchCommitmentProtection,
  resolveLaunchStockRequirement,
  validateLaunchInventoryBackend,
} from '../../shared/inventory-launch-scope.ts';

const decodeBackendConfiguration = Schema.decodeUnknownSync(InventoryBackendConfigurationInputSchema);
const decodeStockDemand = Schema.decodeUnknownSync(InventoryStockDemandInputSchema);
const decodeCommitment = Schema.decodeUnknownSync(InventoryCommitmentInputSchema);

describe('Inventory Launch cutline', () => {
  it.effect('rejects dual-backend Customer Configuration without choosing a fallback', () =>
    Effect.gen(function* rejectDualBackend() {
      const error = yield* validateLaunchInventoryBackend(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system', 'ontos_wms'],
        }),
      ).pipe(Effect.flip);

      expect(Schema.is(InventoryLaunchCutlineRejected)(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'inventory_launch_cutline_rejected',
        reason: 'exactly_one_backend_required',
        selectedBackends: ['external_business_system', 'ontos_wms'],
      });
    }),
  );

  it.effect('accepts either backend only when it is the sole Customer Configuration selection', () =>
    Effect.gen(function* acceptOneBackend() {
      const external = yield* validateLaunchInventoryBackend(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-1',
          selectedBackends: ['external_business_system'],
        }),
      );
      const ontosWms = yield* validateLaunchInventoryBackend(
        decodeBackendConfiguration({
          customerConfigurationId: 'customer-configuration-2',
          selectedBackends: ['ontos_wms'],
        }),
      );

      expect(external.backend).toBe('external_business_system');
      expect(ontosWms.backend).toBe('ontos_wms');
    }),
  );

  it.effect('rejects a supported exact Selection without a usable Stock Item binding', () =>
    Effect.gen(function* rejectMissingBinding() {
      const error = yield* resolveLaunchStockRequirement(
        decodeStockDemand({
          binding: null,
          catalogSelectionId: 'selection-1',
          purchaseDemandOccurrenceId: 'demand-occurrence-1',
          quantity: '2.50',
          unit: 'piece',
        }),
      ).pipe(Effect.flip);

      expect(Schema.is(InventoryLaunchCutlineRejected)(error)).toBe(true);
      expect(error).toMatchObject({
        code: 'inventory_launch_cutline_rejected',
        reason: 'usable_stock_item_binding_required',
      });
    }),
  );

  it.effect('preserves exact Selection provenance, Quantity and Unit in the Stock Requirement', () =>
    Effect.gen(function* preserveExactDemand() {
      const input = decodeStockDemand({
        binding: {
          status: 'usable',
          stockItemId: 'stock-item-1',
        },
        catalogSelectionId: 'selection-1',
        purchaseDemandOccurrenceId: 'demand-occurrence-1',
        quantity: '2.50',
        unit: 'piece',
      });

      const requirement = yield* resolveLaunchStockRequirement(input);

      expect(requirement).toEqual({
        catalogSelectionId: input.catalogSelectionId,
        purchaseDemandOccurrenceId: input.purchaseDemandOccurrenceId,
        quantity: input.quantity,
        stockItemId: input.binding?.status === 'usable' ? input.binding.stockItemId : undefined,
        unit: input.unit,
      });
    }),
  );

  it.effect('rejects final B2C and B2B commitment without owner-enforceable Reservation protection', () =>
    Effect.gen(function* rejectUnprotectedCommitment() {
      for (const purchaseKind of ['b2c', 'b2b'] as const) {
        const error = yield* requireLaunchCommitmentProtection(
          decodeCommitment({
            attemptId: `${purchaseKind}-attempt`,
            purchaseKind,
          }),
        ).pipe(Effect.flip);

        expect(Schema.is(InventoryLaunchCutlineRejected)(error)).toBe(true);
        expect(error).toMatchObject({
          purchaseKind,
          reason: 'owner_enforceable_reservation_protection_required',
        });
      }
    }),
  );

  it.effect('rejects caller-fabricated protection even when it claims the selected backend', () =>
    Effect.gen(function* rejectFabricatedProtection() {
      const input = decodeCommitment({
        attemptId: 'attempt-1',
        protection: {
          commitmentProtectionId: 'protection-1',
          issuerBackend: 'external_business_system',
          reservationConfirmationId: 'confirmation-1',
          status: 'owner_enforceable',
        },
        purchaseKind: 'b2c',
        selectedBackend: 'external_business_system',
      });

      expect(input).toEqual({ attemptId: 'attempt-1', purchaseKind: 'b2c' });

      const error = yield* requireLaunchCommitmentProtection(input).pipe(Effect.flip);

      expect(Schema.is(InventoryLaunchCutlineRejected)(error)).toBe(true);
      expect(error).toMatchObject({
        attemptId: 'attempt-1',
        purchaseKind: 'b2c',
        reason: 'owner_enforceable_reservation_protection_required',
      });
    }),
  );

  it('publishes only the Launch cutline and does not leak Later acceptance modes', () => {
    expect(inventoryLaunchCapabilityKeys).toEqual([
      'single_customer_configuration_backend',
      'exact_selection_stock_item_binding',
      'quantity_and_unit_preservation',
      'owner_enforceable_reservation_protection',
    ]);
    expect(inventoryLaunchCapabilityKeys).not.toContain('stock_block');
    expect(inventoryLaunchCapabilityKeys).not.toContain('backorder');
    expect(inventoryLaunchCapabilityKeys).not.toContain('preorder');
    expect(inventoryLaunchCapabilityKeys).not.toContain('unit_conversion');
  });
});
