import { SetCompositionMutationPayloadSchema } from './set-composition-contract.ts';

export const ReviseSetCompositionPayloadSchema = SetCompositionMutationPayloadSchema;
export type ReviseSetCompositionPayload = typeof ReviseSetCompositionPayloadSchema.Type;
export { SetCompositionMutationResultSchema as ReviseSetCompositionResultSchema } from './set-composition-contract.ts';
