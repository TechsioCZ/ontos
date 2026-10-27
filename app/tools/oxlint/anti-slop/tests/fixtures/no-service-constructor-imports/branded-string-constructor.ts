// Frozen CRM owner constructor: checks and branding remain part of the proof.
import { Schema } from 'effect';

export const EntityIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('CrmEntityId'),
);
export type EntityId = typeof EntityIdSchema.Type;
export const makeEntityId = (value: string): EntityId => EntityIdSchema.make(value);
