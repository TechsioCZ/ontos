// Canonical schema-only contract for the update-saved-address Action.
import {
  UpdateSavedAddressPayloadSchema as AddressPayloadSchema,
  UpdateSavedAddressResultSchema as AddressResultSchema,
} from '../domain/address-actions.ts';

export const UpdateSavedAddressPayloadSchema = AddressPayloadSchema;
export type UpdateSavedAddressPayload = typeof UpdateSavedAddressPayloadSchema.Type;

export const UpdateSavedAddressResultSchema = AddressResultSchema;
export type UpdateSavedAddressResult = typeof UpdateSavedAddressResultSchema.Type;
