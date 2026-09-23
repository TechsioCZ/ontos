import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { productVariants } from '../../src/database/schema.ts';
import type { productLocalizedFacts, products } from '../../src/database/schema.ts';
import { catalogPersistenceForScope } from '../../src/persistence/catalog-persistence.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const principalId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-09-17T10:00:00.000Z');
type QueriedTable = typeof products | typeof productVariants | typeof productLocalizedFacts;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-update-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'product-update-test',
};

const productRow = (lifecycleState: 'ACTIVE' | 'DRAFT') => ({
  createdAt: now,
  currentRevision: 1,
  description: null,
  lifecycleState,
  name: lifecycleState === 'ACTIVE' ? 'Legacy label' : 'Product',
  productId,
  updatedAt: now,
});

const makeWhere = (getLocalizedName: () => string | null, lifecycleState: 'ACTIVE' | 'DRAFT', table: QueriedTable) => ({
  limit: () => Effect.succeed([productRow(lifecycleState)]),
  orderBy: () => {
    if (lifecycleState === 'DRAFT') {
      expect(table).toBe(productVariants);
    }
    return Effect.succeed([
      {
        createdAt: now,
        lifecycleState: lifecycleState === 'ACTIVE' ? 'ACTIVE' : 'WORK_IN_PROGRESS',
        productId,
        tenantId,
        variantId,
      },
    ]);
  },
  pipe: () => {
    const localizedName = getLocalizedName();
    return Effect.succeed(localizedName === null ? [] : [localizedName]);
  },
});

const makeFrom = (getLocalizedName: () => string | null, lifecycleState: 'ACTIVE' | 'DRAFT', table: QueriedTable) => ({
  where: () => makeWhere(getLocalizedName, lifecycleState, table),
});

const makeTransaction = (getLocalizedName: () => string | null, lifecycleState: 'ACTIVE' | 'DRAFT') => ({
  insert: () => {
    throw new Error('unverified activation must not append a revision');
  },
  select: () => ({
    from: (table: QueriedTable) => makeFrom(getLocalizedName, lifecycleState, table),
  }),
  update: () => {
    throw new Error('unverified activation must not write');
  },
});

describe('Product update Variant activation', () => {
  it.effect('does not claim Current readiness from a localized name and ACTIVE rows alone', () =>
    Effect.gen(function* checkCurrentName() {
      let localizedName: string | null = null;
      const transaction = makeTransaction(() => localizedName, 'ACTIVE');
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const persistence = yield* catalogPersistenceForScope(transaction, scope);
      const withoutTranslation = yield* persistence.getCurrent(productId);
      expect(Option.getOrThrow(withoutTranslation).catalogReady).toBe(false);
      localizedName = 'Police Alfa';
      const withTranslation = yield* persistence.getCurrent(productId);
      expect(Option.getOrThrow(withTranslation).catalogReady).toBe(false);
    }),
  );

  it.effect('fails closed before any write when draft Current basis is unverified', () =>
    Effect.gen(function* rejectUnverifiedActivation() {
      const transaction = makeTransaction(() => null, 'DRAFT');
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const persistence = yield* catalogPersistenceForScope(transaction, scope);
      const error = yield* persistence
        .update({
          actionInvocationId: '00000000-0000-4000-8000-000000000005',
          activateVariantId: variantId,
          expectedRevision: 1,
          principalId,
          productId,
          reason: 'Activate draft',
          targetLifecycle: 'ACTIVE',
          tenantId,
        })
        .pipe(Effect.flip);
      expect(Schema.is(CatalogPersistenceUnavailable)(error)).toBe(true);
    }),
  );
});
