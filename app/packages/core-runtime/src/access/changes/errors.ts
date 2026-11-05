import { Schema } from 'effect';

/**
 * Every refusal of the Access-changes area carries exactly one code and a reason naming the
 * object that broke the rule. The vocabulary lives here once so callers never match free text:
 * a batch, an individual adoption, an undo and a publication each fail for their own reason.
 */
export const ACCESS_CHANGES_ERROR_CODES = [
  'access_changes_adoption_not_undoable',
  'access_changes_agent_cannot_decide',
  'access_changes_authority_missing',
  'access_changes_capability_not_configurable',
  'access_changes_declaration_invalid',
  'access_changes_delegation_out_of_envelope',
  'access_changes_duplicate_capability',
  'access_changes_foreign_module_key',
  'access_changes_identity_missing',
  'access_changes_item_invalid',
  'access_changes_item_unavailable',
  'access_changes_lineage_conflict',
  'access_changes_named_effect_mismatch',
  'access_changes_preview_stale',
  'access_changes_sensitive_requires_individual_decision',
  'access_changes_target_invalid',
  'access_changes_undo_conflict',
] as const;

export type AccessChangesErrorCode = (typeof ACCESS_CHANGES_ERROR_CODES)[number];

export class AccessChangesError extends Schema.TaggedError<AccessChangesError>()('AccessChangesError', {
  code: Schema.Literals(ACCESS_CHANGES_ERROR_CODES),
  reason: Schema.String,
}) {}

export const accessChangesError = (code: AccessChangesErrorCode, reason: string): AccessChangesError =>
  new AccessChangesError({ code, reason });
