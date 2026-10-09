import { Schema } from 'effect'; // oxlint-disable-line eslint/max-classes-per-file -- Persistence failures are one small closed vocabulary shared by the adapter boundary. expires: 2027-03-31.

export class CatalogPersistenceConflict extends Schema.TaggedError<CatalogPersistenceConflict>()(
  'CatalogPersistenceConflict',
  {
    code: Schema.Literal('catalog_persistence_conflict'),
    conflict: Schema.Literals(['PRODUCT_ID', 'VARIANT_ID', 'ACTION_INVOCATION_ID', 'REVISION']),
    reason: Schema.String,
  },
) {}

export class CatalogPersistenceUnavailable extends Schema.TaggedError<CatalogPersistenceUnavailable>()(
  'CatalogPersistenceUnavailable',
  {
    code: Schema.Literal('catalog_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
