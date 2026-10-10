import { Schema } from 'effect';

import { SellingLegalEntityVatRegistrationStateSchema } from './selling-legal-entity-vat-registration.ts';
import { CurrencyCodeSchema } from './tax-domain-primitives.ts';
import { UnsupportedTaxRegimeSchema } from './tax-non-success-outcome.ts';
import { TaxTreatmentCategorySchema } from './tax-treatment.ts';
import { OccurrenceSupplyMeaningsSchema } from './taxable-supply-unit.ts';

/** Tax regime an exact purchase requires; only ordinary domestic is activated (#918 F2-F3, F28). */
export const RequiredTaxRegimeSchema = Schema.Union([Schema.Literal('ORDINARY_DOMESTIC'), UnsupportedTaxRegimeSchema]);

export type RequiredTaxRegime = typeof RequiredTaxRegimeSchema.Type;

/**
 * Explicit closed-world Launch coverage inputs. Purchasing Subject kind, buyer VAT status, B2B Channel,
 * Counterparty labels and DIČ are not inputs: they never switch ordinary domestic treatment (#918 F9-F12,
 * #923 F1-F2, F13-F16, #924 F7, F11-F14).
 */
export const LaunchTaxCoverageInputSchema = Schema.Struct({
  currency: CurrencyCodeSchema,
  requiredTaxRegimes: Schema.NonEmptyArray(RequiredTaxRegimeSchema),
  requiredTaxTreatments: Schema.NonEmptyArray(TaxTreatmentCategorySchema),
  sellingLegalEntityVatRegistration: SellingLegalEntityVatRegistrationStateSchema,
  supplyMeanings: OccurrenceSupplyMeaningsSchema,
});

export type LaunchTaxCoverageInput = typeof LaunchTaxCoverageInputSchema.Type;
