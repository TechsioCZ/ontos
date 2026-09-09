// Canonical schema-only contract for the remove-saved-address Action.
import {
  RemoveSavedAddressPayloadSchema as AddressPayloadSchema,
  RemoveSavedAddressResultSchema as AddressResultSchema,
} from '../domain/address-actions.ts';

export const RemoveSavedAddressPayloadSchema = AddressPayloadSchema;
export type RemoveSavedAddressPayload = typeof RemoveSavedAddressPayloadSchema.Type;

export const RemoveSavedAddressResultSchema = AddressResultSchema;
export type RemoveSavedAddressResult = typeof RemoveSavedAddressResultSchema.Type;
