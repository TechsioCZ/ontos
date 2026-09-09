// Canonical schema-only contract for the clear-default-billing-address Action.
import {
  ClearAddressDefaultPayloadSchema,
  ClearAddressDefaultResultSchema,
} from '../domain/address-actions.ts';

export const ClearDefaultBillingAddressPayloadSchema = ClearAddressDefaultPayloadSchema;
export type ClearDefaultBillingAddressPayload = typeof ClearDefaultBillingAddressPayloadSchema.Type;

export const ClearDefaultBillingAddressResultSchema = ClearAddressDefaultResultSchema;
export type ClearDefaultBillingAddressResult = typeof ClearDefaultBillingAddressResultSchema.Type;
