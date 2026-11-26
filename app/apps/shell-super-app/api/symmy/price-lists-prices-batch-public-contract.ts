import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import type { SymmyPriceBatch } from '@app/symmy-integration/symmy-internal-contracts';
import { Array as EffectArray } from 'effect';

import { symmyOwnerRef } from './owner-ref.ts';
import type { SymmyPriceListPricesBatchRequest } from './price-lists-prices-batch-request-contract.ts';
import { symmyOwnerPrice } from './price-request-fields.ts';

type Item = SymmyPriceListPricesBatchRequest['prices'][number];

const mapItem =
  (tenantId: string) =>
  (item: Item): SymmyPriceBatch['prices'][number] => {
    if (item.operation === 'REVISE') {
      const { priceId, ...revise } = item;
      return { ...revise, priceRef: symmyOwnerRef(PriceRefSchema, tenantId, priceId) };
    }
    return symmyOwnerPrice(item, tenantId);
  };

/**
 * The public price batch as the owner admission receives it. The route never sends a contract version, a
 * reason, a source assertion or an identity: the route enrollment and the admission derive those, and the
 * dispatch reads what the owner holds about each REVISE price separately. Every reference is built from the
 * sent id and the tenant of the admitted route.
 */
export const mapSymmyPriceListPricesBatchRequest = (
  { priceGroupId, prices }: SymmyPriceListPricesBatchRequest,
  tenantId: string,
): SymmyPriceBatch => ({
  priceGroupRef: symmyOwnerRef(PriceGroupRefSchema, tenantId, priceGroupId),
  prices: EffectArray.map<SymmyPriceListPricesBatchRequest['prices'], SymmyPriceBatch['prices'][number]>(
    mapItem(tenantId),
  )(prices),
});
