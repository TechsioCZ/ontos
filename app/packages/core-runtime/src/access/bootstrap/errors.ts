import { Schema } from 'effect';

/**
 * Why a tenant could not be given its first access. The code names the phase — intent rows, the release
 * catalog, the owner's role, or the projection — so a bootstrap failure is a fact about one phase rather
 * than "bootstrap failed".
 */
export const AccessBootstrapErrorCodeSchema = Schema.Literals([
  /** The tenant's intent (scopes, memberships, assignments, role) could not be written. */
  'access_bootstrap_intent_refused',
  /** The release catalog could not be published or read back. */
  'access_bootstrap_catalog_refused',
  /** The "Full access" role could not be recorded, or its cells refuse the pinned release. */
  'access_bootstrap_role_refused',
  /** The projection of the tenant was refused or did not complete. */
  'access_bootstrap_projection_refused',
]);

export type AccessBootstrapErrorCode = typeof AccessBootstrapErrorCodeSchema.Type;

export class AccessBootstrapError extends Schema.TaggedError<AccessBootstrapError>()('AccessBootstrapError', {
  code: AccessBootstrapErrorCodeSchema,
  reason: Schema.String,
}) {}

export const bootstrapRefusal = (code: AccessBootstrapErrorCode, reason: string): AccessBootstrapError =>
  new AccessBootstrapError({ code, reason });

/** One source failure as a bootstrap refusal: the source's own code and reason travel in the text. */
export const bootstrapSourceRefusal = (
  code: AccessBootstrapErrorCode,
  cause: { readonly code: string; readonly reason: string },
): AccessBootstrapError => bootstrapRefusal(code, `${cause.code}: ${cause.reason}`);
