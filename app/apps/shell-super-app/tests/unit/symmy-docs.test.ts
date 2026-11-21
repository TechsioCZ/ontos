import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { Result, Schema } from 'effect';
import { OpenApi } from 'effect/http-api';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerGroupsBatchRequestSchema } from '../../api/symmy/customer-groups-batch-request-contract.ts';
import { SymmyDocsApi, symmyDocumentedRoutes } from '../../api/symmy/docs.ts';
import { SymmyPriceListsBatchRequestSchema } from '../../api/symmy/price-lists-batch-upsert-request-contract.ts';
import { SymmyPriceListPricesBatchRequestSchema } from '../../api/symmy/price-lists-prices-batch-request-contract.ts';
import { SymmyProductsBatchRequestSchema } from '../../api/symmy/products-batch-request-contract.ts';
import { SymmyStockBatchRequestSchema } from '../../api/symmy/stock-batch-request-contract.ts';

// The HTTP layer decodes with excess properties rejected; a documented request must hold under the same options.
const accepted = <Request, Encoded>(schema: Schema.Codec<Request, Encoded>, body: typeof Schema.Json.Type) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema, { onExcessProperty: 'error' })(body));

describe('Symmy API documentation', () => {
  it('documents requests the routes accept as they stand', () => {
    const { customerGroupsBatch, inventoryStockBatch, priceListPricesBatch, priceListsBatchUpsert, productsBatch } =
      symmyDocumentedRoutes;
    expect(accepted(SymmyProductsBatchRequestSchema, productsBatch.requestExamples.newProduct.value)).toBe(true);
    expect(accepted(SymmyProductsBatchRequestSchema, productsBatch.requestExamples.priceChange.value)).toBe(true);
    expect(accepted(SymmyStockBatchRequestSchema, inventoryStockBatch.requestExamples.stock.value)).toBe(true);
    expect(accepted(SymmyCustomerGroupsBatchRequestSchema, customerGroupsBatch.requestExamples.group.value)).toBe(true);
    expect(accepted(SymmyPriceListsBatchRequestSchema, priceListsBatchUpsert.requestExamples.list.value)).toBe(true);
    expect(accepted(SymmyPriceListPricesBatchRequestSchema, priceListPricesBatch.requestExamples.price.value)).toBe(
      true,
    );
  });

  it('describes only the working routes, each behind the API key', () => {
    const spec = OpenApi.fromApi(SymmyDocsApi);
    expect(Object.keys(spec.paths).toSorted()).toEqual(
      [
        SYMMY_ROUTES.adminProducts.path,
        SYMMY_ROUTES.customerGroupsBatch.path,
        SYMMY_ROUTES.inventoryStockBatch.path,
        SYMMY_ROUTES.job.path,
        SYMMY_ROUTES.priceListPricesBatch.path,
        SYMMY_ROUTES.priceLists.path,
        SYMMY_ROUTES.priceListsBatchUpsert.path,
        SYMMY_ROUTES.productsBatch.path,
      ].toSorted(),
    );
    expect(spec.security).toEqual([{ SymmyApiKey: [] }]);
    expect(spec.components.securitySchemes).toEqual({
      SymmyApiKey: { in: 'header', name: 'x-api-key', type: 'apiKey' },
    });
    expect(JSON.stringify(spec.paths[SYMMY_ROUTES.productsBatch.path])).not.toContain('"name":"x-api-key"');
  });
});
