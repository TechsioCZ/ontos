// Canonical schema-only contract extracted from the generated enroll-retail-customer Action.
import { Schema } from 'effect';

import { ActionInvocationIdSchema } from '../domain/correction-contracts.ts';
import { EmailContactPointInputSchema, PhoneContactPointInputSchema } from '../domain/contact-point.ts';
import { PartyRefSchema } from '../resources/party.ts';
import { RetailEnrollmentEvidenceSchema } from './accept-retail-enrollment-evidence.ts';

/** Contacts are declarations for the proven Party; they establish neither identity nor authority. */
export const EnrollRetailCustomerPayloadSchema = Schema.Struct({
  email: EmailContactPointInputSchema.fields.value,
  evidence: RetailEnrollmentEvidenceSchema,
  originalInvocationId: ActionInvocationIdSchema,
  phone: Schema.optionalKey(PhoneContactPointInputSchema),
});
export type EnrollRetailCustomerPayload = typeof EnrollRetailCustomerPayloadSchema.Type;

export const EnrollRetailCustomerResultSchema = Schema.Struct({ partyRef: PartyRefSchema });
export type EnrollRetailCustomerResult = typeof EnrollRetailCustomerResultSchema.Type;
