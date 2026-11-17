import type { SymmyPriceListRows } from '@app/symmy-integration/symmy-internal-contracts';

import type { SymmyPriceListsBatchRequest } from './price-lists-batch-upsert-request-contract.ts';

/**
 * The public price lists as the owner admission receives them. The route never sends a contract version,
 * a compatibility contract, a reason, a catalog fence, an identity or a source fact: the route enrollment
 * and the admission derive those, and the owner reads the catalog head separately.
 */
export const mapSymmyPriceListsBatchRequest = ({ priceLists }: SymmyPriceListsBatchRequest): SymmyPriceListRows =>
  priceLists;
