// Public contract adapted from the generated commerce.order Action.
import { CompleteOrderPreparationInputSchema } from '../domain/order-commitment.ts';

export const CompleteOrderPreparationPayloadSchema = CompleteOrderPreparationInputSchema;
export { OrderPreparationProgressSchema as CompleteOrderPreparationResultSchema } from '../domain/order-commitment.ts';
export type CompleteOrderPreparationPayload = typeof CompleteOrderPreparationPayloadSchema.Type;
