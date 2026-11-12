import { TrustedPrincipalContextSchema, trustVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { refuseInsideDatabaseTransaction } from '../../../../packages/core-runtime/src/db/transaction-io-guard.ts';
import { privacySubjectsRead } from '../../src/api/privacy-subjects.read.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { PrivacySubjectPartyOwner } from '../../src/persistence/privacy-subject-party-owner.ts';
import { PrivacySubjectOwnerEvidenceSchema, PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { privacyRegistration } from '../../vertical.registration.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000004';
const compositionRevision = 'b'.repeat(64);
const now = DateTime.makeUnsafe('2026-11-09T12:00:00.000Z');
const identity = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '20000000-0000-4000-8000-000000000003',
  authContextRef: 'privacy-subjects-owner-phase',
  authMethod: 'session',
  legalEntityId,
  principalId: '20000000-0000-4000-8000-000000000002',
  tenantId,
});
const principal = trustVerifiedGatewayPrincipalContext(identity, compositionRevision);
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000007',
  resourceType: 'party.registry.party',
  tenantId,
};
const person = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
  createdAt: DateTime.formatIso(now),
  subject: { kind: 'DATA_SUBJECT', partyRef },
  subjectRef: {
    moduleId: 'privacy.core',
    resourceId: '20000000-0000-4000-8000-000000000006',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  updatedAt: DateTime.formatIso(now),
});
const anonymous = Schema.decodeUnknownSync(PrivacySubjectRecordSchema)({
  createdAt: DateTime.formatIso(now),
  subject: {
    anonymousContext: {
      addressability: 'SESSION',
      contextRef: 'session:anonymous-owner-phase',
      createdAt: DateTime.formatIso(now),
      expiresAt: '2027-11-09T12:00:00.000Z',
      kind: 'ANONYMOUS_PRIVACY_CONTEXT',
      provenance: { method: 'SESSION', source: 'owner-phase-test' },
    },
    kind: 'ANONYMOUS',
  },
  subjectRef: {
    moduleId: 'privacy.core',
    resourceId: '20000000-0000-4000-8000-000000000008',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  updatedAt: DateTime.formatIso(now),
});
const ownerEvidence = Schema.decodeUnknownSync(PrivacySubjectOwnerEvidenceSchema)({
  observedAt: DateTime.formatIso(now),
  ownerRevision: 1,
  partyRef,
  typeAssertions: [{ assertionId: 'owner-phase:person', validFrom: DateTime.formatIso(now), validTo: null }],
});

const ownerPhase = Effect.fn('PrivacySubjectsRead.ownerPhaseTest')(function* ownerPhase() {
  const harness = yield* makeReadTestHarness({
    access: 'allowed',
    compositionRevision,
    executeOwnerQuery: ({ scope, sql }) => {
      if (scope.tenantId !== tenantId || scope.legalEntityId !== legalEntityId) {
        return Effect.succeed([]);
      }
      if (sql.includes('privacy_subjects')) {
        return Effect.succeed(
          [person, anonymous].map((record) => ({ record: Schema.encodeSync(PrivacySubjectRecordSchema)(record) })),
        );
      }
      if (sql.includes('privacy_representations')) {
        return Effect.succeed([]);
      }
      return Effect.die(`Unexpected Privacy Subject owner SQL: ${sql}`);
    },
    operationTime: DateTime.toDateUtc(now),
    ownerAuthorizationDecision: 'allowed',
    ownerRegistration: privacyRegistration,
    scope: { ...principal, correlationId: 'privacy-subjects-owner-phase' },
  });
  const ownerCalls: { readonly compositionRevision: string | undefined; readonly partyRef: unknown }[] = [];
  const run = (subjectRefs: readonly (typeof person.subjectRef)[], personAnswered: boolean) =>
    harness.runtime
      .runRead({
        input: { subjectRefs },
        principal,
        registration: privacySubjectsRead,
        transport: { correlationId: 'privacy-subjects-owner-phase' },
      })
      .pipe(
        Effect.provideService(
          PrivacySubjectPartyOwner,
          PrivacySubjectPartyOwner.of({
            resolve: (requested, scope, canonicalWrite, _sourceReference, _requirement, revision) =>
              // The real Party owner is an outbound fetch; the Core guard refuses it inside the read transaction.
              refuseInsideDatabaseTransaction('outbound-fetch', 'party-registry-api/reads/party-detail').pipe(
                Effect.andThen(() => {
                  expect(harness.snapshot().statements.at(-1)).toBe('COMMIT');
                  expect(scope).toMatchObject({ legalEntityId, principalId: identity.principalId, tenantId });
                  expect(canonicalWrite).toBe(false);
                  ownerCalls.push({ compositionRevision: revision, partyRef: requested });
                  return personAnswered
                    ? Effect.succeed(ownerEvidence)
                    : Effect.fail(
                        new PrivacyOperationPersistenceError({
                          code: 'privacy_operation_persistence_unavailable',
                          reason: 'Authoritative current PERSON Party evidence is unavailable',
                        }),
                      );
                }),
              ),
          }),
        ),
      );

  const verified = yield* run([person.subjectRef], true);
  expect(verified.items).toEqual([person]);
  expect(ownerCalls).toEqual([{ compositionRevision, partyRef }]);

  // An exact Anonymous context read needs no Party owner answer.
  const anonymousOnly = yield* run([anonymous.subjectRef], false);
  expect(anonymousOnly.items).toEqual([anonymous]);
  expect(ownerCalls).toHaveLength(1);

  // A selected person whose owner answer is unavailable stays unavailable; nothing fails open.
  const refused = yield* run([person.subjectRef], false).pipe(Effect.flip);
  expect(refused).toMatchObject({ _tag: 'ReadHandlerUnavailable', code: 'read_handler_unavailable' });
  expect(ownerCalls).toHaveLength(2);

  // A foreign-Tenant reference selects nothing and asks the owner nothing.
  const foreign = yield* run([{ ...person.subjectRef, tenantId: '20000000-0000-4000-8000-000000000099' }], true);
  expect(foreign.items).toEqual([]);
  expect(ownerCalls).toHaveLength(2);
});

it.layer(NodeCrypto.layer)('Privacy Subjects read owner phase', (suite) => {
  suite.effect('verifies the committed person snapshot with the Party owner outside the read transaction', () =>
    ownerPhase(),
  );
});
