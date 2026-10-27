import { Schema } from 'effect';

const EntityIdSchema = Schema.String;
export const makeEntityId = (value: string) => EntityIdSchema.make(() => value);
