import { Schema } from 'effect';

import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';

export class ExternalCorrelationAmbiguous extends Schema.TaggedError<ExternalCorrelationAmbiguous>()(
  'ExternalCorrelationAmbiguous',
  { candidates: Schema.Array(CatalogResourceRefSchema), reason: Schema.String },
) {}
