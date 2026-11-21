import { Schema } from 'effect';

import { CatalogResourceRefSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

export class ExternalCorrelationAmbiguous extends Schema.TaggedError<ExternalCorrelationAmbiguous>()(
  'ExternalCorrelationAmbiguous',
  { candidates: Schema.Array(CatalogResourceRefSchema), reason: Schema.String },
) {}
