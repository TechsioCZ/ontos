import { Schema } from 'effect';

const EntityIdSchema = Schema.String.check(Schema.makeFilter((value) => {
  globalThis.console.log(value);
  return true;
}));
export const makeEntityId = (value: string) => EntityIdSchema.make(value);
