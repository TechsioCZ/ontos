import { Schema } from 'effect';
import { CartRevisionNumberSchema } from '@app/commerce-cart-contracts/domain/cart-draft';
import { CartRefSchema } from '../resources/cart.ts';

export const CloseCartDraftPayloadSchema = Schema.Struct({
  cartRef: CartRefSchema,
  expectedRevision: CartRevisionNumberSchema,
});
export { CartDraftMutationResultSchema as CloseCartDraftResultSchema } from '@app/commerce-cart-contracts/domain/cart-draft';
export type CloseCartDraftPayload = typeof CloseCartDraftPayloadSchema.Type;
