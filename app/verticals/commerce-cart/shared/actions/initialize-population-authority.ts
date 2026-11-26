import { Schema } from 'effect';

export const InitializePopulationAuthorityPayloadSchema = Schema.Record(Schema.String, Schema.Never);
export { CartPopulationAuthoritySchema as InitializePopulationAuthorityResultSchema } from '@app/commerce-cart-contracts/domain/cart-draft';
export type InitializePopulationAuthorityPayload = typeof InitializePopulationAuthorityPayloadSchema.Type;
