import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Option } from 'effect';
import type { Crypto } from 'effect';

import { legalEntities, personInvitations, principalAuthBindings, principals, tenants } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { companyMembershipManagementFromTransaction } from './company-membership-management.ts';
import type { PersonInvitationIdentityInput } from './person-invitation-identity-provider.ts';
import type { InvitePersonPayload, InvitePersonResult } from './person-invitation.ts';
import { IdentityPersistenceUnavailableError, IdentityTargetInvalidError } from './principal-management-errors.ts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from './staff-authentication-namespace.ts';

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new IdentityPersistenceUnavailableError({
      code: 'identity_persistence_unavailable',
      reason: 'The person invitation could not be persisted',
    }),
    'cause',
    { value: cause },
  );
const invalid = () =>
  new IdentityTargetInvalidError({
    code: 'identity_target_invalid',
    reason: 'A person can only be invited into an active trusted company of an active tenant',
  });

/** Core rows and the provider writer are bound to the same owning Action transaction. */
export const personInvitationManagementFromTransaction = (
  transaction: ScopedTransactionExecutor,
  crypto: Crypto.Crypto,
) => ({
  create: Effect.fn('PersonInvitationManagement.create')(function* create(
    input: InvitePersonPayload,
    actionInvocationId: string,
  ) {
    const { legalEntityId, tenantId } = transaction.scope;
    if (legalEntityId === undefined) {
      return yield* invalid();
    }
    const [company] = yield* transaction
      .select({
        companyStatus: legalEntities.status,
        tenantStatus: tenants.status,
      })
      .from(legalEntities)
      .innerJoin(tenants, eq(tenants.tenantId, legalEntities.tenantId))
      .where(and(eq(legalEntities.tenantId, tenantId), eq(legalEntities.legalEntityId, legalEntityId)))
      .pipe(Effect.mapError(unavailable));
    if (company?.companyStatus !== 'active' || company.tenantStatus !== 'active') {
      return yield* invalid();
    }
    const identities = yield* Effect.all(
      {
        invitationId: crypto.randomUUIDv4(),
        principalId: crypto.randomUUIDv4(),
        providerSubjectId: crypto.randomUUIDv4(),
        verificationId: crypto.randomUUIDv4(),
      },
      { concurrency: 1 },
    ).pipe(Effect.mapError(unavailable));
    const instant = yield* DateTime.now;
    const now = DateTime.toDateUtc(instant);
    const expiresAt = DateTime.toDateUtc(DateTime.add(instant, { hours: 24 }));
    const principalRef = { principalId: identities.principalId, tenantId };
    yield* transaction
      .insert(principals)
      .values({
        displayName: input.displayName,
        kind: 'human',
        principalId: identities.principalId,
        status: 'active',
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    yield* transaction
      .insert(principalAuthBindings)
      .values({
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        createdByInvocationId: actionInvocationId,
        lastTransitionRef: actionInvocationId,
        principalId: identities.principalId,
        provider: 'better_auth',
        providerSubjectId: identities.providerSubjectId,
        status: 'active',
        subjectType: 'user',
        tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    const membership = yield* companyMembershipManagementFromTransaction(transaction).set({
      affiliation: Option.some(input.affiliation),
      expectedRevision: 0,
      principalRef,
      status: 'invited',
    });
    yield* transaction
      .insert(personInvitations)
      .values({
        createdAt: now,
        expiresAt,
        invitationId: identities.invitationId,
        legalEntityId,
        principalId: identities.principalId,
        providerSubjectId: identities.providerSubjectId,
        tenantId,
        verificationId: identities.verificationId,
      })
      .pipe(Effect.mapError(unavailable));
    return {
      identity: {
        displayName: input.displayName,
        email: input.email.toLowerCase(),
        expiresAt,
        providerSubjectId: identities.providerSubjectId,
        verificationId: identities.verificationId,
      } satisfies PersonInvitationIdentityInput,
      result: {
        delivery: 'pending',
        invitationId: identities.invitationId,
        membership,
        principalRef,
      } satisfies InvitePersonResult,
    };
  }),
});
