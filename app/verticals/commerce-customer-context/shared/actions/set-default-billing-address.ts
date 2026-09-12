// Canonical schema-only contract for the set-default-billing-address Action.
import { SetAddressDefaultPayloadSchema, SetAddressDefaultResultSchema } from '../domain/address-actions.ts';

export const SetDefaultBillingAddressPayloadSchema = SetAddressDefaultPayloadSchema;
export type SetDefaultBillingAddressPayload = typeof SetDefaultBillingAddressPayloadSchema.Type;

export const SetDefaultBillingAddressResultSchema = SetAddressDefaultResultSchema;
// eslint-disable-next-line no-unused-vars -- Preserve the generated named result contract for this schema alias.
type SetDefaultBillingAddressResult = typeof SetDefaultBillingAddressResultSchema.Type;
