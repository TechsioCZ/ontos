import { Schema } from 'effect';

export const InitializePopulationAuthorityPayloadSchema = Schema.Record(Schema.String, Schema.Never);
export { CartPopulationAuthoritySchema as InitializePopulationAuthorityResultSchema } from '../domain/cart-draft.ts';
export type InitializePopulationAuthorityPayload = typeof InitializePopulationAuthorityPayloadSchema.Type;
