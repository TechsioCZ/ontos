import { Schema } from 'effect';

export class AttributePersistenceNotFound extends Schema.TaggedError<AttributePersistenceNotFound>()(
  'AttributePersistenceNotFound',
  {
    code: Schema.Literal('attribute_persistence_not_found'),
    reason: Schema.String,
    resource: Schema.Literals(['DEFINITION', 'CONTROLLED_VALUE']),
  },
) {}
