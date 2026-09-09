// Canonical schema-only contract for the add-saved-address Action.
import {
  AddSavedAddressPayloadSchema as AddressPayloadSchema,
  AddSavedAddressResultSchema as AddressResultSchema,
} from '../domain/address-actions.ts';

export const AddSavedAddressPayloadSchema = AddressPayloadSchema;
export type AddSavedAddressPayload = typeof AddSavedAddressPayloadSchema.Type;

export const AddSavedAddressResultSchema = AddressResultSchema;
export type AddSavedAddressResult = typeof AddSavedAddressResultSchema.Type;
