import { Schema } from 'effect';
import { CartDraftAddEntrySchema } from '@app/commerce-cart-contracts/domain/cart-draft';

export const CreateCartDraftPayloadSchema = Schema.Struct({ entries: Schema.Array(CartDraftAddEntrySchema) });
export { CartDraftMutationResultSchema as CreateCartDraftResultSchema } from '@app/commerce-cart-contracts/domain/cart-draft';
export type CreateCartDraftPayload = typeof CreateCartDraftPayloadSchema.Type;
