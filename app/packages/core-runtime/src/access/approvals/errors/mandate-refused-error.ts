import { Schema } from 'effect';

export const MANDATE_REFUSAL_CODES = [
  'agent_cannot_execute',
  'authority_lost',
  'command_changed',
  'execution_not_permitted',
  'proposal_already_executed',
  'proposal_expired',
  'proposal_lapsed',
  'proposal_not_approved',
  'proposal_not_found',
  'proposal_rejected',
] as const;
export type MandateRefusalCode = (typeof MANDATE_REFUSAL_CODES)[number];

/** A mandate executes at most once, for the frozen command, only while every bound witness is live
 * and only as the approving person (guarantee 5, D1, D8, O63). */
export class MandateRefusedError extends Schema.TaggedError<MandateRefusedError>()('MandateRefusedError', {
  code: Schema.Literals(MANDATE_REFUSAL_CODES),
  reason: Schema.String,
}) {}
