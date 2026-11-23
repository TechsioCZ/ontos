import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { CreateProductPayloadSchema, CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import { readCatalogSourceProductPage } from '../../src/api/catalog-source-product-page.read.ts';
import {
  catalogSourceCorrelationForScope,
  catalogSourceProductPageForScope,
} from '../../src/persistence/catalog-source-correlation.ts';
import { catalogProductCreateFingerprint } from '../../src/persistence/catalog-source-product-intent.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const invocationId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: '66666666-6666-4666-8666-666666666666',
    authContextRef: 'api-key:fixture-source-page',
    authMethod: 'api_key',
    principalId,
    tenantId,
  }),
  correlationId: 'fixture-source-page',
};
const source = { issuerId: 'symmy-akros', recordNamespace: 'akros-erp', routeScope: 'fixture-route' };

it.effect('constructs the real source page services and returns an unseen search without product hydration', () =>
  Effect.gen(function* test() {
    const phases: string[] = [];
    const database = yield* makeTestDatabase((statement) => {
      if (statement.includes('count(*)')) {
        phases.push('count');
        return Effect.succeed([{ total: 0 }]);
      }
      if (statement.includes('catalog_source_correlations')) {
        phases.push('rows');
        return Effect.succeed([]);
      }
      return Effect.die('Unexpected source page query');
    });
    const services = yield* catalogSourceProductPageForScope(database, scope);
    const result = yield* readCatalogSourceProductPage(
      { ...source, limit: 1, offset: 0, search: 'unseen' },
      services,
    );
    expect(result).toEqual({ count: 0, items: [] });
    expect(phases).toEqual(['count', 'rows']);
  }),
);

it.effect('recovers the original source create when a retry changes only its original text', () =>
  Effect.gen(function* test() {
    const productRef = { moduleId: 'commerce.catalog', resourceType: 'commerce.catalog.product', resourceId: productId, tenantId };
    const result = yield* Schema.decodeUnknownEffect(CreateProductResultSchema)({
      product: {
        productRef, name: 'Original', description: 'Original description', lifecycle: 'DRAFT',
        catalogReady: false, revision: 1, createdAt: '2026-11-23T00:00:00.000Z', updatedAt: '2026-11-23T00:00:00.000Z',
        variants: [{
          productRef, variantId, lifecycle: 'WORK_IN_PROGRESS',
          variantRef: { moduleId: 'commerce.catalog', resourceType: 'commerce.catalog.variant', resourceId: variantId, tenantId },
        }],
      },
      variantId,
    });
    const original = yield* Schema.decodeUnknownEffect(CreateProductPayloadSchema)({
      name: 'Original', description: 'Original description',
      sourceCorrelation: { ...source, recordId: 'record-1', mappingRevision: 'v1' },
    });
    const intentFingerprint = yield* catalogProductCreateFingerprint(original);
    const database = yield* makeTestDatabase((statement) => {
      if (statement.includes('catalog_source_correlations'))
        return Effect.succeed([{
          tenantId, ...source, entityKind: 'PRODUCT', recordId: 'record-1', mappingRevision: 'v1',
          productId, variantId, actionInvocationId: invocationId, actingPrincipalId: principalId,
          intentFingerprint, recordedAt: new Date('2026-11-23T00:00:00.000Z'),
        }]);
      if (statement.includes('catalog_result_snapshots'))
        return Effect.succeed([{
          tenantId, actionInvocationId: invocationId, actingPrincipalId: principalId,
          actionKey: 'commerce.catalog.create-product', schemaVersion: 1, encodedResult: result,
          recordedAt: new Date('2026-11-23T00:00:00.000Z'),
        }]);
      return Effect.die('Unexpected source recovery query');
    });
    const recovered = yield* catalogSourceCorrelationForScope(database, scope).recoverProduct({
      ...original, name: 'Changed', description: 'Changed description',
    });
    expect(recovered).toEqual({ ...result, businessOriginalCreateInvocationId: invocationId });
  }),
);
