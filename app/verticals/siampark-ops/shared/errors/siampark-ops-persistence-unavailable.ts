import { Schema } from 'effect';

export class SiamparkOpsPersistenceUnavailable extends Schema.TaggedError<SiamparkOpsPersistenceUnavailable>()(
  'SiamparkOpsPersistenceUnavailable',
  {
    code: Schema.Literal('siampark_ops_persistence_unavailable'),
    reason: Schema.String,
  },
) {}
