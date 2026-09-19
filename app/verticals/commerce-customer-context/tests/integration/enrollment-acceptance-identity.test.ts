import { randomUUID } from 'node:crypto';

import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ReservePrincipalBindingPayloadSchema } from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { EnrollmentCommitResolutionCommittedSchema } from '../../src/enrollment/commit-resolution/commit-resolution-contracts.ts';
import { EnrollmentActionInvocationIdSchema } from '../../shared/enrollment-contracts.ts';
import {
  activateBinding,
  admitSession,
  changeBindingStatus,
  committedInvocationId,
  countBindings,
  countPrincipals,
  identityReadFor,
  makeAccountSubject,
  makeEnrollmentAcceptanceIdentityFixture,
  readBindingRow,
  reserveBinding,
  runActivation,
  runReservation,
  sessionPrincipal,
} from '../support/enrollment-acceptance-identity-fixture.ts';

const invocation = (value: string) => Schema.decodeSync(EnrollmentActionInvocationIdSchema)(value);

it.live('T10: a second subject can never be reserved onto an existing Principal', () =>
  Effect.scoped(
    Effect.gen(function* twoSubjectsNeverShareAPrincipal() {
      const fixture = yield* makeEnrollmentAcceptanceIdentityFixture();
      const first = makeAccountSubject();
      const second = makeAccountSubject();
      const sharedEmail = `shared-${randomUUID()}@example.test`;

      const firstReserved = yield* reserveBinding(fixture, first, sharedEmail);
      expect(firstReserved.outcome).toBe('RESERVED');

      // The reservation payload is the only way into Core from the enrollment path, and it carries
      // no target Principal: a caller naming one is refused before any row is touched.
      const targeted = yield* Schema.decodeUnknownEffect(ReservePrincipalBindingPayloadSchema)({
        authenticationNamespaceId: second.authenticationNamespaceId,
        principalId: firstReserved.principalId,
        providerSubjectId: second.providerSubjectId,
        subjectType: second.subjectType,
      }).pipe(Effect.flip);
      expect(Predicate.isTagged(targeted, 'SchemaError')).toBe(true);

      const secondReserved = yield* reserveBinding(fixture, second, sharedEmail);
      expect(secondReserved.outcome).toBe('RESERVED');
      expect(secondReserved.principalId).not.toBe(firstReserved.principalId);
      expect(secondReserved.authBindingId).not.toBe(firstReserved.authBindingId);

      // Re-reserving either subject converges on that subject's own pair, never the other's.
      const firstAgain = yield* reserveBinding(fixture, first, sharedEmail);
      expect(firstAgain.outcome).toBe('EXISTING');
      expect(firstAgain.principalId).toBe(firstReserved.principalId);

      const bindings = yield* countBindings(fixture);
      expect(bindings).toHaveLength(2);
      expect(new Set(bindings.map(({ principalId }) => principalId)).size).toBe(2);
    }),
  ),
);

it.live('T11: a pending, disabled or revoked binding presented at admission is a typed denial', () =>
  Effect.scoped(
    Effect.gen(function* nonCurrentBindingsAreDeniedAtAdmission() {
      const fixture = yield* makeEnrollmentAcceptanceIdentityFixture();
      const subject = makeAccountSubject();
      const reserved = yield* reserveBinding(fixture, subject, 'Non-current admission subject');
      const principal = sessionPrincipal(fixture, reserved.authBindingId, reserved.principalId);

      const pendingDenial = yield* admitSession(fixture, principal).pipe(Effect.flip);
      expect(Predicate.isTagged(pendingDenial, 'OperationAuthenticationRequired')).toBe(true);
      expect(pendingDenial.code).toBe('operation_authentication_required');

      const activated = yield* activateBinding(fixture, reserved.authBindingId, reserved.bindingRevision);
      const admitted = yield* admitSession(fixture, principal);
      expect(admitted.principalId).toBe(reserved.principalId);

      const disabled = yield* changeBindingStatus(
        fixture,
        reserved.authBindingId,
        activated.bindingRevision,
        'disabled',
      );
      const beforeDisabledDenial = yield* readBindingRow(fixture, reserved.authBindingId);
      const disabledDenial = yield* admitSession(fixture, principal).pipe(Effect.flip);
      expect(Predicate.isTagged(disabledDenial, 'OperationAuthenticationRequired')).toBe(true);
      expect(yield* readBindingRow(fixture, reserved.authBindingId)).toStrictEqual(beforeDisabledDenial);

      const revoked = yield* changeBindingStatus(fixture, reserved.authBindingId, disabled.bindingRevision, 'revoked');
      const beforeRevokedDenial = yield* readBindingRow(fixture, reserved.authBindingId);
      expect(beforeRevokedDenial.bindingRevision).toBe(revoked.bindingRevision);
      const revokedDenial = yield* admitSession(fixture, principal).pipe(Effect.flip);
      expect(Predicate.isTagged(revokedDenial, 'OperationAuthenticationRequired')).toBe(true);
      expect(yield* readBindingRow(fixture, reserved.authBindingId)).toStrictEqual(beforeRevokedDenial);
    }),
  ),
);

it.live('T20: the historical commit stays readable while current resolution of a revoked binding denies', () =>
  Effect.scoped(
    Effect.gen(function* historicalCommitOutlivesRevocation() {
      const fixture = yield* makeEnrollmentAcceptanceIdentityFixture();
      const subject = makeAccountSubject();
      const reservationKey = `identity-acceptance-reserve-${randomUUID()}`;
      const activationKey = `identity-acceptance-activate-${randomUUID()}`;

      const reserved = yield* runReservation(fixture, subject, reservationKey);
      expect(reserved.outcome).toBe('RESERVED');
      const reservationInvocation = yield* committedInvocationId(fixture, reservationKey);
      expect(reservationInvocation.status).toBe('succeeded');

      const activated = yield* runActivation(
        fixture,
        subject,
        reserved.authBindingId,
        reserved.bindingRevision,
        activationKey,
      );
      expect(activated.bindingStatus).toBe('active');
      const activationInvocation = yield* committedInvocationId(fixture, activationKey);
      expect(activationInvocation.status).toBe('succeeded');

      const revoked = yield* changeBindingStatus(fixture, reserved.authBindingId, activated.bindingRevision, 'revoked');
      expect(revoked.bindingStatus).toBe('revoked');

      // The committed activation is history and stays history: the runtime still answers that it
      // committed, even though the binding it produced is no longer usable.
      const historical = yield* fixture.runtime
        .resolveActionCommit({ invocationId: activationInvocation.invocationId, principal: fixture.actor })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(historical, 'ActionAlreadyCommitted')).toBe(true);

      // Current resolution of the same enrollment reads Core now, and denies on the revoked binding.
      const denial = yield* fixture.commitResolution
        .resolve({
          identityRead: identityReadFor(subject),
          originalInvocationId: invocation(reservationInvocation.invocationId),
          principal: fixture.actor,
          tenantId: fixture.tenantId,
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(denial, 'CommerceEnrollmentCommitResolutionRevoked')).toBe(true);
      expect(denial.code).toBe('commit_resolution_binding_revoked');

      // Nothing about the denial mutates the durable binding.
      const row = yield* readBindingRow(fixture, reserved.authBindingId);
      expect(row.status).toBe('revoked');
      expect(row.bindingRevision).toBe(revoked.bindingRevision);
    }),
  ),
);

it.live('T23: identifier reuse at the enrollment layer never resurrects or transfers a Principal', () =>
  Effect.scoped(
    Effect.gen(function* identifierReuseAtTheEnrollmentLayer() {
      const fixture = yield* makeEnrollmentAcceptanceIdentityFixture();
      const sharedEmail = `reuse-${randomUUID()}@example.test`;
      const original = makeAccountSubject();
      const replacement = makeAccountSubject();

      const originalKey = `identity-acceptance-reuse-original-${randomUUID()}`;
      const originalReserved = yield* runReservation(fixture, original, originalKey, sharedEmail);
      expect(originalReserved.outcome).toBe('RESERVED');
      const originalInvocation = yield* committedInvocationId(fixture, originalKey);

      // Same email, a new provider subject: a new Attempt gets a new pair, never the old Principal.
      const replacementKey = `identity-acceptance-reuse-replacement-${randomUUID()}`;
      const replacementReserved = yield* runReservation(fixture, replacement, replacementKey, sharedEmail);
      expect(replacementReserved.outcome).toBe('RESERVED');
      expect(replacementReserved.principalId).not.toBe(originalReserved.principalId);
      expect(replacementReserved.authBindingId).not.toBe(originalReserved.authBindingId);

      // Resolution of the original enrollment still converges on the original pair alone.
      const originalResolution = yield* fixture.commitResolution.resolve({
        identityRead: identityReadFor(original),
        originalInvocationId: invocation(originalInvocation.invocationId),
        principal: fixture.actor,
        tenantId: fixture.tenantId,
      });
      expect(Schema.is(EnrollmentCommitResolutionCommittedSchema)(originalResolution)).toBe(true);
      expect(originalResolution).toMatchObject({
        retainedBinding: {
          authBindingId: originalReserved.authBindingId,
          principalId: originalReserved.principalId,
        },
      });

      // The identical provider subject after revocation: EXISTING and revoked, never resurrected.
      const activated = yield* activateBinding(fixture, replacementReserved.authBindingId, 1);
      const revoked = yield* changeBindingStatus(
        fixture,
        replacementReserved.authBindingId,
        activated.bindingRevision,
        'revoked',
      );
      expect(revoked.bindingStatus).toBe('revoked');
      const reused = yield* reserveBinding(fixture, replacement, sharedEmail);
      expect(reused.outcome).toBe('EXISTING');
      expect(reused.bindingStatus).toBe('revoked');
      expect(reused.authBindingId).toBe(replacementReserved.authBindingId);
      expect(reused.principalId).toBe(replacementReserved.principalId);

      const principalRows = yield* countPrincipals(fixture);
      // The two enrolled subjects plus the fixture's own system actor.
      expect(principalRows).toHaveLength(3);
    }),
  ),
);
