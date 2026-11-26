import type { SymmyPriceListRows } from '@app/symmy-integration/symmy-internal-contracts';
import { Array as EffectArray } from 'effect';

import type { SymmyPriceListsBatchRequest } from './price-lists-batch-upsert-request-contract.ts';
import { symmyOwnerPrice } from './price-request-fields.ts';

type PriceList = SymmyPriceListsBatchRequest['priceLists'][number];
type PriceListRow = SymmyPriceListRows[number];

const mapPriceList =
  (tenantId: string) =>
  ({ prices, ...list }: PriceList): PriceListRow =>
    prices === undefined ? list : { ...list, prices: prices.map((price) => symmyOwnerPrice(price, tenantId)) };

/**
 * The public price lists as the owner admission receives them. The route never sends a contract version,
 * a compatibility contract, a reason, a catalog fence, an identity or a source fact: the route enrollment
 * and the admission derive those, and the owner reads the catalog head separately. Every reference is built
 * from the sent id and the tenant of the admitted route.
 */
export const mapSymmyPriceListsBatchRequest = (
  { priceLists }: SymmyPriceListsBatchRequest,
  tenantId: string,
): SymmyPriceListRows =>
  EffectArray.map<SymmyPriceListsBatchRequest['priceLists'], PriceListRow>(mapPriceList(tenantId))(priceLists);
