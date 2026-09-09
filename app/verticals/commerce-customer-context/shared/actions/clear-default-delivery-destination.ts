// Canonical schema-only contract for the clear-default-delivery-destination Action.
import {
  ClearAddressDefaultPayloadSchema,
  ClearAddressDefaultResultSchema,
} from '../domain/address-actions.ts';

export const ClearDefaultDeliveryDestinationPayloadSchema = ClearAddressDefaultPayloadSchema;
export type ClearDefaultDeliveryDestinationPayload =
  typeof ClearDefaultDeliveryDestinationPayloadSchema.Type;

export const ClearDefaultDeliveryDestinationResultSchema = ClearAddressDefaultResultSchema;
export type ClearDefaultDeliveryDestinationResult =
  typeof ClearDefaultDeliveryDestinationResultSchema.Type;
