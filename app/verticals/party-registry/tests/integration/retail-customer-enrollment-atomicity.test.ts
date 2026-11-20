import { ActionRuntime } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { Crypto, Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import { EnrollRetailCustomerPayloadSchema } from '../../shared/actions/enroll-retail-customer.ts';
import { RetailEnrollmentEvidenceSchema } from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { counterpartyCustomerOnboardAction } from '../../src/actions/counterparty-customer-onboard.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { enrollRetailCustomerAction } from '../../src/actions/enroll-retail-customer.action.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { counterparties, counterpartyRolePeriods, partyContactPoints } from '../../src/db/schema.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import { makePartyDeniedAccess } from '../support/live-access-authority.ts';
import {
  makePartyReconciliationGateway,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const email = 'atomic-retail@example.test';
const phone = '+420777123456';
const validFrom = '2026-01-01T00:00:00.000Z';

const transport = (idempotencyKey: string) => ({
  correlationId: idempotencyKey,
  idempotencyKey,
  targetModuleKey: 'party.registry',
});

/**
 * This fixture isolates SQL/lifecycle atomicity: its gate explicitly admits the request, while
 * the native Action, owner factories, gateway scope, PostgreSQL transaction and Core outbox stay
 * real. The separate production AccessDecision tests prove the CCC/storefront admission carrier.
 */
const makeAtomicityFixture = Effect.fn('RetailEnrollmentAtomicity.fixture')(function* makeAtomicityFixture() {
  const snapshot = yield* makeApplicationCompositionSnapshotFixture(
    ['party-registry'],
    ultramodernApiMarker.buildMarker,
  );
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1267-party-gateway',
  });
  const native = yield* preparePartyReconciliationNative(isolated.connections);
  const gateway = yield* makePartyReconciliationGateway(native, snapshot);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      access: 'allowed',
      actionKeys: [
        createPartyAction,
        enrollRetailCustomerAction,
        counterpartyCustomerOnboardAction,
        addContactPointAction,
      ].map(({ descriptor }) => descriptor.actionKey),
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      bootstrapConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      compositionRevision: snapshot.composition.revision,
      databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      ownerRegistration: partyRegistryBackendRegistration,
      runtimeConnectionString: Redacted.make(native.partyConfiguration.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const context = yield* Layer.build(fixture.layer.pipe(Layer.provide(makePartyDeniedAccess().layer)));
  const runtime = yield* ActionRuntime.pipe(Effect.provideContext(context));
  const adminContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const core = yield* testCoreDatabase.pipe(Effect.provideContext(adminContext));
  const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };

  const subjectId = yield* nextId;
  const candidateEvidenceRef = yield* nextId;
  const originalKey = yield* nextId;
  const created = yield* runtime
    .runAction({
      payload: {
        candidate: {
          evidenceRefs: [candidateEvidenceRef],
          firstName: 'Atomic',
          lastName: 'Retail Customer',
          officialIdentifiers: [],
          partyType: 'PERSON',
          provenance: {
            method: 'commerce.portal-enrollment.self-enrollment',
            source: 'commerce.customer-context',
          },
          subjectEvidence: [
            {
              basis: 'DIRECT_INTERACTION',
              evidenceRef: candidateEvidenceRef,
              kind: 'ACTOR_ATTESTATION',
              observedSubject: 'PERSON',
              statement: 'This exact provider subject requested retail enrollment',
              subjectKey: subjectId,
            },
          ],
          validFrom,
        },
      },
      principal: yield* gateway.verifyPrincipal(principal),
      registration: createPartyAction,
      transport: transport(originalKey),
    })
    .pipe(Effect.provideContext(context));
  assert.isOk(created.outcome === 'CREATED');
  const original = yield* runtime.resolveActionExecution({
    actionKey: createPartyAction.descriptor.actionKey,
    idempotencyKey: originalKey,
    principal: yield* gateway.verifyPrincipal(principal),
  });
  assert.isOk(original.state === 'COMMITTED');
  const evidence = yield* Schema.decodeUnknownEffect(RetailEnrollmentEvidenceSchema)({
    authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
    candidateEvidenceRef,
    emailOwnership: 'VERIFIED',
    enrollmentAttemptId: yield* nextId,
    journey: 'RETAIL_SELF_ENROLLMENT',
    providerOwnerInvocationId: yield* nextId,
    providerSubjectId: subjectId,
    sellingLegalEntityId: fixture.legalEntityId,
    tenantId: fixture.tenantId,
  });
  const payloadOf = (phoneValue: string) =>
    Schema.decodeUnknownEffect(EnrollRetailCustomerPayloadSchema)({
      email,
      evidence,
      originalInvocationId: original.invocationId,
      phone: { preferred: true, type: 'PHONE', value: phoneValue },
    });
  const enroll = Effect.fn('RetailEnrollmentAtomicity.enroll')(function* enroll(key: string, phoneValue: string) {
    return yield* runtime
      .runAction({
        payload: yield* payloadOf(phoneValue),
        principal: yield* gateway.verifyPrincipal(principal),
        registration: enrollRetailCustomerAction,
        transport: transport(key),
      })
      .pipe(Effect.provideContext(context));
  });
  const rows = () =>
    Effect.all({
      contacts: admin
        .select()
        .from(partyContactPoints)
        .where(eq(partyContactPoints.tenantId, fixture.tenantId))
        .orderBy(partyContactPoints.contactPointId),
      counterparties: admin
        .select()
        .from(counterparties)
        .where(eq(counterparties.tenantId, fixture.tenantId))
        .orderBy(counterparties.counterpartyId),
      roles: admin
        .select()
        .from(counterpartyRolePeriods)
        .where(eq(counterpartyRolePeriods.tenantId, fixture.tenantId))
        .orderBy(counterpartyRolePeriods.rolePeriodId),
    });
  return {
    context,
    enroll,
    evidence: () => fixture.evidence(core),
    fixture,
    gateway,
    partyRef: created.partyRef,
    payloadOf,
    principal,
    rows,
    runtime,
    transport,
  };
});

it.layer(services, { excludeTestServices: true })((suite) => {
  suite.effect('native late phone failure rolls back CUSTOMER context, email, domain events and Core outbox', () =>
    Effect.gen(function* lateContactRollback() {
      const fixture = yield* makeAtomicityFixture();
      const beforeRows = yield* fixture.rows();
      expect(beforeRows).toEqual({ contacts: [], counterparties: [], roles: [] });
      const beforeEvidence = yield* fixture.evidence();
      // Accepted by the public command schema, rejected by native phone normalization only
      // after onboarding and the email handler have executed inside this same owner transaction.
      yield* fixture.payloadOf('+4201');
      const failure = yield* fixture.enroll(yield* nextId, '+4201').pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'PartyContactPointInvalid')).toBe(true);
      expect(yield* fixture.rows()).toEqual(beforeRows);
      const afterEvidence = yield* fixture.evidence();
      expect(afterEvidence.events).toEqual(beforeEvidence.events);
      expect(afterEvidence.outbox).toEqual(beforeEvidence.outbox);
      expect(
        afterEvidence.invocations.filter(
          (invocation) => invocation.actionKey === enrollRetailCustomerAction.descriptor.actionKey,
        ),
      ).toHaveLength(1);
      expect(
        afterEvidence.invocations.find(
          (invocation) => invocation.actionKey === enrollRetailCustomerAction.descriptor.actionKey,
        )?.status,
      ).not.toBe('succeeded');
    }),
  );

  suite.effect(
    'native enrollment reuses an old partial CUSTOMER directory and exact contacts without duplicate rows or messages',
    () =>
      Effect.gen(function* reusePartialDirectory() {
        const fixture = yield* makeAtomicityFixture();
        const evidenceReference = 'retained-old-partial-enrollment';
        yield* fixture.runtime
          .runAction({
            payload: {
              counterpartyProvenance: {
                evidenceReference,
                method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
                reason: 'Existing retail relationship',
                source: 'commerce.customer-context',
              },
              customerEvidence: {
                evidenceReference,
                method: 'APPROVED_PURCHASING_RELATIONSHIP',
                reason: 'Existing retail customer',
                source: 'commerce.customer-context',
              },
              partyRef: fixture.partyRef,
              validFrom,
            },
            principal: yield* fixture.gateway.verifyPrincipal(fixture.principal),
            registration: counterpartyCustomerOnboardAction,
            transport: fixture.transport(yield* nextId),
          })
          .pipe(Effect.provideContext(fixture.context));
        const contactInputs = [
          { preferred: true, type: 'EMAIL', value: email },
          { preferred: true, type: 'PHONE', value: phone },
        ];
        for (const contactPoint of contactInputs) {
          yield* fixture.runtime
            .runAction({
              payload: {
                contactPoint,
                partyRef: fixture.partyRef,
                privacyClassification: 'PERSONAL',
                provenance: {
                  authoritative: false,
                  evidenceReference,
                  method: 'DECLARED_BY_PARTY',
                  source: 'PARTY_DECLARATION',
                },
                validFrom,
              },
              principal: yield* fixture.gateway.verifyPrincipal(fixture.principal),
              registration: addContactPointAction,
              transport: fixture.transport(yield* nextId),
            })
            .pipe(Effect.provideContext(fixture.context));
        }
        const beforeRows = yield* fixture.rows();
        expect(beforeRows.contacts).toHaveLength(2);
        expect(beforeRows.counterparties).toHaveLength(1);
        expect(beforeRows.roles).toHaveLength(1);
        expect(beforeRows.roles[0]?.roleType).toBe('CUSTOMER');
        const beforeEvidence = yield* fixture.evidence();
        const key = yield* nextId;
        expect(yield* fixture.enroll(key, phone)).toEqual({ partyRef: fixture.partyRef });
        expect(yield* fixture.rows()).toEqual(beforeRows);
        const enrolledEvidence = yield* fixture.evidence();
        expect(enrolledEvidence.events).toEqual(beforeEvidence.events);
        expect(enrolledEvidence.outbox).toEqual(beforeEvidence.outbox);
        expect(Predicate.isTagged(yield* fixture.enroll(key, phone).pipe(Effect.flip), 'ActionAlreadyCommitted')).toBe(
          true,
        );
        expect(yield* fixture.rows()).toEqual(beforeRows);
        const replayEvidence = yield* fixture.evidence();
        expect(replayEvidence.events).toEqual(beforeEvidence.events);
        expect(replayEvidence.outbox).toEqual(beforeEvidence.outbox);
        expect(
          replayEvidence.invocations.filter(
            (invocation) => invocation.actionKey === enrollRetailCustomerAction.descriptor.actionKey,
          ),
        ).toHaveLength(1);
      }),
  );
});
