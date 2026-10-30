import { Context, Schema } from 'effect';

const EntityIdSchema = Schema.String.pipe(Schema.brand('CrmEntityId'));
export const makeEntityId = (dependency: Context.Context<never>) => EntityIdSchema.make(dependency);
