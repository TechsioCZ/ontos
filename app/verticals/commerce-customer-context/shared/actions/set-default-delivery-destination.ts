// Canonical schema-only contract for the set-default-delivery-destination Action.
import { SetAddressDefaultPayloadSchema, SetAddressDefaultResultSchema } from '../domain/address-actions.ts';

export const SetDefaultDeliveryDestinationPayloadSchema = SetAddressDefaultPayloadSchema;
export type SetDefaultDeliveryDestinationPayload = typeof SetDefaultDeliveryDestinationPayloadSchema.Type;

export const SetDefaultDeliveryDestinationResultSchema = SetAddressDefaultResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type SetDefaultDeliveryDestinationResult = typeof SetDefaultDeliveryDestinationResultSchema.Type;
