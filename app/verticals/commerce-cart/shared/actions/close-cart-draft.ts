import { Schema } from 'effect';
import { CartRevisionNumberSchema } from '../domain/cart-draft.ts';
import { CartRefSchema } from '../resources/cart.ts';

export const CloseCartDraftPayloadSchema = Schema.Struct({
  cartRef: CartRefSchema,
  expectedRevision: CartRevisionNumberSchema,
});
export { CartDraftMutationResultSchema as CloseCartDraftResultSchema } from '../domain/cart-draft.ts';
export type CloseCartDraftPayload = typeof CloseCartDraftPayloadSchema.Type;
