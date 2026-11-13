import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { GatewayRefusalReasonSchema } from '@app/shared-contracts';
import type { GatewayAudienceSchema, GatewayRefusalReason } from '@app/shared-contracts';
import { Effect, Option, Predicate, Schema } from 'effect';

/** A refused delegated issuance: the status class (`code`) and the stable step that refused it (`reason`). */
export class GatewayDelegationError extends Schema.TaggedError<GatewayDelegationError>()('GatewayDelegationError', {
  cause: Schema.optionalKey(Schema.Defect()),
  /**
   * `module_not_installed`: the module the call is for is not installed for the subject's tenant (no state there).
   * Every other refusal (an unknown or retired module credential, another release, a subject not admitted) is
   * `forbidden`.
   */
  code: Schema.Literals([
    'authentication_required',
    'forbidden',
    'module_not_installed',
    'unavailable',
    'reload_required',
  ]),
  reason: GatewayRefusalReasonSchema,
}) {}

/** A step that could not answer: the caller may retry. */
export const delegationUnavailable =
  (reason: GatewayRefusalReason) =>
  (cause?: unknown): GatewayDelegationError =>
    new GatewayDelegationError({ cause, code: 'unavailable', reason });

/**
 * A step that answered no. A principal resolver that could not answer is unavailable, never a refusal; it then reports
 * `whenUnavailable`.
 */
export const delegationForbidden =
  (reason: GatewayRefusalReason, whenUnavailable: GatewayRefusalReason = 'caller_principal_unavailable') =>
  (cause?: unknown): GatewayDelegationError =>
    Predicate.isTagged(cause, 'PrincipalResolverUnavailableError')
      ? new GatewayDelegationError({ cause, code: 'unavailable', reason: whenUnavailable })
      : new GatewayDelegationError({ cause, code: 'forbidden', reason });

/** What the issuer has learned about a call when one of its steps refuses it. */
export interface RefusalContext {
  readonly callerAppId?: typeof GatewayAudienceSchema.Type;
  readonly tenantId?: typeof TenantIdSchema.Type;
}

/** The subject's tenant as a refusal names it; an id that is not a tenant id names none. */
export const refusalTenant = (tenantId: string): RefusalContext =>
  Option.match(Schema.decodeUnknownOption(TenantIdSchema)(tenantId), {
    onNone: () => ({}),
    onSome: (tenant) => ({ tenantId: tenant }),
  });

/** One refused issuance as its warning line names it. */
export interface DelegationRefusal {
  readonly audience: string;
  readonly context: RefusalContext;
  readonly reason: GatewayRefusalReason;
  readonly status: string;
}

/**
 * The one warning line a refused delegated issuance writes: the stable reason code and the identifiers that are not
 * secret (calling module, the subject's tenant, audience), never a key, token or subject.
 */
export const logDelegationRefusal = (refusal: DelegationRefusal) =>
  Effect.logWarning('gateway delegation refused').pipe(
    Effect.annotateLogs({
      audience: refusal.audience,
      callerAppId: refusal.context.callerAppId ?? 'unknown',
      reason: refusal.reason,
      status: refusal.status,
      subjectTenant: refusal.context.tenantId ?? 'unknown',
    }),
  );
