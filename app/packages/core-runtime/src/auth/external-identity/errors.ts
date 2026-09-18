import { Schema } from 'effect';

/**
 * Internal failures for the Core external identity boundary.
 *
 * The public Action and Read contracts deliberately expose the smaller
 * `ExternalIdentityError` vocabulary.  Keeping a reason on this private
 * failure lets repositories retain useful diagnostics without allowing a
 * provider subject or credential reference to cross the boundary.
 */
const EXTERNAL_IDENTITY_FAILURE_CODES = [
  'identity_invalid',
  'identity_unusable',
  'identity_forbidden',
  'identity_not_found',
  'identity_conflict',
  'identity_ineligible',
  'identity_unavailable',
] as const;

export type ExternalIdentityFailureCode = (typeof EXTERNAL_IDENTITY_FAILURE_CODES)[number];

export class ExternalIdentityFailure extends Schema.TaggedError<ExternalIdentityFailure>()('ExternalIdentityFailure', {
  code: Schema.Literals(EXTERNAL_IDENTITY_FAILURE_CODES),
  reason: Schema.String,
}) {}

export const externalIdentityFailure = (code: ExternalIdentityFailureCode, reason: string): ExternalIdentityFailure =>
  new ExternalIdentityFailure({ code, reason });
