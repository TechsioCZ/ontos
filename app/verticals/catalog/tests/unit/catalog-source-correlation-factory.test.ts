import { TrustedPrincipalContextSchema, defineDatabaseIdentityEnrollment } from '@app/core-runtime';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { NodeCrypto } from '@effect/platform-node';
import { getTableColumns } from 'drizzle-orm';
import { Effect, Schema, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { CreateProductPayloadSchema, CreateProductResultSchema } from '../../shared/actions/create-product.ts';
import { readCatalogSourceProductPage } from '../../src/api/catalog-source-product-page.read.ts';
import { catalogResultSnapshots, catalogSourceCorrelations } from '../../src/database/schema.ts';
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
const recordedAt = '2026-11-23T00:00:00.000Z';
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
const enrollment = defineDatabaseIdentityEnrollment([]);
const installScopeSql =
  "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id";

const withSourceTransaction = <A, E, R>(
  execute: Parameters<typeof makeTestDatabase>[0],
  use: (transaction: ScopedTransactionExecutor) => Effect.Effect<A, E, R>,
) =>
  makeTestDatabase((statement, params) => {
    if (/^(?:BEGIN|COMMIT|ROLLBACK)$/u.test(statement)) {
      return Effect.succeed([]);
    }
    if (statement === installScopeSql) {
      expect(params).toEqual([tenantId, '']);
      return Effect.succeed([{ legal_entity_id: '', role: 'ontos_runtime', tenant_id: tenantId }]);
    }
    return execute(statement, params);
  }).pipe(
    Effect.flatMap((database) =>
      database.transaction((transaction) =>
        installOperationalScope(transaction, scope, enrollment).pipe(Effect.flatMap(use)),
      ),
    ),
  );

// The scripted client converts rows to positional values, just like a native SELECT.
const tableRow = <Row extends object>(columns: readonly (keyof NoInfer<Row> & string)[], row: Row) =>
  Object.fromEntries(columns.map((key) => [key, row[key]]));

it.effect('constructs the real source page services and returns an unseen search without product hydration', () =>
  Effect.gen(function* test() {
    const phases: string[] = [];
    const result = yield* withSourceTransaction(
      (statement) => {
        if (statement.includes('count(*)')) {
          phases.push('count');
          return Effect.succeed([{ total: 0 }]);
        }
        if (statement.includes('catalog_source_correlations')) {
          phases.push('rows');
          return Effect.succeed([]);
        }
        return Effect.die('Unexpected source page query');
      },
      (transaction) =>
        catalogSourceProductPageForScope(transaction, scope).pipe(
          Effect.flatMap((services) =>
            readCatalogSourceProductPage({ ...source, limit: 1, offset: 0, search: 'unseen' }, services),
          ),
        ),
    );
    expect(result).toEqual({ count: 0, items: [] });
    expect(phases).toEqual(['count', 'rows']);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect('recovers the original source create when a retry changes only its original text', () =>
  Effect.gen(function* test() {
    const productRef = {
      moduleId: 'commerce.catalog',
      resourceId: productId,
      resourceType: 'commerce.catalog.product',
      tenantId,
    };
    const result = yield* Schema.decodeUnknownEffect(CreateProductResultSchema)({
      product: {
        catalogReady: false,
        createdAt: recordedAt,
        description: 'Original description',
        lifecycle: 'DRAFT',
        name: 'Original',
        productRef,
        revision: 1,
        updatedAt: recordedAt,
        variants: [
          {
            lifecycle: 'WORK_IN_PROGRESS',
            productRef,
            variantId,
            variantRef: {
              moduleId: 'commerce.catalog',
              resourceId: variantId,
              resourceType: 'commerce.catalog.variant',
              tenantId,
            },
          },
        ],
      },
      variantId,
    });
    const original = yield* Schema.decodeUnknownEffect(CreateProductPayloadSchema)({
      description: 'Original description',
      name: 'Original',
      sourceCorrelation: { ...source, mappingRevision: 'v1', recordId: 'record-1' },
    });
    const intentFingerprint = yield* catalogProductCreateFingerprint(original);
    const encodedResult = yield* Schema.encodeEffect(CreateProductResultSchema)(result);
    const recovered = yield* withSourceTransaction(
      (statement) => {
        if (statement.includes('catalog_source_correlations')) {
          return Effect.succeed([
            tableRow(Struct.keys(getTableColumns(catalogSourceCorrelations)), {
              ...source,
              actingPrincipalId: principalId,
              actionInvocationId: invocationId,
              entityKind: 'PRODUCT',
              intentFingerprint,
              mappingRevision: 'v1',
              productId,
              recordedAt,
              recordId: 'record-1',
              tenantId,
              variantId,
            }),
          ]);
        }
        if (statement.includes('catalog_result_snapshots')) {
          return Effect.succeed([
            tableRow(Struct.keys(getTableColumns(catalogResultSnapshots)), {
              actingPrincipalId: principalId,
              actionInvocationId: invocationId,
              actionKey: 'commerce.catalog.create-product',
              encodedResult,
              recordedAt,
              schemaVersion: 1,
              tenantId,
            }),
          ]);
        }
        return Effect.die('Unexpected source recovery query');
      },
      (transaction) =>
        catalogSourceCorrelationForScope(transaction, scope).recoverProduct({
          ...original,
          description: 'Changed description',
          name: 'Changed',
        }),
    );
    expect(recovered).toEqual({ ...result, businessOriginalCreateInvocationId: invocationId });
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
