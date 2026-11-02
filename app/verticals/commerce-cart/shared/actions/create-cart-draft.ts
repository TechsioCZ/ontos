import { Schema } from 'effect';
import { CartDraftAddEntrySchema } from '../domain/cart-draft.ts';

export const CreateCartDraftPayloadSchema = Schema.Struct({ entries: Schema.Array(CartDraftAddEntrySchema) });
export { CartDraftMutationResultSchema as CreateCartDraftResultSchema } from '../domain/cart-draft.ts';
export type CreateCartDraftPayload = typeof CreateCartDraftPayloadSchema.Type;
