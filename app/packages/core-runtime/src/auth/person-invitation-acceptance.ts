import { and, eq, isNull, sql } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';

import {
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
import { IdentityTargetInvalidError } from './principal-management-errors.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';

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
