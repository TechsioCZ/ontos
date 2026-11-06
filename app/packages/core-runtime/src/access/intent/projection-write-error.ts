import { Schema } from 'effect';

/**
 * Why a tenant's projection could not be reconciled. Every code names a phase of the one write path, so
 * a caller (and "Proč?") can tell a retryable engine failure from an intent Core refuses to project.
 */
export const AccessProjectionWriteErrorCodeSchema = Schema.Literals([
  /** Core's intent could not be read, so there is nothing trustworthy to project. */
  'access_projection_write_intent_unavailable',
  /** The tenant has no tenant-context scope, so no fence covers its projection. */
  'access_projection_write_scope_missing',
  /** The intent is not projectable: the compiler refuses it before anything is written. */
  'access_projection_write_plan_refused',
  /** The tenant's fence belongs to another operation, or a scope it writes cannot be fenced. */
  'access_projection_write_fence_refused',
  /** The engine did not complete, refused the plan, or the graph still differed afterwards. */
  'access_projection_write_unavailable',
]);

export type AccessProjectionWriteErrorCode = typeof AccessProjectionWriteErrorCodeSchema.Type;

/**
 * A reconcile that refused or could not complete. The projection's own violations travel with it, so a
 * caller reports the exact capability or tuple that stopped the write instead of "projection failed".
 */
export class AccessProjectionWriteError extends Schema.TaggedError<AccessProjectionWriteError>()(
  'AccessProjectionWriteError',
  {
    code: AccessProjectionWriteErrorCodeSchema,
    reason: Schema.String,
    /** The compiler's own refusals, in its order; absent when the failure is not a plan violation. */
    violations: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  // Promise/test-runner boundaries print Error.message, not Schema's structured fields.
  override get message(): string {
    const reasons = this.violations !== undefined && this.violations.length > 0 ? this.violations : [this.reason];
    return `${this.code}: ${reasons.join('; ')}`;
  }
}

export const projectionWriteRefusal = (
  code: AccessProjectionWriteErrorCode,
  reason: string,
): AccessProjectionWriteError => new AccessProjectionWriteError({ code, reason });

/**
 * One refusal with the compiler's violations. `exactOptionalPropertyTypes` forbids an absent list, so a
 * single violation travels as the reason alone and only a longer one fills the list.
 */
export const projectionWriteViolation = (
  code: AccessProjectionWriteErrorCode,
  reasons: readonly string[],
): AccessProjectionWriteError => {
  const [first] = reasons;
  const base = { code, reason: first ?? 'The projection of this tenant was refused' };
  return new AccessProjectionWriteError(reasons.length > 1 ? { ...base, violations: [...reasons] } : base);
};
