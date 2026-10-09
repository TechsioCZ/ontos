import type { Effect as EffectType } from 'effect';
import { Context, Effect } from 'effect';

import type { CustomerConfigurationIdSchema } from '../../shared/inventory-launch-scope.ts';
import { InventoryReservationCreateUnavailable } from '../../shared/domain/inventory-reservation-create.ts';
import type { ReservationAuthorityEffectIdSchema } from '../../shared/domain/reservation-issuer-failure-fields.ts';
import type { TrustedCurrentCommercePurchasingContext } from '../../shared/domain/stock-sharing-eligibility.ts';

export interface InventoryReservationCommerceContextAuthority {
  readonly resolveCurrent: (input: {
    readonly customerConfigurationId: typeof CustomerConfigurationIdSchema.Type;
    readonly effectId: typeof ReservationAuthorityEffectIdSchema.Type;
    readonly legalEntityId: string;
    readonly storefrontId: string;
    readonly tenantId: string;
  }) => EffectType.Effect<TrustedCurrentCommercePurchasingContext, InventoryReservationCreateUnavailable>;
}

export const InventoryReservationCommerceContextAuthorityPort =
  Context.Reference<InventoryReservationCommerceContextAuthority>(
    '@app/inventory/services/inventory-reservation-commerce-context/InventoryReservationCommerceContextAuthorityPort',
    {
      defaultValue: () => ({
        resolveCurrent: ({ effectId }) =>
          Effect.fail(
            new InventoryReservationCreateUnavailable({
              code: 'inventory_reservation_create_unavailable',
              effectId,
              reason: 'Trusted Current Commerce Purchasing Context is unavailable',
              retryable: true,
            }),
          ),
      }),
    },
  );
