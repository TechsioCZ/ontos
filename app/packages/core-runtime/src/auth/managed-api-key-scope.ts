import { and, desc, eq, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';

import { auditEvents, principalAuthBindings, principalCompanyMemberships, principals } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { ConfigureAgentAuditEvidenceSchema } from '../modules/actions/configure-agent.action.ts';
import { IdentityPersistenceUnavailableError, IdentityTargetInvalidError } from './principal-management-errors.ts';

export const ManagedApiKeyScopeSchema = Schema.Literals(['company-agent', 'tenant-managed']);
export type ManagedApiKeyScope = typeof ManagedApiKeyScopeSchema.Type;
const invalid = (reason: string) => new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'Managed API key eligibility is unavailable',
    }),
    'cause',
    { value: cause },
  );

/** Eligibility, not authorization: the native Action/Read checks SpiceDB before entering this transaction. */
export const validateManagedApiKeyTarget = Effect.fn('ManagedApiKeyScope.validateTarget')(function* validateTarget(
  transaction: Pick<ScopedTransactionExecutor, 'select'>,
  input: {
    readonly authBindingId?: string;
    readonly legalEntityId: string | undefined;
    readonly principalId: string;
    readonly requireActive?: boolean;
    readonly scope: ManagedApiKeyScope;
    readonly tenantId: string;
  },
) {
  const [target] = yield* transaction
    .select({ kind: principals.kind, status: principals.status })
    .from(principals)
    .where(and(eq(principals.tenantId, input.tenantId), eq(principals.principalId, input.principalId)))
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (target === undefined || (input.requireActive !== false && target.status !== 'active')) {
    return yield* invalid('The key target must be an eligible active principal');
  }
  if (input.scope === 'tenant-managed') {
    if (target.kind !== 'service' && target.kind !== 'integration') {
      return yield* invalid('Tenant-managed keys require a service or integration principal');
    }
    return yield* Effect.void;
  }
  const { legalEntityId } = input;
  if (legalEntityId === undefined || target.kind !== 'agent') {
    return yield* invalid('Agent keys require the exact trusted company and an agent principal');
  }
  const [membership] = yield* transaction
    .select({ affiliation: principalCompanyMemberships.affiliation, status: principalCompanyMemberships.status })
    .from(principalCompanyMemberships)
    .where(
      and(
        eq(principalCompanyMemberships.tenantId, input.tenantId),
        eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        eq(principalCompanyMemberships.principalId, input.principalId),
      ),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (membership?.status !== 'active' || membership.affiliation !== null) {
    return yield* invalid('The agent must have an active membership of this exact company');
  }
  const [profile] = yield* transaction
    .select({ evidence: auditEvents.evidenceJson })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, input.tenantId),
        eq(auditEvents.legalEntityId, legalEntityId),
        eq(auditEvents.eventType, 'action.executed'),
        eq(auditEvents.outcome, 'succeeded'),
        sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.configure-agent'`,
        sql`${auditEvents.evidenceJson}->>'targetPrincipalId' = ${input.principalId}`,
      ),
    )
    .orderBy(
      sql`(${auditEvents.evidenceJson}->>'revision')::integer desc`,
      desc(auditEvents.occurredAt),
      desc(auditEvents.auditEventId),
    )
    .limit(1)
    .pipe(Effect.mapError(unavailable));
  if (profile === undefined) {
    return yield* invalid('An audited agent profile is required before managing its keys');
  }
  const evidence = yield* Schema.decodeUnknownEffect(ConfigureAgentAuditEvidenceSchema)(profile.evidence).pipe(
    Effect.mapError((cause) =>
      Object.defineProperty(invalid('The audited agent profile is invalid'), 'cause', { value: cause }),
    ),
  );
  if (evidence.legalEntityId !== legalEntityId || evidence.targetPrincipalId !== input.principalId) {
    return yield* invalid('The audited agent profile belongs to another company or principal');
  }
  if (input.authBindingId !== undefined) {
    const [owned] = yield* transaction
      .select({ id: principalAuthBindings.principalAuthBindingId })
      .from(principalAuthBindings)
      .innerJoin(
        auditEvents,
        and(
          eq(auditEvents.tenantId, principalAuthBindings.tenantId),
          eq(auditEvents.actionInvocationId, principalAuthBindings.createdByInvocationId),
        ),
      )
      .where(
        and(
          eq(principalAuthBindings.tenantId, input.tenantId),
          eq(principalAuthBindings.principalId, input.principalId),
          eq(principalAuthBindings.principalAuthBindingId, input.authBindingId),
          eq(auditEvents.legalEntityId, legalEntityId),
          eq(auditEvents.eventType, 'action.executed'),
          eq(auditEvents.outcome, 'succeeded'),
          sql`${auditEvents.evidenceJson}->>'actionKey' = 'core.identity.bind-managed-api-key'`,
        ),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (owned === undefined) {
      return yield* invalid('The agent key was not issued through this company’s native Action');
    }
  }
  return yield* Effect.void;
});
