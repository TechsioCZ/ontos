import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { DateTime, Effect, Match, Option, Schema } from 'effect';

import { stableUuid } from '../access/catalog/stable-id.ts';
import { AccessScopeIdSchema, PrincipalIdSchema, TenantIdSchema } from '../access/ids.ts';
import {
  AccessMembershipIdSchema,
  decodeMembershipRow,
  membershipColumns,
  writeAccessMembershipsFromTransaction,
} from '../access/intent/memberships.ts';
import { membershipIsLive, planMembershipGrant } from '../access/lifecycle/people-commands.ts';
import {
  accessMemberships,
  accessScopes,
  actionInvocations,
  applicationCompositionAuthority,
  auditEvents,
  domainEvents,
  legalEntities,
  outboxMessages,
  personInvitations,
  principalAuthBindings,
  principalCompanyMemberships,
} from '../db/schema.ts';
import type { CoreTransaction } from '../db/types.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import { outboxProducerModuleKey, outboxTopic } from '../outbox/core-identity-principal-lifecycle-changed-v1.ts';
import { companyMembershipManagementFromTransaction } from './company-membership-management.ts';
import { InvitePersonAuditEvidenceSchema } from './person-invitation.ts';
import { IdentityTargetInvalidError } from './principal-management-errors.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';

const invalid = (reason: string, cause?: unknown) => {
  const failure = new IdentityTargetInvalidError({ code: 'identity_target_invalid', reason });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
};

const issuedInvitationEvidence = Schema.Struct({
  ...InvitePersonAuditEvidenceSchema.fields,
  actionKey: Schema.Literal('core.identity.invite-person'),
});

/**
 * Acceptance admits only participation in the tenant and the invited company. Organisation
 * membership is not an alternative projection source: these are canonical access-intent rows,
 * planned by the membership lifecycle and committed with native token consumption. The original
 * invitation Action attributes the admission; acceptance audit retains the consuming person.
 */
const admitInvitationMemberships = Effect.fn('PersonInvitation.admitMemberships')(function* admitMemberships(
  transaction: Pick<CoreTransaction, 'insert' | 'select'>,
  invitation: {
    readonly invitationId: string;
    readonly legalEntityId: string;
    readonly principalId: string;
    readonly tenantId: string;
  },
  actorPrincipalId: string,
  at: Date,
) {
  const { legalEntityId, principalId, tenantId } = invitation;
  const scopes = yield* transaction
    .select({
      legalEntityId: accessScopes.legalEntityId,
      scopeId: accessScopes.scopeId,
      tenantContextId: accessScopes.tenantContextId,
    })
    .from(accessScopes)
    .where(
      and(
        eq(accessScopes.tenantId, tenantId),
        or(eq(accessScopes.tenantContextId, tenantId), eq(accessScopes.legalEntityId, legalEntityId)),
      ),
    );
  const tenantScope = scopes.find((scope) => scope.tenantContextId === tenantId && scope.legalEntityId === null);
  const companyScope = scopes.find((scope) => scope.legalEntityId === legalEntityId && scope.tenantContextId === null);
  if (scopes.length !== 2 || tenantScope === undefined || companyScope === undefined) {
    return yield* invalid('Invitation acceptance requires the existing tenant and exact company access scopes');
  }
  const tenantScopeId = AccessScopeIdSchema.make(tenantScope.scopeId);
  const companyScopeId = AccessScopeIdSchema.make(companyScope.scopeId);
  const rows = yield* transaction
    .select(membershipColumns)
    .from(accessMemberships)
    .where(
      and(
        eq(accessMemberships.tenantId, tenantId),
        eq(accessMemberships.principalId, principalId),
        eq(accessMemberships.kind, 'member'),
        inArray(accessMemberships.scopeId, [tenantScopeId, companyScopeId]),
      ),
    )
    .for('update');
  const memberships = yield* Effect.forEach(rows, decodeMembershipRow, { concurrency: 1 });
  const additions = yield* Effect.forEach(
    [tenantScopeId, companyScopeId],
    Effect.fn(function* planScopeAdmission(scopeId) {
      const existing = memberships.filter((membership) => membership.scopeId === scopeId);
      if (existing.length !== 0) {
        // A pending invitation is never an escape from suspension, departure or a prior deadline.
        // Preserve an existing live row, including its end date, rather than widening it.
        const [current] = existing;
        if (existing.length !== 1 || current === undefined || !membershipIsLive(current, at)) {
          return yield* invalid('Invitation acceptance cannot revive or widen an existing access membership');
        }
        return [];
      }
      const plan = yield* planMembershipGrant({
        actor: PrincipalIdSchema.make(actorPrincipalId),
        administration: { scopeAdministrators: [], tenantOwners: [], tenantScopeId },
        at,
        holder: { _tag: 'Principal', principalId: PrincipalIdSchema.make(principalId) },
        kind: 'member',
        membershipId: AccessMembershipIdSchema.make(
          stableUuid(`ontos.person-invitation.membership:${invitation.invitationId}:${scopeId}`),
        ),
        memberships,
        scopeId,
        tenantId: TenantIdSchema.make(tenantId),
      });
      return yield* Effect.forEach(
        plan.writes,
        (write) =>
          Match.value(write).pipe(
            Match.tag('RecordMembership', ({ membership }) => Effect.succeed(membership)),
            Match.orElse(() => Effect.fail(invalid('Invitation acceptance may only record participation'))),
          ),
        { concurrency: 1 },
      );
    }),
    { concurrency: 1 },
  );
  return yield* writeAccessMembershipsFromTransaction(transaction, additions.flat());
});

/** Only the native provider's transaction-local successful token consumer calls this owner capability. */
export const acceptPersonInvitationFromTransaction = Effect.fn('PersonInvitation.acceptFromTransaction')(
  function* acceptPersonInvitationFromTransaction(
    transaction: Pick<CoreTransaction, 'execute' | 'insert' | 'select' | 'update'>,
    consumed: { readonly expiresAt: Date; readonly providerSubjectId: string; readonly verificationId: string },
  ) {
    const candidates = yield* transaction
      .select({
        authBindingId: principalAuthBindings.principalAuthBindingId,
        legalEntityId: legalEntities.legalEntityId,
        originatorInvocationId: principalAuthBindings.createdByInvocationId,
        principalId: principalAuthBindings.principalId,
        tenantId: principalAuthBindings.tenantId,
      })
      .from(principalAuthBindings)
      .innerJoin(legalEntities, eq(legalEntities.tenantId, principalAuthBindings.tenantId))
      .where(
        and(
          eq(principalAuthBindings.authenticationNamespaceId, STAFF_AUTHENTICATION_NAMESPACE_ID),
          eq(principalAuthBindings.provider, 'better_auth'),
          eq(principalAuthBindings.subjectType, 'user'),
          eq(principalAuthBindings.providerSubjectId, consumed.providerSubjectId),
          eq(principalAuthBindings.status, 'active'),
          isNull(principalAuthBindings.revokedAt),
        ),
      );
    // Invitation rows remain company-RLS protected. Visit only this verified provider subject's candidate scopes;
    // never install a global bypass or infer an invitation from an ordinary login/password reset.
    yield* Effect.forEach(
      candidates,
      Effect.fn(function* acceptCandidate(candidate) {
        const { legalEntityId, principalId, tenantId } = candidate;
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${tenantId}, true), set_config('ontos.legal_entity_id', ${legalEntityId}, true)`,
          'objects',
        );
        const [invitation] = yield* transaction
          .select()
          .from(personInvitations)
          .where(
            and(
              eq(personInvitations.tenantId, tenantId),
              eq(personInvitations.legalEntityId, legalEntityId),
              eq(personInvitations.principalId, principalId),
              eq(personInvitations.providerSubjectId, consumed.providerSubjectId),
              eq(personInvitations.verificationId, consumed.verificationId),
            ),
          );
        if (invitation === undefined) {
          return yield* Effect.void;
        }
        const now = yield* DateTime.nowAsDate;
        if (invitation.expiresAt <= now || consumed.expiresAt <= now) {
          return yield* new IdentityTargetInvalidError({
            code: 'identity_target_invalid',
            reason: 'The invitation has expired',
          });
        }
        const [authority] = yield* transaction
          .select({ revision: applicationCompositionAuthority.revision })
          .from(applicationCompositionAuthority)
          .where(eq(applicationCompositionAuthority.authorityKey, 'active'));
        if (authority === undefined) {
          return yield* new IdentityTargetInvalidError({
            code: 'identity_target_invalid',
            reason: 'Invitation acceptance requires active application authority',
          });
        }
        yield* lockApplicationCompositionAuthority(transaction, authority.revision, 'write');
        const [membership] = yield* transaction
          .select()
          .from(principalCompanyMemberships)
          .where(
            and(
              eq(principalCompanyMemberships.tenantId, tenantId),
              eq(principalCompanyMemberships.legalEntityId, legalEntityId),
              eq(principalCompanyMemberships.principalId, principalId),
            ),
          )
          .for('update');
        // An administrator may have admitted this exact invite already. Never revive a disabled/departed membership.
        if (membership?.status === 'active') {
          return yield* Effect.void;
        }
        if (membership?.status !== 'invited') {
          return yield* new IdentityTargetInvalidError({
            code: 'identity_target_invalid',
            reason: 'The invited company membership is no longer available',
          });
        }
        // The binding was created by the audited invitation Action. Do not guess an inviter from
        // a role, the accepting person, or a later transition of the binding.
        if (candidate.originatorInvocationId === null) {
          return yield* invalid('Invitation acceptance requires its original governed invitation Action');
        }
        const [originator] = yield* transaction
          .select({ evidence: auditEvents.evidenceJson, principalId: actionInvocations.principalId })
          .from(actionInvocations)
          .innerJoin(
            auditEvents,
            and(
              eq(auditEvents.tenantId, actionInvocations.tenantId),
              eq(auditEvents.actionInvocationId, actionInvocations.actionInvocationId),
              eq(auditEvents.legalEntityId, actionInvocations.legalEntityId),
              eq(auditEvents.principalId, actionInvocations.principalId),
              eq(auditEvents.eventType, 'action.executed'),
              eq(auditEvents.outcome, 'succeeded'),
            ),
          )
          .where(
            and(
              eq(actionInvocations.tenantId, tenantId),
              eq(actionInvocations.legalEntityId, legalEntityId),
              eq(actionInvocations.actionInvocationId, candidate.originatorInvocationId),
              eq(actionInvocations.actionKey, 'core.identity.invite-person'),
              eq(actionInvocations.status, 'succeeded'),
              isNotNull(actionInvocations.completedAt),
            ),
          );
        if (originator?.principalId === null || originator?.principalId === undefined) {
          return yield* invalid('Invitation acceptance requires its original governed invitation actor');
        }
        const issued = yield* Schema.decodeUnknownEffect(issuedInvitationEvidence)(originator.evidence).pipe(
          Effect.mapError((cause) => invalid('The original invitation Action evidence is incomplete', cause)),
        );
        if (
          issued.invitationId !== invitation.invitationId ||
          issued.legalEntityId !== legalEntityId ||
          issued.principalRef.tenantId !== tenantId ||
          issued.principalRef.principalId !== principalId ||
          issued.affiliation !== membership.affiliation
        ) {
          return yield* invalid('The original invitation Action does not attest this exact invited membership');
        }
        yield* admitInvitationMemberships(transaction, invitation, originator.principalId, now);
        const saved = yield* companyMembershipManagementFromTransaction({
          insert: transaction.insert.bind(transaction),
          scope: { legalEntityId, tenantId },
          select: transaction.select.bind(transaction),
          update: transaction.update.bind(transaction),
        }).set({
          affiliation: Option.fromNullishOr(membership.affiliation),
          expectedRevision: membership.revision,
          principalRef: { principalId, tenantId },
          status: 'active',
        });
        yield* transaction.insert(auditEvents).values({
          auditProfile: 'sensitive',
          authBindingId: candidate.authBindingId,
          authContextRef: `person-invitation:${invitation.invitationId}`,
          authMethod: 'invitation',
          eventType: 'auth.invitation.accepted',
          evidenceJson: {
            invitationId: invitation.invitationId,
            invitedBy: originator.principalId,
            membershipRevision: saved.revision,
            membershipStatus: saved.status,
          },
          legalEntityId,
          outcome: 'succeeded',
          outcomeCode: 'invitation_accepted',
          outcomeStage: 'authn',
          principalId,
          targetModuleKey: outboxProducerModuleKey,
          targetResourceId: principalId,
          targetResourceType: 'principal',
          tenantId,
        });
        const payloadJson = { data: { principalId } };
        const [event] = yield* transaction
          .insert(domainEvents)
          .values({
            actionInvocationId: candidate.originatorInvocationId,
            eventType: outboxTopic,
            legalEntityId,
            payloadJson,
            producerModuleKey: outboxProducerModuleKey,
            subjectModuleKey: outboxProducerModuleKey,
            subjectResourceId: principalId,
            subjectResourceType: 'principal',
            tenantId,
          })
          .returning({ domainEventId: domainEvents.domainEventId });
        if (event === undefined) {
          return yield* new IdentityTargetInvalidError({
            code: 'identity_target_invalid',
            reason: 'Invitation acceptance could not schedule admission',
          });
        }
        // Existing lifecycle worker reloads the latest SQL state and projects admission only, never roles.
        yield* transaction
          .insert(outboxMessages)
          .values({ ...event, payloadJson, producerModuleKey: outboxProducerModuleKey, tenantId, topic: outboxTopic });
        return yield* Effect.void;
      }),
      { concurrency: 1, discard: true },
    );
  },
);
