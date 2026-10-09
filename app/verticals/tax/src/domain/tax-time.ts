import { DateTime } from 'effect';

import { TaxRelevantTimeSchema } from '../../shared/domain/tax-kernel/tax-time.ts';
import type { EffectivePeriod, OrderCommitmentTime, TaxRelevantTime } from '../../shared/domain/tax-kernel/tax-time.ts';

/**
 * Final Launch Order Tax-Relevant Time is exactly T. Tax Evaluation Time, client/request time, Pricing Quotation
 * time and DB completion time are not inputs, so none of them can replace T (#941 F2-F4, F10, F12; #927 F10;
 * #907 F156).
 */
export const finalLaunchOrderTaxRelevantTime = (orderCommitmentTime: OrderCommitmentTime): TaxRelevantTime =>
  TaxRelevantTimeSchema.make(orderCommitmentTime);

/**
 * Half-open Effective Period membership at a Tax-Relevant Time: a period starting at T contains T, one ending at
 * T does not, and a future period is not yet applicable (#941 F5, #929 F4-F10). Only Tax-Relevant Time is
 * accepted, never Tax Evaluation Time (#929 F11-F12).
 */
export const isWithinEffectivePeriod = (period: EffectivePeriod, taxRelevantTime: TaxRelevantTime): boolean =>
  DateTime.isGreaterThanOrEqualTo(taxRelevantTime, period.effectiveFrom) &&
  (period.effectiveTo === undefined || DateTime.isLessThan(taxRelevantTime, period.effectiveTo));
