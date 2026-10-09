import { describe, expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import { mapCatalogIdentityWriteError, mapCatalogWriteError } from '../../src/persistence/catalog-persistence.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

describe('Catalog write error mapping', () => {
  it('maps only the owned invocation uniqueness constraints to a conflict', () => {
    for (const constraint of ['catalog_product_revisions_invocation_uk', 'catalog_product_lifecycle_invocation_uk']) {
      const result = mapCatalogWriteError({ code: '23505', constraint });
      expect(Schema.is(CatalogPersistenceConflict)(result)).toBe(true);
      expect(result).toMatchObject({ conflict: 'ACTION_INVOCATION_ID' });
    }
  });

  it('preserves outage and indeterminate failures as unavailable even when messages mention invocation', () => {
    for (const failure of [
      new Error('invocation write timed out'),
      { code: '08006', constraint: 'catalog_product_revisions_invocation_uk' },
      { code: '23505', constraint: 'other_invocation_uk' },
      { code: '23505', message: 'duplicate invocation' },
    ]) {
      const result = mapCatalogWriteError(failure);
      expect(Schema.is(CatalogPersistenceUnavailable)(result)).toBe(true);
      expect(result.cause).toBe(failure);
    }
  });

  it('maps only exact Product and Variant identity collisions to their own conflict discriminators', () => {
    for (const constraint of ['products_pkey', 'catalog_products_scope_id_uk']) {
      const result = mapCatalogIdentityWriteError({ code: '23505', constraint }, 'PRODUCT_ID');
      expect(Schema.is(CatalogPersistenceConflict)(result)).toBe(true);
      expect(result).toMatchObject({ conflict: 'PRODUCT_ID' });
    }
    for (const constraint of [
      'product_variants_pkey',
      'catalog_product_variants_scope_id_uk',
      'catalog_product_variants_product_id_variant_id_uk',
    ]) {
      const result = mapCatalogIdentityWriteError({ code: '23505', constraint }, 'VARIANT_ID');
      expect(Schema.is(CatalogPersistenceConflict)(result)).toBe(true);
      expect(result).toMatchObject({ conflict: 'VARIANT_ID' });
    }
  });

  it('never turns message text, another SQLSTATE, or a foreign constraint into an identity conflict', () => {
    for (const [identity, ownConstraint, otherConstraint] of [
      ['PRODUCT_ID', 'catalog_products_scope_id_uk', 'catalog_product_variants_scope_id_uk'],
      ['VARIANT_ID', 'catalog_product_variants_scope_id_uk', 'catalog_products_scope_id_uk'],
    ] as const) {
      for (const failure of [
        new Error(`${identity.toLowerCase()} insert timed out`),
        { code: '08006', constraint: ownConstraint },
        { code: '23505', constraint: otherConstraint },
        { code: '23505', message: `${identity.toLowerCase()} already exists` },
      ]) {
        const result = mapCatalogIdentityWriteError(failure, identity);
        expect(Schema.is(CatalogPersistenceUnavailable)(result)).toBe(true);
        expect(result.cause).toBe(failure);
      }
    }
  });
});
