// Canonical schema-only contract for the remove-saved-address Action.
import {
  RemoveSavedAddressPayloadSchema as AddressPayloadSchema,
  RemoveSavedAddressResultSchema as AddressResultSchema,
} from '../domain/address-actions.ts';

export const RemoveSavedAddressPayloadSchema = AddressPayloadSchema;
export type RemoveSavedAddressPayload = typeof RemoveSavedAddressPayloadSchema.Type;

export const RemoveSavedAddressResultSchema = AddressResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type RemoveSavedAddressResult = typeof RemoveSavedAddressResultSchema.Type;
