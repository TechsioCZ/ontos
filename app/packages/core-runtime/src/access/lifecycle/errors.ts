import { Schema } from 'effect';

/**
 * Stable lifecycle refusal codes. Every rule in `src/access/lifecycle` reports one of them instead
 * of throwing, so a writer can map a refusal to a product outcome and a reviewer can name the
 * guarantee it protects. Codes are never reused for a different rule.
 */
export const AccessLifecycleFailureCodeSchema = Schema.Literals([
  'authority_change_scope_missing',
  'authority_reduction_not_held',
  'change_validation_missing',
  'delegation_amount_outside_envelope',
  'delegation_cell_outside_envelope',
  'delegation_end_outside_envelope',
  'delegation_envelope_growth',
  'delegation_holder_outside_envelope',
  'delegation_limits_lost',
  'delegation_not_live',
  'delegation_outside_grantor_authority',
  'delegation_redelegation',
  'delegation_role_empty',
  'delegation_role_outside_envelope',
  'delegation_role_scope_mismatch',
  'delegation_role_unknown',
  'delegation_scope_mismatch',
  'delegation_self_assignment',
  'delegation_self_grant',
  'delegation_unknown_capability',
  'departure_incomplete',
  'departure_overreaches',
  'departure_scope_unknown',
  'fence_held_by_other_operation',
  'fence_not_held_by_operation',
  'fence_revision_conflict',
  'fence_store_unavailable',
  'fence_unavailable',
  'last_owner_removal',
  'operation_already_failed',
  'operation_command_mismatch',
  'operation_journal_invalid',
  'operation_not_owned',
  'operation_phase_regression',
  'operation_store_unavailable',
  'operation_terminal',
  'operation_unknown',
  'owner_transfer_without_successor',
  'ownership_transfer_mismatch',
  'ownership_transfer_not_required',
  'ownership_transfer_required',
  'ownership_transfer_self',
  'reinstall_not_uninstalled',
  'reinstall_resurrection',
  'rejoin_incarnation_reuse',
  'release_reinstalls_module',
  'role_edit_omits_ineligible_holders',
  'role_edit_revives_ended_holder',
  'uninstall_not_enabled',
]);
export type AccessLifecycleFailureCode = typeof AccessLifecycleFailureCodeSchema.Type;

/** A refused lifecycle transition. It is never a denial of a live decision: it stops a write. */
export class AccessLifecycleError extends Schema.TaggedError<AccessLifecycleError>()('AccessLifecycleError', {
  code: AccessLifecycleFailureCodeSchema,
  reason: Schema.String,
}) {}

export const lifecycleRefusal = (code: AccessLifecycleFailureCode, reason: string): AccessLifecycleError =>
  new AccessLifecycleError({ code, reason });
