import { Schema } from 'effect';

const projectionUnitSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1100));

/**
 * A Core writer invariant that refused to produce a projection, or a projection that did not
 * match intent. Core fails closed on both: an unplannable intent and a drifted graph never leave a
 * half-written scope behind, because nothing is written until the whole plan validates.
 */
export class AccessProjectionError extends Schema.TaggedError<AccessProjectionError>()('AccessProjectionError', {
  code: Schema.Literals([
    'access_projection_ambiguous_role_revision',
    'access_projection_caveat_context_too_large',
    'access_projection_cell_outside_declaration',
    'access_projection_delegation_containment',
    'access_projection_duplicate_intent',
    'access_projection_duplicate_cell_slot',
    'access_projection_duplicate_tuple',
    'access_projection_identifier_too_long',
    'access_projection_engine_rejected',
    'access_projection_limit_without_amount_input',
    'access_projection_principal_kind_refused',
    'access_projection_scope_mismatch',
    'access_projection_unavailable',
    'access_projection_unknown_capability',
    'access_projection_unknown_role_revision',
    'access_projection_verification_failed',
  ]),
  reason: Schema.String,
  unit: Schema.optionalKey(projectionUnitSchema),
}) {}

/**
 * A refusal names the unit it refused. The label is bounded, because a unit whose identifier is
 * already too long for the engine must still be reportable as a refusal instead of failing the
 * report itself (D11).
 */
export const projectionUnitLabel = (unit: string): string => (unit.length <= 1100 ? unit : `${unit.slice(0, 1099)}…`);
