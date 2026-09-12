// Canonical schema-only contract for the clear-default-billing-address Action.
import { ClearAddressDefaultPayloadSchema, ClearAddressDefaultResultSchema } from '../domain/address-actions.ts';

export const ClearDefaultBillingAddressPayloadSchema = ClearAddressDefaultPayloadSchema;
export type ClearDefaultBillingAddressPayload = typeof ClearDefaultBillingAddressPayloadSchema.Type;

export const ClearDefaultBillingAddressResultSchema = ClearAddressDefaultResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type ClearDefaultBillingAddressResult = typeof ClearDefaultBillingAddressResultSchema.Type;
