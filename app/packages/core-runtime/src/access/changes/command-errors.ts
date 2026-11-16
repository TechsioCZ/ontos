import { Schema } from 'effect';

import type { AccessChangesError } from './errors.ts';

/*
 * The two refusals the Novinky seam itself states: the cases no plan decides. A `conflict` is a lost
 * compare-and-set, a stale read or a release that moved, which the caller repairs by re-reading;
 * `unavailable` is retryable and is never reported as a denial. The plans keep their own vocabulary
 * (`access/changes/errors.ts`) and this module never restates it.
 */

export const ACCESS_CHANGES_COMMAND_ERROR_CODES = [
  'access_changes_command_authority_absent',
  'access_changes_command_conflict',
  'access_changes_command_release_missing',
  /** The decision is recorded; its projection did not complete, and a retry of the same request finishes it. */
  'access_changes_command_saved_projection_pending',
  'access_changes_command_unavailable',
] as const;

export type AccessChangesCommandErrorCode = (typeof ACCESS_CHANGES_COMMAND_ERROR_CODES)[number];

export class AccessChangesCommandError extends Schema.TaggedError<AccessChangesCommandError>()(
  'AccessChangesCommandError',
  {
    code: Schema.Literals(ACCESS_CHANGES_COMMAND_ERROR_CODES),
    reason: Schema.String,
  },
) {}

/** Every refusal this seam reports: a decision the plans refused, or the seam's own answer. */
export type AccessChangesCommandFailure = AccessChangesError | AccessChangesCommandError;

export const accessChangesCommandError = (
  code: AccessChangesCommandErrorCode,
  reason: string,
): AccessChangesCommandError => new AccessChangesCommandError({ code, reason });
