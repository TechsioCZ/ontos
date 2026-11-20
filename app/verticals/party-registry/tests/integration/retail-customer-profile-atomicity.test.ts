import { ActionRuntime, ReadRuntime, findPostgresFailure } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import {
  Array as EffectArray,
  Crypto,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';

import {
  RetailCustomerProfileAttestationSchema,
  RetailCustomerProfileViewSchema,
  UpdateRetailCustomerProfilePayloadSchema,
} from '../../shared/apis/retail-customer-profile.ts';
import type { RetailCustomerProfileDetails } from '../../shared/apis/retail-customer-profile.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { updateRetailCustomerProfileAction } from '../../src/actions/update-retail-customer-profile.action.ts';
import { retailCustomerProfileRead } from '../../src/api/retail-customer-profile.read.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { parties, partyContactPoints, partyCorrections, partyFactAssertions } from '../../src/db/schema.ts';
import { addContactPointRecord } from '../../src/services/party-contact-point-persistence.service.ts';
import { lockTenantIdentityWrites } from '../../src/services/party-identifier-claim.service.ts';
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
const validFrom = '2026-01-01T00:00:00.000Z';
const transport = (idempotencyKey: string) => ({
  correlationId: idempotencyKey,
  idempotencyKey,
  targetModuleKey: 'party.registry',
});

/** SQL/lifecycle isolation only: the native gate fixture explicitly admits the caller. The separate
 * production gate tests establish the verified CCC/storefront carrier without widening generic Actions. */
const makeProfileFixture = Effect.fn('RetailCustomerProfileAtomicity.fixture')(function* makeProfileFixture() {
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
      actionKeys: [createPartyAction, addContactPointAction, updateRetailCustomerProfileAction].map(
        ({ descriptor }) => descriptor.actionKey,
      ),
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
  const reads = yield* ReadRuntime.pipe(Effect.provideContext(context));
  const adminContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const core = yield* testCoreDatabase.pipe(Effect.provideContext(adminContext));
  const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const providerSubjectId = yield* nextId;
  const evidenceRef = yield* nextId;
  const created = yield* runtime
    .runAction({
      payload: {
        candidate: {
          evidenceRefs: [evidenceRef],
          firstName: 'Profile',
          lastName: 'Customer',
          officialIdentifiers: [],
          partyType: 'PERSON',
          provenance: { method: 'commerce.portal-enrollment.self-enrollment', source: 'commerce.customer-context' },
          subjectEvidence: [
            {
              basis: 'DIRECT_INTERACTION',
              evidenceRef,
              kind: 'ACTOR_ATTESTATION',
              observedSubject: 'PERSON',
              statement: 'This exact authenticated person requested a retail account',
              subjectKey: providerSubjectId,
            },
          ],
          validFrom,
        },
      },
      principal: yield* gateway.verifyPrincipal(principal),
      registration: createPartyAction,
      transport: transport(yield* nextId),
    })
    .pipe(Effect.provideContext(context));
  assert.isOk(created.outcome === 'CREATED');
  const attestation = yield* Schema.decodeUnknownEffect(RetailCustomerProfileAttestationSchema)({
    authBindingId: yield* nextId,
    customerPrincipalId: yield* nextId,
    partyId: created.partyRef.resourceId,
    providerSubjectId,
    sellingLegalEntityId: fixture.legalEntityId,
    sessionRefDigest: 'a'.repeat(64),
    tenantId: fixture.tenantId,
  });
  const read = () =>
    Effect.gen(function* readProfile() {
      const result = yield* reads
        .runRead({
          input: { attestation, view: 'PROFILE' },
          principal: yield* gateway.verifyPrincipal(principal),
          registration: retailCustomerProfileRead,
          transport: { correlationId: yield* nextId },
        })
        .pipe(Effect.provideContext(context));
      return yield* Schema.decodeUnknownEffect(RetailCustomerProfileViewSchema)(result);
    });
  const update = (key: string, profile: RetailCustomerProfileDetails) =>
    Effect.gen(function* updateProfile() {
      const payload = { attestation, update: profile };
      yield* Schema.decodeUnknownEffect(UpdateRetailCustomerProfilePayloadSchema)(payload);
      return yield* runtime
        .runAction({
          payload,
          principal: yield* gateway.verifyPrincipal(principal),
          registration: updateRetailCustomerProfileAction,
          transport: transport(key),
        })
        .pipe(Effect.provideContext(context));
    });
  const add = (type: 'EMAIL' | 'PHONE', value: string, preferred: boolean) =>
    Effect.gen(function* addDeclaredContact() {
      return yield* runtime
        .runAction({
          payload: {
            contactPoint: { preferred, type, value },
            partyRef: created.partyRef,
            privacyClassification: 'PERSONAL',
            provenance: {
              authoritative: false,
              evidenceReference: 'profile-native-fixture',
              method: 'DECLARED_BY_PARTY',
              source: 'PARTY_DECLARATION',
            },
            validFrom,
          },
          principal: yield* gateway.verifyPrincipal(principal),
          registration: addContactPointAction,
          transport: transport(yield* nextId),
        })
        .pipe(Effect.provideContext(context));
    });
  const resolveUpdate = (key: string) =>
    Effect.gen(function* resolveCommittedUpdateInvocation() {
      const resolution = yield* runtime.resolveActionExecution({
        actionKey: updateRetailCustomerProfileAction.descriptor.actionKey,
        idempotencyKey: key,
        principal: yield* gateway.verifyPrincipal(principal),
      });
      assert.isOk(resolution.state === 'COMMITTED');
      return resolution.invocationId;
    });
  const rows = () =>
    Effect.all({
      contacts: admin
        .select()
        .from(partyContactPoints)
        .where(
          and(
            eq(partyContactPoints.tenantId, fixture.tenantId),
            eq(partyContactPoints.partyId, created.partyRef.resourceId),
          ),
        )
        .orderBy(partyContactPoints.contactPointId),
      corrections: admin
        .select()
        .from(partyCorrections)
        .where(
          and(
            eq(partyCorrections.tenantId, fixture.tenantId),
            eq(partyCorrections.partyId, created.partyRef.resourceId),
          ),
        )
        .orderBy(partyCorrections.correctionId),
      facts: admin
        .select()
        .from(partyFactAssertions)
        .where(
          and(
            eq(partyFactAssertions.tenantId, fixture.tenantId),
            eq(partyFactAssertions.partyId, created.partyRef.resourceId),
          ),
        )
        .orderBy(partyFactAssertions.assertionId),
      parties: admin
        .select()
        .from(parties)
        .where(and(eq(parties.tenantId, fixture.tenantId), eq(parties.partyId, created.partyRef.resourceId))),
    });
  return {
    add,
    admin,
    attestation,
    evidence: () => fixture.evidence(core),
    fixture,
    gateway,
    partyRef: created.partyRef,
    principal,
    read,
    resolveUpdate,
    rows,
    update,
  };
});

/** Bounded real SQL observations in this exact disposable database; no fixed scheduling sleep. */
const waitForProfileLockWaiter = (
  admin: Effect.Success<ReturnType<typeof makePartyDatabase>>['executor'],
  queryPattern: '%parties%' | '%party_identity_lock_anchor%',
) =>
  Effect.findFirst(EffectArray.range(1, 10_000), () =>
    admin
      .execute<{ waiting: boolean }>(
        sql`
    select exists(select 1 from pg_stat_activity
      where datname=current_database() and pid<>pg_backend_pid()
        and wait_event_type='Lock' and query like ${queryPattern}) as waiting`,
        'objects',
      )
      .pipe(Effect.map((rows) => rows[0]?.waiting === true)),
  ).pipe(
    Effect.flatMap((observation) =>
      Option.isSome(observation)
        ? Effect.void
        : Effect.die('The profile never reached the bounded native PostgreSQL lock barrier'),
    ),
  );

it.layer(services, { excludeTestServices: true })((suite) => {
  suite.effect('schema-valid invalid phone or surname removal cannot partially change the profile', () =>
    Effect.gen(function* invalidPhoneRollback() {
      const fixture = yield* makeProfileFixture();
      yield* fixture.add('EMAIL', 'before@example.test', true);
      yield* fixture.add('PHONE', '+420777123456', true);
      const before = yield* fixture.read();
      const beforeRows = yield* fixture.rows();
      const beforeEvidence = yield* fixture.evidence();
      const failure = yield* fixture
        .update(yield* nextId, {
          ...before.profile,
          contactEmail: 'after@example.test',
          displayName: 'Changed Person',
          phone: '+4201',
        })
        .pipe(Effect.flip);
      expect(
        Predicate.isTagged(failure, 'PartyContactPointInvalid') ||
          Predicate.isTagged(failure, 'RetailCustomerProfileInvalid'),
      ).toBe(true);
      expect(yield* fixture.rows()).toEqual(beforeRows);
      expect(yield* fixture.read()).toEqual(before);
      const after = yield* fixture.evidence();
      expect(after.events).toEqual(beforeEvidence.events);
      expect(after.outbox).toEqual(beforeEvidence.outbox);
      // The Party owner preserves the existing surname rule even when the caller sends a
      // schema-valid mononym. Its valid contacts and unchanged version isolate that one refusal.
      const mononymFailure = yield* fixture
        .update(yield* nextId, {
          ...before.profile,
          displayName: 'Mononym',
        })
        .pipe(Effect.flip);
      expect(Predicate.isTagged(mononymFailure, 'RetailCustomerProfileInvalid')).toBe(true);
      expect(yield* fixture.rows()).toEqual(beforeRows);
      expect(yield* fixture.read()).toEqual(before);
      const afterMononym = yield* fixture.evidence();
      expect(afterMononym.events).toEqual(beforeEvidence.events);
      expect(afterMononym.outbox).toEqual(beforeEvidence.outbox);
    }),
  );

  suite.effect('a native late contact failure rolls back every earlier owner write and collected event', () =>
    Effect.gen(function* lateNativeContactRollback() {
      const fixture = yield* makeProfileFixture();
      yield* fixture.add('EMAIL', 'before@example.test', true);
      yield* fixture.add('PHONE', '+420777123456', true);
      const before = yield* fixture.read();
      const beforeRows = yield* fixture.rows();
      const beforeEvidence = yield* fixture.evidence();
      // A test-owned database rejection after the earlier name/email mutations, on a valid new phone.
      yield* fixture.admin.execute(
        sql`create function party.reject_late_profile_phone() returns trigger language plpgsql as $$
      begin if NEW.contact_point_type='PHONE' and NEW.normalized_value='+420777999888' then
        raise exception 'isolated profile phone rejection' using errcode='23514'; end if; return NEW; end $$`,
        'objects',
      );
      yield* fixture.admin.execute(
        sql`create trigger reject_late_profile_phone before insert or update on party.party_contact_points
      for each row execute function party.reject_late_profile_phone()`,
        'objects',
      );
      yield* fixture
        .update(yield* nextId, {
          ...before.profile,
          contactEmail: 'after@example.test',
          displayName: 'Changed Person',
          phone: '+420777999888',
        })
        .pipe(Effect.flip);
      expect(yield* fixture.rows()).toEqual(beforeRows);
      expect(yield* fixture.read()).toEqual(before);
      const after = yield* fixture.evidence();
      expect(after.events).toEqual(beforeEvidence.events);
      expect(after.outbox).toEqual(beforeEvidence.outbox);
    }),
  );

  suite.effect(
    'a successful atomic profile update has native replay and optimistic conflict without duplicate effects',
    () =>
      Effect.gen(function* successfulProfileLifecycle() {
        const fixture = yield* makeProfileFixture();
        yield* fixture.add('EMAIL', 'fallback@example.test', false);
        const oldEmail = yield* fixture.add('EMAIL', 'preferred@example.test', true);
        const oldPhone = yield* fixture.add('PHONE', '+420777123456', true);
        const before = yield* fixture.read();
        expect(before.profile.contactEmail).toBe('preferred@example.test');
        const changed = {
          ...before.profile,
          contactEmail: 'changed@example.test',
          displayName: 'Updated Customer',
          phone: '+420777999888',
        };
        const key = yield* nextId;
        yield* fixture.update(key, changed);
        const current = yield* fixture.read();
        const expected = yield* Schema.decodeUnknownEffect(RetailCustomerProfileViewSchema)({
          _tag: 'RetailCustomerProfile',
          partyRef: fixture.partyRef,
          profile: { ...changed, version: current.profile.version },
        });
        expect(current).toEqual(expected);
        expect(current.profile.version).not.toBe(before.profile.version);
        const committedRows = yield* fixture.rows();
        const invocationId = yield* fixture.resolveUpdate(key);
        const corrections = committedRows.corrections.filter(
          (correction) => correction.actionInvocationId === invocationId && correction.contactPointId !== null,
        );
        expect(corrections).toHaveLength(2);
        expect(corrections.map((correction) => correction.contactPointId)).toEqual(
          expect.arrayContaining([oldEmail.contactPointRef.resourceId, oldPhone.contactPointRef.resourceId]),
        );
        for (const correction of corrections) {
          expect(correction.actingPrincipalId).toBe(fixture.principal.principalId);
          expect(correction.evidenceRefs.length).toBeGreaterThan(0);
          const replacement = committedRows.contacts.find(
            (contact) => contact.contactPointId === correction.replacementContactPointId,
          );
          assert.isOk(replacement !== undefined);
          expect(replacement.partyId).toBe(fixture.partyRef.resourceId);
          expect(replacement.state).toBe('ACTIVE');
          if (correction.contactPointId === oldEmail.contactPointRef.resourceId) {
            expect(replacement.contactPointType).toBe('EMAIL');
            expect(replacement.normalizedValue).toBe('changed@example.test');
          } else {
            expect(replacement.contactPointType).toBe('PHONE');
            expect(replacement.normalizedValue).toBe('+420777999888');
          }
        }
        // The database still rejects a second correction for this exact contact and invocation.
        // Only its primary key differs; the real invocation, subject and evidence remain untouched.
        const [originalCorrection] = corrections;
        assert.isOk(originalCorrection !== undefined);
        const duplicateId = yield* nextId;
        const duplicateFailure = yield* fixture.admin
          .transaction((transaction) =>
            transaction.insert(partyCorrections).values({
              ...originalCorrection,
              correctionId: duplicateId,
            }),
          )
          .pipe(Effect.flip);
        expect(
          Option.isSome(
            findPostgresFailure(
              duplicateFailure,
              ({ code, constraint }) =>
                code === '23505' && constraint === 'party_corrections_action_invocation_contact_uk',
            ),
          ),
        ).toBe(true);
        expect(yield* fixture.rows()).toEqual(committedRows);
        const committedEvidence = yield* fixture.evidence();
        expect(
          Predicate.isTagged(yield* fixture.update(key, changed).pipe(Effect.flip), 'ActionAlreadyCommitted'),
        ).toBe(true);
        expect(
          Predicate.isTagged(
            yield* fixture.update(yield* nextId, { ...changed, displayName: 'Stale Overwrite' }).pipe(Effect.flip),
            'RetailCustomerProfileConflict',
          ),
        ).toBe(true);
        expect(yield* fixture.rows()).toEqual(committedRows);
        const afterRetry = yield* fixture.evidence();
        expect(afterRetry.events).toEqual(committedEvidence.events);
        expect(afterRetry.outbox).toEqual(committedEvidence.outbox);
      }),
  );

  suite.effect('a concurrent canonical contact writer changes the version before the profile can overwrite', () =>
    Effect.gen(function* concurrentContactVersionFence() {
      const fixture = yield* makeProfileFixture();
      yield* fixture.add('EMAIL', 'before@example.test', true);
      const before = yield* fixture.read();
      const beforeRows = yield* fixture.rows();
      const beforeEvidence = yield* fixture.evidence();
      const locked = yield* Deferred.make<boolean>();
      const releaseWriter = yield* Deferred.make<boolean>();
      const scope = {
        ...(yield* fixture.gateway.verifyPrincipal(fixture.principal)),
        correlationId: 'concurrent-profile-contact-owner',
      };
      const writer = yield* fixture.admin
        .transaction((transaction) =>
          Effect.gen(function* independentContactWriter() {
            yield* transaction
              .select({ partyId: parties.partyId })
              .from(parties)
              .where(
                and(eq(parties.tenantId, fixture.fixture.tenantId), eq(parties.partyId, fixture.partyRef.resourceId)),
              )
              .for('update');
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(releaseWriter);
            return yield* addContactPointRecord(transaction, scope, {
              acceptedByActionInvocationId: yield* nextId,
              acceptedByPrincipalId: fixture.principal.principalId,
              contactPoint: { preferred: true, type: 'EMAIL', value: 'concurrent@example.test' },
              partyRef: fixture.partyRef,
              privacyClassification: 'PERSONAL',
              provenance: {
                authoritative: false,
                evidenceReference: 'native-concurrent-contact',
                method: 'DECLARED_BY_PARTY',
                source: 'PARTY_DECLARATION',
              },
              validFrom,
            });
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const updateKey = yield* nextId;
      const updating = yield* fixture
        .update(updateKey, { ...before.profile, displayName: 'Stale Overwrite', contactEmail: 'stale@example.test' })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.gen(function* releaseAtNativeRowBarrier() {
        yield* waitForProfileLockWaiter(fixture.admin, '%parties%');
        yield* Deferred.succeed(releaseWriter, true);
        yield* Fiber.join(writer);
        const result = yield* Fiber.join(updating);
        assert.isOk(Result.isFailure(result));
        expect(Predicate.isTagged(result.failure, 'RetailCustomerProfileConflict')).toBe(true);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseWriter, true)));
      const current = yield* fixture.read();
      expect(current.profile.contactEmail).toBe('concurrent@example.test');
      expect(current.profile.displayName).toBe(before.profile.displayName);
      expect(current.profile.version).not.toBe(before.profile.version);
      const afterRows = yield* fixture.rows();
      expect(afterRows.parties).toEqual(beforeRows.parties);
      expect(afterRows.facts).toEqual(beforeRows.facts);
      const afterEvidence = yield* fixture.evidence();
      expect(afterEvidence.events).toEqual(beforeEvidence.events);
      expect(afterEvidence.outbox).toEqual(beforeEvidence.outbox);
    }),
  );

  suite.effect('the profile waits for the Tenant identity fence before taking the shared Party row lock', () =>
    Effect.gen(function* identityBeforePartyRowOrder() {
      const fixture = yield* makeProfileFixture();
      const before = yield* fixture.read();
      const locked = yield* Deferred.make<boolean>();
      const releaseIdentityWriter = yield* Deferred.make<boolean>();
      const identityWriter = yield* fixture.admin
        .transaction((transaction) =>
          Effect.gen(function* independentIdentityWriter() {
            yield* lockTenantIdentityWrites(transaction, fixture.fixture.tenantId);
            yield* Deferred.succeed(locked, true);
            yield* Deferred.await(releaseIdentityWriter);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const updateKey = yield* nextId;
      const updating = yield* fixture
        .update(updateKey, { ...before.profile, displayName: 'Ordered Customer' })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.gen(function* probePartyWhileIdentityIsHeld() {
        yield* waitForProfileLockWaiter(fixture.admin, '%party_identity_lock_anchor%');
        // A NOWAIT probe is a lock-order assertion. A profile that took the row first
        // would prevent this independent writer while itself waiting for the Tenant fence.
        const rowProbe = yield* fixture.admin
          .transaction((transaction) =>
            transaction.execute(
              sql`
          select party_id from party.parties where tenant_id=${fixture.fixture.tenantId}::uuid
            and party_id=${fixture.partyRef.resourceId}::uuid for update nowait`,
              'objects',
            ),
          )
          .pipe(Effect.result);
        expect(Result.isSuccess(rowProbe)).toBe(true);
        yield* Deferred.succeed(releaseIdentityWriter, true);
        yield* Fiber.join(identityWriter);
        expect(Result.isSuccess(yield* Fiber.join(updating))).toBe(true);
      }).pipe(Effect.ensuring(Deferred.succeed(releaseIdentityWriter, true)));
      expect((yield* fixture.read()).profile.displayName).toBe('Ordered Customer');
    }),
  );
});
