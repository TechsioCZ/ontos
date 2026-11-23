import { SYMMY_ROUTES } from '@app/shared-contracts/symmy';
import { Result, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SymmyCustomerGroupsBatchRequestSchema } from '../../api/symmy/customer-groups-batch-request-contract.ts';
import { SymmyCustomersBatchRequestSchema } from '../../api/symmy/customers-batch-request-contract.ts';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoMediaUploadRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
} from '../../api/symmy/demo-catalog-contract.ts';
import { symmyDocumentedRoutes, symmyOpenApiDocument } from '../../api/symmy/docs.ts';
import { SymmyGroupCustomersBatchRequestSchema } from '../../api/symmy/group-customers-batch-request-contract.ts';
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
    expect(
      accepted(SymmyCustomersBatchRequestSchema, symmyDocumentedRoutes.customersBatch.requestExamples.organization.value),
    ).toBe(true);
    expect(
      accepted(
        SymmyGroupCustomersBatchRequestSchema,
        symmyDocumentedRoutes.customerGroupCustomersBatch.requestExamples.members.value,
      ),
    ).toBe(true);
    expect(
      accepted(
        SymmyDemoCategoriesBatchRequestSchema,
        symmyDocumentedRoutes.demoCategories.requestExamples.category.value,
      ),
    ).toBe(true);
    expect(
      accepted(
        SymmyDemoProductsBatchRequestSchema,
        symmyDocumentedRoutes.demoCatalogProducts.requestExamples.product.value,
      ),
    ).toBe(true);
    expect(
      accepted(SymmyDemoMediaUploadRequestSchema, symmyDocumentedRoutes.demoMedia.requestExamples.image.value),
    ).toBe(true);
  });

  it('describes only the working routes, each behind the API key', () => {
    const spec = symmyOpenApiDocument;
    expect(Object.keys(spec.paths).toSorted()).toEqual(
      [
        SYMMY_ROUTES.adminProducts.path,
        SYMMY_ROUTES.adminCustomers.path,
        SYMMY_ROUTES.customersBatch.path,
        SYMMY_ROUTES.customerGroupCustomersBatch.path,
        SYMMY_ROUTES.customerGroupsBatch.path,
        SYMMY_ROUTES.inventoryStockBatch.path,
        SYMMY_ROUTES.job.path,
        SYMMY_ROUTES.priceListPricesBatch.path,
        SYMMY_ROUTES.priceLists.path,
        SYMMY_ROUTES.priceListsBatchUpsert.path,
        SYMMY_ROUTES.productsBatch.path,
        '/api/symmy/v1/orders',
        '/api/symmy/v1/orders/{id}',
        '/api/symmy/v1/categories/batch',
        '/api/symmy/v1/catalog/products/batch',
        '/api/symmy/v1/products/media',
        '/api/symmy/v1/catalog/revision',
      ].toSorted(),
    );
    expect(spec.security).toEqual([{ SymmyApiKey: [] }]);
    expect(spec.components.securitySchemes).toEqual({
      SymmyApiKey: { in: 'header', name: 'x-api-key', type: 'apiKey' },
    });
    expect(JSON.stringify(spec.paths[SYMMY_ROUTES.productsBatch.path])).not.toContain('"name":"x-api-key"');
  });

  it('keeps the native catalog schemas, bounded paging and company-scoped API-key security visible', () => {
    const spec = symmyOpenApiDocument;
    for (const item of Object.values(spec.paths)) {
      for (const operation of [item.get, item.post]) {
        if (operation !== undefined) {
          expect(operation.security).toEqual([{ SymmyApiKey: [] }]);
        }
      }
    }
    for (const path of ['/api/symmy/v1/categories/batch', '/api/symmy/v1/catalog/products/batch']) {
      expect(JSON.stringify(spec.paths[path]?.post?.requestBody)).toContain('expectedRevision');
      expect(JSON.stringify(spec.paths[path]?.post?.requestBody)).toContain('"maxItems":16');
      expect(JSON.stringify(spec.paths[path]?.post?.responses)).toContain('200');
    }
    expect(JSON.stringify(spec.paths['/api/symmy/v1/products/media']?.post?.requestBody)).toContain('productId');
    expect(JSON.stringify(spec.paths['/api/symmy/v1/orders']?.get?.parameters)).toContain('limit');
    expect(spec.paths['/api/symmy/v1/orders/{id}']?.get?.responses).toHaveProperty('404');
    expect(JSON.stringify(spec.paths['/api/symmy/v1/catalog/revision']?.get?.responses)).toContain('revision');
  });

  it('distinguishes product owners and describes order reads without promising invoice creation', () => {
    expect(symmyDocumentedRoutes.demoCatalogProducts.description).toContain('not a Catalog');
    expect(symmyDocumentedRoutes.productsBatch.description).toContain('engineered Catalog');
    expect(symmyDocumentedRoutes.demoOrders.description).toContain('not invoice creation or an ABRA push');
    expect(symmyDocumentedRoutes.demoCategories.description).toContain('GET /catalog/revision');
    expect(symmyDocumentedRoutes.demoCatalogProducts.description).toContain('GET /catalog/revision');
    expect(symmyDocumentedRoutes.demoMedia.description).toContain('GET /catalog/revision');
    const description = symmyOpenApiDocument.info.description;
    expect(description).not.toContain('twelve prepared');
    expect(description).not.toContain('one-time preparation');
    expect(description).not.toContain('Not available yet');
  });
});
