import { Schema } from 'effect';
import { CartDraftEntryInstructionSchema, CartRevisionNumberSchema } from '../domain/cart-draft.ts';
import { CartRefSchema } from '../resources/cart.ts';

export const ReviseCartDraftPayloadSchema = Schema.Struct({
  cartRef: CartRefSchema,
  entries: Schema.Array(CartDraftEntryInstructionSchema),
  expectedRevision: CartRevisionNumberSchema,
});
export { CartDraftMutationResultSchema as ReviseCartDraftResultSchema } from '../domain/cart-draft.ts';
export type ReviseCartDraftPayload = typeof ReviseCartDraftPayloadSchema.Type;
