import type { Cause } from 'effect';
import { Schema } from 'effect';

export const actionErrorSchema = <
  const Tag extends string,
  const Fields extends Schema.Struct.Fields,
>(
  tag: Tag,
  fields: Fields,
) => {
  type Contract = Schema.TaggedStruct<Tag, Fields>;
  return Schema.TaggedError<Contract['Type'] & Cause.YieldableError>()(tag, fields);
};
