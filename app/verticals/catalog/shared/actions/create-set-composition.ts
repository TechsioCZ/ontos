import { SetCompositionMutationPayloadSchema } from './set-composition-contract.ts';

export const CreateSetCompositionPayloadSchema = SetCompositionMutationPayloadSchema;
export type CreateSetCompositionPayload = typeof CreateSetCompositionPayloadSchema.Type;
export { SetCompositionMutationResultSchema as CreateSetCompositionResultSchema } from './set-composition-contract.ts';
