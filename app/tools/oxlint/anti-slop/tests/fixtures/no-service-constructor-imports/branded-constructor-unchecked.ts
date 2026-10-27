import { Schema } from 'effect';

const EntityIdSchema = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('CrmEntityId'));
export const makeEntityId = (value: string) => EntityIdSchema.make(value, { disableChecks: true });
