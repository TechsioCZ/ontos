import { Schema } from 'effect';

/**
 * Tag of the explicit unresolved historical-input outcome of a correction (#947 F13, #948 F7, #907 F195). It is a
 * correction-input outcome, kept outside the purchase-evaluation `TAX_*` non-success family; the name is the PO
 * default of open decision D4, so a rename is this one constant.
 */
export const TAX_HISTORICAL_INPUT_UNRESOLVED = 'TAX_HISTORICAL_INPUT_UNRESOLVED';

/**
 * Why the Authoritative Original Accepted Record cannot establish the correction baseline: the requested unit is
 * not in the record's exact unit partition, or the supplied Accepted Cumulative Correction State cannot have
 * followed from that record. The owner of the record must recover it; TAX never reconstructs it (#946 F12).
 */
export const TaxHistoricalInputUnresolvedReasonSchema = Schema.Literals([
  'UNIT_NOT_IN_ORIGINAL_RECORD',
  'STATE_INCONSISTENT_WITH_ORIGINAL_RECORD',
]);
