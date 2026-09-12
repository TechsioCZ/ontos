// Canonical schema-only contract for the clear-default-delivery-destination Action.
import { ClearAddressDefaultPayloadSchema, ClearAddressDefaultResultSchema } from '../domain/address-actions.ts';

export const ClearDefaultDeliveryDestinationPayloadSchema = ClearAddressDefaultPayloadSchema;
export type ClearDefaultDeliveryDestinationPayload = typeof ClearDefaultDeliveryDestinationPayloadSchema.Type;

export const ClearDefaultDeliveryDestinationResultSchema = ClearAddressDefaultResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type ClearDefaultDeliveryDestinationResult = typeof ClearDefaultDeliveryDestinationResultSchema.Type;
