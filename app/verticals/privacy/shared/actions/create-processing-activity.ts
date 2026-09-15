import { CreateProcessingActivityInputSchema } from '../domain/processing-activity.ts';

export { ProcessingActivitySchema as CreateProcessingActivityResultSchema } from '../domain/processing-activity.ts';

export const CreateProcessingActivityPayloadSchema = CreateProcessingActivityInputSchema;
export type CreateProcessingActivityPayload = typeof CreateProcessingActivityPayloadSchema.Type;
