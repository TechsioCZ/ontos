import { createHmac } from 'node:crypto';

import { Context, Effect, Redacted } from 'effect';

import type { CommercePortalAuthAuditEvent } from './audit-contracts.ts';
import type { CommercePortalAuthAuditUnavailable } from './audit-unavailable.ts';

/**
 * The Commerce-owned audit port. The authentication transport runs outside an Action invocation —
 * a refused sign-in has no tenant and no Principal — so owner-emitted evidence is written here
 * instead of through the Action outbox.
 */
export interface CommercePortalAuthAuditRecorder {
  readonly record: (event: CommercePortalAuthAuditEvent) => Effect.Effect<void, CommercePortalAuthAuditUnavailable>;
}

export class CommercePortalAuthAudit extends Context.Service<
  CommercePortalAuthAudit,
  CommercePortalAuthAuditRecorder
>()('@app/commerce-customer-context/portal-auth/audit/audit-service/CommercePortalAuthAudit') {}

/**
 * A service constructed without the audit port still answers. Production supplies the durable
 * recorder from the composition root; silence is a missing Layer, never a dropped decision.
 */
export const unauditedCommercePortalAuthRecorder: CommercePortalAuthAuditRecorder = Object.freeze({
  record: () => Effect.void,
});

/**
 * An attempted address never reaches a row. It is keyed under the deployment secret exactly as the
 * durable sign-in budget keys it, so the same subject is correlatable across rows without the
 * audit trail becoming a readable list of the portal's customers.
 */
export const commercePortalAuthSubjectDigest = (email: string, secret: Redacted.Redacted): string =>
  createHmac('sha256', Redacted.value(secret)).update(email.trim().toLowerCase()).digest('base64url');

/**
 * The lenient recorder, for read-side and decision-only events: a refused sign-in, a rate-limited
 * attempt, a session read, a revoke that matched nothing. Audit evidence must not turn a completed
 * authentication decision into a transport failure, so a store outage is logged with the event
 * identity and the caller continues. Nothing durable changed; only the evidence row is lost, and
 * the log names it.
 *
 * A state change may never take this path. A revocation, an account disable, a rotation or a
 * renewal writes its row inside the very transaction that changes the state, through the audited
 * session-store methods — so a refused audit insert rolls the state change back instead of leaving
 * it committed without evidence (`../persistence/portal-auth-session-store.ts`).
 */
export const recordCommercePortalAuthAudit = (
  recorder: CommercePortalAuthAuditRecorder,
  event: CommercePortalAuthAuditEvent,
): Effect.Effect<void> =>
  recorder.record(event).pipe(
    Effect.catchTag('CommercePortalAuthAuditUnavailable', (failure) =>
      Effect.annotateLogs(Effect.logError('Commerce portal authentication audit evidence was not persisted', failure), {
        auditEventType: event.eventType,
        auditOutcome: event.outcome,
        operation: failure.operation,
      }),
    ),
  );

/** Emits the event through the ambient audit port; used by transports that already read context. */
export const emitCommercePortalAuthAudit = Effect.fn('CommercePortalAuthAudit.emit')(
  function* emitCommercePortalAuthAuditEffect(
    event: CommercePortalAuthAuditEvent,
  ): Effect.fn.Return<void, never, CommercePortalAuthAudit> {
    const recorder = yield* CommercePortalAuthAudit;
    yield* recordCommercePortalAuthAudit(recorder, event);
  },
);
