import { Schema } from 'effect';
import type { Option } from 'effect';

/**
 * The refusal reason codes Core reports in a 403 body, a refusal warning and a recorded rejection:
 * lower-case dotted codes of bounded length and count (`deny.insufficient_grant`,
 * `deny.owner.counterparty_grant_missing`, `requires.counterparty.address_book.manage`). They name a
 * rule or a right, never request data.
 */
const REASON_CODE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/u;
export const REASON_CODE_MAX_LENGTH = 120;
export const REASON_CODE_MAX_COUNT = 8;

export const ReportableReasonCodeSchema = Schema.String.check(
  Schema.isMaxLength(REASON_CODE_MAX_LENGTH),
  Schema.isPattern(REASON_CODE_PATTERN),
);

export const ReportableReasonCodesSchema = Schema.Array(ReportableReasonCodeSchema).check(
  Schema.isMaxLength(REASON_CODE_MAX_COUNT),
);
const decodeReasonCodes = Schema.decodeUnknownOption(ReportableReasonCodesSchema);

/** The codes exactly as given when every one is reportable, otherwise none. */
export const reportableReasonCodes = (codes: readonly string[]): Option.Option<readonly string[]> =>
  decodeReasonCodes(codes);
