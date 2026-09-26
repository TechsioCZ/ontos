import { Schema } from 'effect';

const BoundedIdentifierSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const InventoryBackendIdSchema = BoundedIdentifierSchema.pipe(Schema.brand('InventoryBackendId'));
