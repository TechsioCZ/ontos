import { Schema } from 'effect';

/**
 * Selling Legal Entity VAT Registration state for one evaluation: exactly one of Current positive, known
 * ended/non-registered, unknown, unavailable, stale or unresolved; never a nullable boolean (#938 F8-F9, F13-F15,
 * F32; glossary). Deriving this state from source assertions is owned elsewhere; Launch coverage only consumes it.
 */
export const SellingLegalEntityVatRegistrationStateSchema = Schema.Literals([
  'CURRENT_POSITIVE',
  'KNOWN_ENDED_OR_NON_REGISTERED',
  'UNKNOWN',
  'UNAVAILABLE',
  'STALE',
  'UNRESOLVED',
]);
export type SellingLegalEntityVatRegistrationState = typeof SellingLegalEntityVatRegistrationStateSchema.Type;
