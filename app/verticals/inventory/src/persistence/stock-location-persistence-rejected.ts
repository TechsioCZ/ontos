import { Schema } from 'effect';

import { StockLocationRefSchema } from '../../shared/resources/stock-location.ts';

export class StockLocationPersistenceRejected extends Schema.TaggedError<StockLocationPersistenceRejected>()(
  'StockLocationPersistenceRejected',
  {
    actualRevision: Schema.optionalKey(Schema.Int),
    locationRef: StockLocationRefSchema,
    reason: Schema.Literals([
      'IDENTITY_CONFLICT',
      'INVALID_CREATE',
      'INVALID_TRANSITION',
      'NOT_FOUND',
      'REVISION_CONFLICT',
      'TENANT_SCOPE_MISMATCH',
    ]),
  },
) {}
