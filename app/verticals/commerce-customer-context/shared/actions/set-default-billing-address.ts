// Canonical schema-only contract for the set-default-billing-address Action.
import {
  SetAddressDefaultPayloadSchema,
  SetAddressDefaultResultSchema,
} from '../domain/address-actions.ts';

export const SetDefaultBillingAddressPayloadSchema = SetAddressDefaultPayloadSchema;
export type SetDefaultBillingAddressPayload = typeof SetDefaultBillingAddressPayloadSchema.Type;

export const SetDefaultBillingAddressResultSchema = SetAddressDefaultResultSchema;
export type SetDefaultBillingAddressResult = typeof SetDefaultBillingAddressResultSchema.Type;
