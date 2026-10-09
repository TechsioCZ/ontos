import { Schema } from 'effect'; // oxlint-disable-line eslint/max-classes-per-file -- These two tagged failures form one cohesive owner-local reconciliation vocabulary; expires: 2027-03-31.

export class PriceGroupContainmentProjectionPersistenceUnavailable extends Schema.TaggedError<PriceGroupContainmentProjectionPersistenceUnavailable>()(
  'PriceGroupContainmentProjectionPersistenceUnavailable',
  {
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
) {}

export class PriceGroupContainmentProjectionConflict extends Schema.TaggedError<PriceGroupContainmentProjectionConflict>()(
  'PriceGroupContainmentProjectionConflict',
  {
    reason: Schema.String,
    retryable: Schema.Literal(false),
  },
) {}
