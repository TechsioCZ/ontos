import { Schema } from 'effect';

const EntityIdSchema = Schema.Unknown;
export const makeEntityId = (value: string) => EntityIdSchema.make(value);
