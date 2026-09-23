import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Exit, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  productLocalizedFactRevisions,
  productLocalizedFacts,
  products,
  productVariants,
  variantLocalizedFactRevisions,
  variantLocalizedFacts,
} from '../../src/database/schema.ts';
import { localizedFactsReadsForScope } from '../../src/persistence/localized-facts-reads.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const principalId = '00000000-0000-4000-8000-000000000004';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:localized-read-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'localized-read-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const fact = {
  currentRevision: 3,
  description: null,
  locale: 'cs-CZ',
  name: 'Nový název',
  productId,
  state: 'SET',
  tenantId,
};
const revision = {
  actingPrincipalId: principalId,
  actionInvocationId: '00000000-0000-4000-8000-000000000005',
  description: null,
  evidenceRefs: [],
  locale: 'cs-CZ',
  name: 'Starý název',
  productId,
  reason: 'Original copy',
  recordedAt: new Date('2026-01-01T00:00:00.000Z'),
  revision: 1,
  state: 'SET',
  tenantId,
};
type Table =
  | typeof products
  | typeof productVariants
  | typeof productLocalizedFacts
  | typeof productLocalizedFactRevisions
  | typeof variantLocalizedFactRevisions
  | typeof variantLocalizedFacts;
const selected = (values: readonly object[]) => {
  const effect = Effect.succeed(values);
  return { limit: () => effect, orderBy: () => effect, pipe: () => effect };
};
const mockTransaction = (rows: Map<Table, readonly object[]>) => ({
  select: () => ({ from: (table: Table) => ({ where: () => selected(rows.get(table) ?? []) }) }),
});

describe('localized facts private reads', () => {
  it.effect('lists only exact historical locale revisions, including removal, in revision order', () =>
    Effect.gen(function* historicalTimeline() {
      const rows = new Map<Table, readonly object[]>([
        [products, [{ productId }]],
        [productLocalizedFactRevisions, [revision, { ...revision, name: null, revision: 2, state: 'REMOVED' }]],
      ]);
      // @ts-expect-error Focused mock implements only queried Drizzle chains.
      const reads = localizedFactsReadsForScope(mockTransaction(rows), scope);
      expect(yield* reads.productHistory(productRef, 'cs-CZ')).toMatchObject([
        { historical: true, kind: 'SET', locale: 'cs-CZ', name: 'Starý název', revision: 1 },
        { historical: true, kind: 'REMOVED', locale: 'cs-CZ', revision: 2 },
      ]);
      rows.set(productLocalizedFactRevisions, []);
      expect(yield* reads.productHistory(productRef, 'de-DE')).toEqual([]);
    }),
  );
  it.effect('keeps exact historical revision independent of Current and retains provenance', () =>
    Effect.gen(function* exactHistoricalRevision() {
      const rows = new Map<Table, readonly object[]>([
        [products, [{ productId }]],
        [productLocalizedFacts, [fact]],
        [productLocalizedFactRevisions, [{ ...revision, name: 'Nový název', revision: 3 }]],
      ]);
      // @ts-expect-error Focused mock implements only queried Drizzle chains.
      const reads = localizedFactsReadsForScope(mockTransaction(rows), scope);
      expect(yield* reads.currentProduct(productRef, 'cs-CZ')).toMatchObject({
        kind: 'PRESENT',
        name: 'Nový název',
        revision: 3,
      });
      rows.set(productLocalizedFactRevisions, [revision]);
      const historical = yield* reads.productRevision(productRef, 'cs-CZ', 1);
      expect(Option.isSome(historical)).toBe(true);
      if (Option.isNone(historical)) {
        return;
      }
      expect(historical.value).toMatchObject({
        kind: 'PRESENT',
        name: 'Starý název',
        provenance: { reason: 'Original copy' },
        revision: 1,
      });
    }),
  );

  it.effect('reports missing translation without borrowing another locale', () =>
    Effect.gen(function* missingTranslation() {
      const rows = new Map<Table, readonly object[]>([
        [products, [{ productId }]],
        [productLocalizedFacts, []],
      ]);
      // @ts-expect-error Focused mock implements only queried Drizzle chains.
      const reads = localizedFactsReadsForScope(mockTransaction(rows), scope);
      expect(yield* reads.currentProduct(productRef, 'de-DE')).toEqual({
        kind: 'MISSING_TRANSLATION',
        locale: 'de-DE',
        revision: 0,
      });
    }),
  );

  it.effect('reads Variant override without substituting Product text', () =>
    Effect.gen(function* variantOverride() {
      const rows = new Map<Table, readonly object[]>([
        [productVariants, [{ id: variantId }]],
        [variantLocalizedFacts, [{ ...fact, name: 'Varianta', variantId }]],
        [variantLocalizedFactRevisions, [{ ...revision, name: 'Varianta', revision: 3, variantId }]],
      ]);
      // @ts-expect-error Focused mock implements only queried Drizzle chains.
      const reads = localizedFactsReadsForScope(mockTransaction(rows), scope);
      expect(yield* reads.currentVariant(productRef, variantRef, 'cs-CZ')).toMatchObject({
        kind: 'PRESENT',
        name: 'Varianta',
      });
    }),
  );

  it.effect('fails closed for cross-tenant references before querying', () =>
    Effect.gen(function* rejectCrossTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('transaction touched');
          },
        },
      );
      // @ts-expect-error Invalid references must not access the transaction.
      const reads = localizedFactsReadsForScope(transaction, scope);
      const result = yield* Effect.exit(
        reads.currentProduct({ ...productRef, tenantId: '00000000-0000-4000-8000-000000000099' }, 'cs-CZ'),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );

  it.effect('fails closed on malformed revision provenance', () =>
    Effect.gen(function* malformedProvenance() {
      const rows = new Map<Table, readonly object[]>([
        [products, [{ productId }]],
        [productLocalizedFactRevisions, [{ ...revision, reason: '  ' }]],
      ]);
      // @ts-expect-error Focused mock implements only queried Drizzle chains.
      const reads = localizedFactsReadsForScope(mockTransaction(rows), scope);
      const result = yield* Effect.exit(reads.productRevision(productRef, 'cs-CZ', 1));
      expect(Exit.isFailure(result)).toBe(true);
    }),
  );
});
