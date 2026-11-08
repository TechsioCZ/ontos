import { Schema } from 'effect';

const catalogModuleId = Schema.String.pipe(Schema.brand('AccessCatalogModuleId'), Schema.decodeTo(Schema.String));

export class AccessCatalogError extends Schema.TaggedError<AccessCatalogError>()('AccessCatalogError', {
  code: Schema.Literals([
    'access_catalog_declaration_invalid',
    'access_catalog_duplicate_key',
    'access_catalog_foreign_entrypoint',
    'access_catalog_lineage_conflict',
    'access_catalog_lineage_cycle',
  ]),
  moduleId: catalogModuleId,
  reason: Schema.String,
}) {}
