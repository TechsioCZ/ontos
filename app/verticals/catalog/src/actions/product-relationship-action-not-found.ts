import { Schema } from 'effect';

export class ProductRelationshipActionNotFound extends Schema.TaggedError<ProductRelationshipActionNotFound>()(
  'ProductRelationshipActionNotFound',
  { code: Schema.Literal('product_relationship_not_found'), reason: Schema.String },
) {}
