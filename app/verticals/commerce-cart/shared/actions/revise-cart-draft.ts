import { Schema } from 'effect';
import {
  CartDraftEntryInstructionSchema,
  CartRevisionNumberSchema,
} from '@app/commerce-cart-contracts/domain/cart-draft';
import { CartRefSchema } from '../resources/cart.ts';

export const ReviseCartDraftPayloadSchema = Schema.Struct({
  cartRef: CartRefSchema,
  entries: Schema.Array(CartDraftEntryInstructionSchema),
  expectedRevision: CartRevisionNumberSchema,
});
export { CartDraftMutationResultSchema as ReviseCartDraftResultSchema } from '@app/commerce-cart-contracts/domain/cart-draft';
export type ReviseCartDraftPayload = typeof ReviseCartDraftPayloadSchema.Type;
