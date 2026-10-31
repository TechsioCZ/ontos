import {
  makePartyReconciliationGateway,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';
import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Predicate, Redacted, Result } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { endContactPointAction } from '../../src/actions/end-contact-point.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { resolveDuplicateCandidateMatchAction } from '../../src/actions/resolve-duplicate-candidate-match.action.ts';
import { guestPartyResolutionRead } from '../../src/api/guest-party-resolution.read.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { duplicateCandidateCases, parties, partyContactPoints, partyMatchDecisions } from '../../src/db/schema.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

const nativeGuestEvidenceAuthority = Effect.fn('GuestEvidenceTest.nativeGuestEvidenceAuthority')(
  function* nativeGuestEvidenceAuthority() {
    const snapshot = yield* makeApplicationCompositionSnapshotFixture(
      ['party-registry'],
      ultramodernApiMarker.buildMarker,
    );
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: snapshot,
      mode: 'schema-only',
      purpose: 'stabilization-1241-guest-evidence',
    });
    yield* isolated.assertClonedSchema();
    const native = yield* preparePartyReconciliationNative(isolated.connections);
    const gateway = yield* makePartyReconciliationGateway(native, snapshot);
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionKeys: [
          createPartyAction,
          addContactPointAction,
          endContactPointAction,
          resolveDuplicateCandidateCreateAction,
          resolveDuplicateCandidateMatchAction,
        ].map(({ descriptor }) => descriptor.actionKey),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: snapshot.composition.revision,
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        // The Party request role installs scope through its gateway grant only as an enrolled identity.
        databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
        runtimeConnectionString: Redacted.make(native.partyConfiguration.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    const context = yield* Layer.build(fixture.layer);
    const runtime = yield* ActionRuntime.pipe(Effect.provideContext(context));
    const reads = yield* ReadRuntime.pipe(Effect.provideContext(context));
    const adminLayer = PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    );
    const adminContext = yield* Layer.build(adminLayer);
    const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
    const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
    const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
    const transport = Effect.gen(function* transport() {
      return { correlationId: yield* nextId, idempotencyKey: yield* nextId, targetModuleKey: 'party.registry' };
    });
    const sourceSubject = yield* nextId;
    const candidate = {
      displayName: 'Observed Guest person',
      evidenceRefs: ['person-observation'],
      officialIdentifiers: [],
      partyType: 'PERSON',
      provenance: { method: 'DIRECT_INTERACTION', source: 'guest-evidence-native' },
      subjectEvidence: [
        {
          basis: 'DIRECT_INTERACTION',
          evidenceRef: 'person-observation',
          kind: 'ACTOR_ATTESTATION',
          observedSubject: 'PERSON',
          statement: 'Met this concrete human',
          subjectKey: sourceSubject,
        },
      ],
      validFrom: '2020-01-01T00:00:00.000Z',
    };
    const seedCase = yield* runtime
      .runAction({
        registration: createPartyAction,
        payload: { candidate },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    assert.isOk(seedCase.outcome === 'AMBIGUOUS');
    const seeded = yield* runtime
      .runAction({
        registration: resolveDuplicateCandidateCreateAction,
        payload: {
          caseRef: seedCase.caseRef,
          expectedRevision: 1,
          reason: 'Reviewed one concrete human without a strong identifier',
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    assert.isOk(seeded.partyRef !== null);
    const { partyRef } = seeded;
    const evidenceRef = `guest-evidence-${yield* nextId}`;
    const correlationRoot = `purchase-${yield* nextId}`;
    const legalEntityRef = {
      moduleId: 'core.identity' as const,
      resourceId: fixture.legalEntityId,
      resourceType: 'core.identity.legal-entity' as const,
      tenantId: fixture.tenantId,
    };
    const contactPayload = {
      contactPoint: { preferred: false, type: 'EMAIL', value: 'guest-1241@example.test' },
      partyRef,
      privacyClassification: 'PERSONAL',
      provenance: {
        authoritative: false,
        evidenceReference: evidenceRef,
        method: 'MANUAL_CONFIRMATION',
        source: 'USER_ASSERTION',
      },
      validFrom: '2020-01-01T00:00:00.000Z',
      verification: { state: 'UNVERIFIED' },
    };
    const contact = yield* runtime
      .runAction({
        registration: addContactPointAction,
        payload: contactPayload,
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    const [storedContact] = yield* admin
      .select()
      .from(partyContactPoints)
      .where(
        and(
          eq(partyContactPoints.tenantId, fixture.tenantId),
          eq(partyContactPoints.contactPointId, contact.contactPointRef.resourceId),
        ),
      );
    expect(storedContact).toMatchObject({
      provenanceAuthoritative: false,
      verificationState: 'UNVERIFIED',
      evidenceReference: evidenceRef,
      state: 'ACTIVE',
    });
    const resolve = (root = correlationRoot, ref = evidenceRef) =>
      Effect.gen(function* resolveGuest() {
        const partiesBefore = yield* admin
          .select()
          .from(parties)
          .where(eq(parties.tenantId, fixture.tenantId))
          .orderBy(parties.partyId);
        const result = yield* reads
          .runRead({
            registration: guestPartyResolutionRead,
            input: {
              correlationRoot: root,
              guestEvidenceRef: ref,
              legalEntityRef,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
            },
            principal: yield* gateway.verifyPrincipal(principal),
            transport: { correlationId: yield* nextId },
          })
          .pipe(Effect.provideContext(context));
        expect(
          yield* admin.select().from(parties).where(eq(parties.tenantId, fixture.tenantId)).orderBy(parties.partyId),
        ).toEqual(partiesBefore);
        return result;
      });
    expect((yield* resolve()).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
    expect((yield* resolve(correlationRoot, 'missing-proof')).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
    yield* runtime
      .runAction({
        registration: addContactPointAction,
        payload: {
          ...contactPayload,
          contactPoint: { preferred: false, type: 'EMAIL', value: 'verified-guest-1241@example.test' },
          provenance: { ...contactPayload.provenance, authoritative: true },
          verification: {
            state: 'VERIFIED',
            method: 'MANUAL_CONFIRMATION',
            verifiedAt: DateTime.formatIso(yield* DateTime.now),
            verifierReference: 'reviewed-channel-control',
          },
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    expect((yield* resolve()).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');

    const bound = {
      ...candidate,
      evidenceRefs: [evidenceRef],
      subjectEvidence: candidate.subjectEvidence.map((item) => ({
        ...item,
        evidenceRef,
        guestBinding: { correlationRoot, legalEntityRef },
      })),
    };
    const opened = yield* runtime
      .runAction({
        registration: createPartyAction,
        payload: { candidate: bound },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    assert.isOk(opened.outcome === 'AMBIGUOUS');
    expect((yield* resolve()).outcome).toBe('AMBIGUOUS_MATCH');
    const before = yield* fixture.evidence(coreEvidenceExecutor);
    const reviewTransport = yield* transport;
    fixture.faultNextTransaction('rollback');
    const failed = yield* runtime
      .runAction({
        registration: resolveDuplicateCandidateMatchAction,
        payload: {
          caseRef: opened.caseRef,
          selectedPartyRef: partyRef,
          expectedRevision: 1,
          reason: 'Explicitly reviewed this Guest and canonical person',
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: reviewTransport,
      })
      .pipe(Effect.provideContext(context), Effect.result);
    expect(Result.isFailure(failed)).toBe(true);
    expect((yield* fixture.evidence(coreEvidenceExecutor)).events).toEqual(before.events);
    expect((yield* resolve()).outcome).toBe('AMBIGUOUS_MATCH');
    const reviewed = yield* runtime
      .runAction({
        registration: resolveDuplicateCandidateMatchAction,
        payload: {
          caseRef: opened.caseRef,
          selectedPartyRef: partyRef,
          expectedRevision: 1,
          reason: 'Explicitly reviewed this Guest and canonical person',
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: reviewTransport,
      })
      .pipe(Effect.provideContext(context));
    expect(reviewed.partyRef).toEqual(partyRef);
    expect(yield* resolve()).toEqual({ outcome: 'EXISTING_PARTY_RESOLVED', partyRef });
    expect((yield* resolve('different-purchase')).outcome).not.toBe('EXISTING_PARTY_RESOLVED');
    const [decision] = yield* admin
      .select()
      .from(partyMatchDecisions)
      .where(eq(partyMatchDecisions.matchDecisionId, reviewed.decisionRef?.resourceId ?? ''));
    const [review] = yield* admin
      .select()
      .from(duplicateCandidateCases)
      .where(eq(duplicateCandidateCases.candidateCaseId, opened.caseRef.resourceId));
    assert.isOk(decision && review);
    expect(decision.operation).toBe('REVIEW_MATCH');
    expect(decision.evidenceEvaluation?.evidence).toEqual(bound.subjectEvidence);
    expect(review.candidateSnapshot.subjectEvidence).toEqual(bound.subjectEvidence);
    expect(review.resolutionActionInvocationId).toBe(decision.actionInvocationId);
    expect(
      (yield* fixture.evidence(coreEvidenceExecutor)).invocations.find(
        ({ actionInvocationId }) => actionInvocationId === decision.actionInvocationId,
      )?.status,
    ).toBe('succeeded');
    const replay = yield* runtime
      .runAction({
        registration: resolveDuplicateCandidateMatchAction,
        payload: {
          caseRef: opened.caseRef,
          selectedPartyRef: partyRef,
          expectedRevision: 1,
          reason: 'Explicitly reviewed this Guest and canonical person',
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: reviewTransport,
      })
      .pipe(Effect.provideContext(context), Effect.flip);
    expect(Predicate.isTagged(replay, 'ActionAlreadyCommitted')).toBe(true);
    const end = yield* DateTime.now;
    yield* runtime
      .runAction({
        registration: endContactPointAction,
        payload: {
          contactPointRef: contact.contactPointRef,
          effectiveEnd: DateTime.formatIso(end),
          provenance: contactPayload.provenance,
          reason: 'Contact channel no longer current',
          target: { type: 'WHOLE_CONTACT_POINT' },
        },
        principal: yield* gateway.verifyPrincipal(principal),
        transport: yield* transport,
      })
      .pipe(Effect.provideContext(context));
    // Ending contactability cannot manufacture or erase the separate retained reviewed identity.
    expect(yield* resolve()).toEqual({ outcome: 'EXISTING_PARTY_RESOLVED', partyRef });
    expect(
      Result.isFailure(
        yield* reads
          .runRead({
            registration: guestPartyResolutionRead,
            input: {
              correlationRoot,
              guestEvidenceRef: evidenceRef,
              legalEntityRef,
              requestedAt: DateTime.formatIso(yield* DateTime.now),
            },
            principal: yield* gateway.verifyPrincipal({
              ...fixture.legalEntityOnly,
              legalEntityId: fixture.legalEntityId,
            }),
            transport: { correlationId: yield* nextId },
          })
          .pipe(Effect.provideContext(context), Effect.result),
      ),
    ).toBe(true);
    expect(
      yield* admin
        .select()
        .from(partyMatchDecisions)
        .where(eq(partyMatchDecisions.matchDecisionId, decision.matchDecisionId)),
    ).toEqual([decision]);
  },
);

it.layer(services, { excludeTestServices: true })((testIt) => {
  testIt.effect(
    'native owner decisions preserve exact Guest subject authority and weak contact evidence remains insufficient',
    nativeGuestEvidenceAuthority,
  );
});
