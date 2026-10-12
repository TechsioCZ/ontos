import { CreateProcessingPurposeInputSchema } from '../domain/processing-purpose.ts';

export { ProcessingPurposeSchema as CreateProcessingPurposeResultSchema } from '../domain/processing-purpose.ts';

export const CreateProcessingPurposePayloadSchema = CreateProcessingPurposeInputSchema;
export type CreateProcessingPurposePayload = typeof CreateProcessingPurposePayloadSchema.Type;
