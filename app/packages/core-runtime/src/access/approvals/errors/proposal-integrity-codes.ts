/**
 * The integrity codes every produced proposal shares (R2-M5). A lane keeps its own refusal
 * vocabulary, but a record the model forbids or a status move the model does not allow is always
 * one of these two, so the caller can map it exhaustively.
 */
export const PROPOSAL_INTEGRITY_CODES = ['proposal_record_invalid', 'proposal_transition_invalid'] as const;
