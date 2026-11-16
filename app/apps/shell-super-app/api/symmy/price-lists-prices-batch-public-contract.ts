import type { SymmyPriceBatch } from '@app/symmy-integration/symmy-internal-contracts';

import type { SymmyPriceListPricesBatchRequest } from './price-lists-prices-batch-request-contract.ts';

/**
 * The public price batch as the owner admission receives it. The route never sends a contract version, a
 * reason, a source assertion or an identity: the route enrollment and the admission derive those, and the
 * dispatch reads what the owner holds about each REVISE price separately.
 */
export const mapSymmyPriceListPricesBatchRequest = ({
  priceGroupRef,
  prices,
}: SymmyPriceListPricesBatchRequest): SymmyPriceBatch => ({ priceGroupRef, prices });
