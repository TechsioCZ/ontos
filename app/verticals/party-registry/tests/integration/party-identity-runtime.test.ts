import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import type {
  OutboxCycleError,
  OutboxCycleResult,
  OutboxWorkerRequirements,
  TrustedPrincipalContext,
} from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  loadDatabaseIdentityConnections,
  OutboxRuntime,
  ReadRuntime,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  SHARED_RUNTIME_IDENTITY,
  runAction,
} from '@app/core-runtime';
import { defineOutboxWorkerEntry, extractOutboxWorkerSubscriptions } from '@app/core-runtime/outbox/worker';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makePartyDeniedAccess } from '../support/live-access-authority.ts';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '@app/core-runtime/testing/gateway-scope-grant';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, DateTime, Deferred, Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import type { Row } from 'effect/sql/SqlConnection';

import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { testCoreDatabase, deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { IdentityCorrectionCommandSchema } from '../../shared/domain/correction-contracts.ts';
import type { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { outboxTopic as partyCreatedTopic } from '../../shared/outbox/party-registry-party-created-v1.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { endPartyOfficialIdentifierAction } from '../../src/actions/end-party-official-identifier.action.ts';
import { requestSearchRebuildAction } from '../../src/actions/request-search-rebuild.action.ts';
import { partyOfficialIdentifierHistoryRead } from '../../src/api/party-official-identifier-history.read.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { counterpartyCreateAction } from '../../src/actions/counterparty-create.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { partyContactPointsRead } from '../../src/api/party-contact-points.read.ts';
import { counterpartiesRead } from '../../src/search/counterparties.provider.ts';
import { PartySearchProjectionGatewayLive } from '../../src/search/parties.provider.ts';
import {
  outboxWorkerCorePersistenceLive,
  outboxWorkerDatabaseConfigLive,
  outboxWorkerDatabaseIdentityEnrollmentLive,
  outboxWorkerHandlerLayers,
  outboxWorkerLayer,
  outboxWorkerRepositoryLive,
} from '../../src/worker-host/layer.ts';
import { outboxWorkers } from '../../src/workers/index.ts';
import { partyCompositionSnapshot } from './application-composition.setup.ts';
import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';

type EncodedPartyCandidate = typeof PartyCandidateSchema.Encoded;
type EncodedFixturePrincipal = typeof TrustedPrincipalContextSchema.Encoded;

const testAuthenticationNamespaceId = 'test.party.identity-runtime.v1';
const sharedIco = '27074358';
const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const freshTransport = nextUuid.pipe(
  Effect.map((idempotencyKey) => ({
    correlationId: `identity-runtime-${idempotencyKey}`,
    idempotencyKey,
    targetModuleKey: 'party.registry',
  })),
);
const freshReadTransport = nextUuid.pipe(Effect.map((correlationId) => ({ correlationId })));
const candidate = (ico: string): EncodedPartyCandidate => ({
  partyType: 'ORGANIZATION',
  officialIdentifiers: [{ identifierType: 'ICO', value: ico }],
  subjectEvidence: [
    {
      kind: 'ACTOR_ATTESTATION',
      basis: 'REVIEWED_DOCUMENT',
      evidenceRef: 'review/identity-runtime',
      observedSubject: 'ORGANIZATION',
      subjectKey: 'subject',
      statement: 'Reviewed this concrete external organization',
    },
  ],
  evidenceRefs: ['review/identity-runtime'],
  provenance: { method: 'DOCUMENT', source: 'identity-runtime' },
  validFrom: '2020-01-01T00:00:00.000Z',
});
const counterpartyProvenance = {
  evidenceReference: 'review/identity-runtime',
  method: 'SIGNED_CONTRACT',
  reason: 'Business relationship',
  source: 'identity-runtime',
} as const;
const contactPointProvenance = {
  authoritative: false,
  method: 'MANUAL_CONFIRMATION',
  source: 'USER_ASSERTION',
} as const;
const decodeFixturePrincipal = (principal: EncodedFixturePrincipal): TrustedPrincipalContext =>
  Schema.decodeSync(TrustedPrincipalContextSchema)(principal);

/** The production worker host composition from `src/worker-host/entry.ts`, minus the HTTP composition source. */
const partyWorkerRuntimeLive = outboxWorkerLayer.pipe(
  Layer.provide(outboxWorkerHandlerLayers.projectionSource),
  Layer.provide(outboxWorkerHandlerLayers.searchIngestion),
  Layer.provide(outboxWorkerHandlerLayers.searchProjectionStore),
  Layer.provide(outboxWorkerHandlerLayers.searchWorkerSnapshot),
  Layer.provide(outboxWorkerHandlerLayers.searchIngestionRegistry),
  Layer.provide(outboxWorkerRepositoryLive),
  Layer.provide(outboxWorkerCorePersistenceLive),
  Layer.provide(outboxWorkerDatabaseConfigLive),
  Layer.provide(outboxWorkerDatabaseIdentityEnrollmentLive),
  Layer.provide(NodeCrypto.layer),
);

const runCycleOnce = (compositionRevision: string) =>
  Effect.gen(function* runCycleOnceEffect() {
    const runtime = yield* OutboxRuntime;
    const workerServices = yield* Effect.context<OutboxWorkerRequirements<(typeof outboxWorkers)[number]>>();
    const snapshot = yield* partyCompositionSnapshot;
    expect(snapshot.composition.revision).toBe(compositionRevision);
    const claimOwner = `party.registry-identity-runtime-${yield* nextUuid}`;
    const matched = yield* runtime.matchMessages({ compositionRevision });
    const subscriptions = extractOutboxWorkerSubscriptions(outboxWorkers);
    const completed = yield* Deferred.make<OutboxCycleResult, OutboxCycleError>();
    const entry = defineOutboxWorkerEntry({
      claimOwnerPrefix: 'party.registry-identity-runtime',
      expectedDeployment: ultramodernApiMarker,
      layer: Layer.mergeAll(
        Layer.succeedContext(workerServices),
        Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) }),
        Layer.succeed(OutboxRuntime, {
          ...runtime,
          runCycle: () =>
            runtime.runCycle({ claimOwner, compositionRevision, registrations: outboxWorkers, subscriptions }).pipe(
              Effect.provideContext(workerServices),
              Effect.onExit((exit) => Deferred.done(completed, exit)),
            ),
        }),
      ),
      ownerRegistration: partyRegistryBackendRegistration,
      registrations: outboxWorkers,
      subscriptions,
    });
    const cycle = yield* Deferred.await(completed).pipe(
      Effect.raceFirst(
        entry
          .runLoop({ config: { claimOwner, maxDeliveries: 50, pollIntervalMs: 1000 } })
          .pipe(Effect.andThen(Effect.never)),
      ),
    );
    return { cycle, matched };
  }).pipe(Effect.scoped);

/** One match + claim/handle/complete cycle over the Party Outbox Workers as `party_registry_worker`. */
const runPartyWorkerCycle = (compositionRevision: string) =>
  Effect.gen(function* runPartyWorkerCycleEffect() {
    const workerContext = yield* Layer.build(partyWorkerRuntimeLive);
    return yield* runCycleOnce(compositionRevision).pipe(Effect.provideContext(workerContext));
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const query = (client: PgClient.PgClient, statement: string, parameters: readonly unknown[] = []) =>
  client.unsafe<Row>(statement, parameters);

/** Removes every row a worker-cycle fixture tenant owns, deliveries and attempts first. */
const purgeWorkerTenant = (admin: PgClient.PgClient, tenantId: string) =>
  Effect.forEach(
    [
      `delete from core.outbox_attempts where outbox_delivery_id in (
         select outbox_delivery_id from core.outbox_deliveries where outbox_message_id in (
           select outbox_message_id from core.outbox_messages where tenant_id = $1))`,
      `delete from core.outbox_deliveries where outbox_message_id in (
         select outbox_message_id from core.outbox_messages where tenant_id = $1)`,
      'delete from core.worker_checkpoints where tenant_id = $1',
      'delete from core.search_index_entries where tenant_id = $1',
      'delete from core.search_projection_rebuilds where tenant_id = $1',
      'delete from core.search_projection_generations where tenant_id = $1',
      'delete from core.outbox_messages where tenant_id = $1',
      'delete from core.domain_events where tenant_id = $1',
      'delete from core.tenant_module_state_changes where tenant_id = $1',
      'delete from core.tenant_module_states where tenant_id = $1',
      'delete from party.parties where tenant_id = $1',
      'delete from core.tenants where tenant_id = $1',
    ],
    (statement) => query(admin, statement, [tenantId]),
    { discard: true },
  );

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'runs a Party Action, Read and Search through the production layers on the Party request identity',
    () =>
      Effect.scoped(
        Effect.gen(function* requestIdentityRuntimeEffect() {
          const connections = yield* loadDatabaseIdentityConnections({
            enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            envPath: '/dev/null',
          });
          const partyConfiguration = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
          const issuerConfiguration = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
          const bootstrapConfiguration = connections.runtime[SHARED_RUNTIME_IDENTITY.id];
          assert.isOk(partyConfiguration);
          assert.isOk(issuerConfiguration);
          assert.isOk(bootstrapConfiguration);
          expect(partyConfiguration.expectedRole).toBe(PARTY_REGISTRY_REQUEST_IDENTITY.role);
          expect(issuerConfiguration.expectedRole).toBe(SHELL_GATEWAY_ISSUER_IDENTITY.role);
          expect(bootstrapConfiguration.expectedRole).toBe(SHARED_RUNTIME_IDENTITY.role);
          const partyRuntimeConnectionString = partyConfiguration.connectionString;
          const issuerClient = yield* makeTestPgClient(issuerConfiguration.connectionString, { maxConnections: 1 });
          const compositionSnapshot = yield* partyCompositionSnapshot;
          const compositionRevision = compositionSnapshot.composition.revision;
          const actionKeys = [
            createPartyAction,
            counterpartyCreateAction,
            addContactPointAction,
            addPartyOfficialIdentifierAction,
            correctPartyFactAction,
            endPartyOfficialIdentifierAction,
            requestSearchRebuildAction,
          ].map(({ descriptor }) => descriptor.actionKey);
          const openFixture = Effect.acquireRelease(
            makeLiveOperationFixture({
              access: 'allowed',
              actionKeys,
              adminConnectionString: Redacted.make(connections.admin.connectionString),
              authenticationNamespaceId: testAuthenticationNamespaceId,
              // The dedicated request role cannot install scope; the scoped native writers take the
              // same target's shared runtime credential while the actor keeps its own role.
              bootstrapConnectionString: Redacted.make(bootstrapConfiguration.connectionString),
              compositionRevision,
              databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
              ownerRegistration: partyRegistryBackendRegistration,
              runtimeConnectionString: Redacted.make(partyRuntimeConnectionString),
            }).pipe(Effect.orDie),
            (resource) => resource.close().pipe(Effect.orDie),
          );
          const fixture = yield* openFixture;
          const other = yield* openFixture;
          const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
          const coreAdmin = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, adminClient));
          yield* addTestGatewayScopeGrantCleanup(adminClient, [fixture.tenantId, other.tenantId]);
          // Release only these disposable tenants' dispatch queues; retain append-only Core evidence.
          yield* Effect.addFinalizer(() =>
            Effect.forEach([fixture.tenantId, other.tenantId], (tenantId) =>
              deleteTestCoreOutbox(adminClient, tenantId),
            ).pipe(Effect.orDie),
          );
          const deniedAccess = makePartyDeniedAccess();
          const fixtureContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(deniedAccess.layer)));
          const otherContext = yield* Layer.build(other.layer);
          // Each principal carries a registered gateway grant, as a redeemed Shell assertion would.
          const withGatewayScope = Effect.fn('PartyIdentityRuntimeTest.withGatewayScope')(function* withGatewayScope(
            principal: EncodedFixturePrincipal,
          ) {
            const context = decodeFixturePrincipal(principal);
            const grant = {
              audience: 'party-registry',
              principalId: context.principalId,
              tenantId: context.tenantId,
            };
            const { assertion } = yield* registerTestGatewayScopeGrant(
              issuerClient,
              context.legalEntityId === undefined ? grant : { ...grant, legalEntityId: context.legalEntityId },
              PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            ).pipe(Effect.orDie);
            return trustVerifiedGatewayPrincipalContext(context, compositionRevision, {
              assertion,
              audience: 'party-registry',
            });
          });
          const managerPrincipal = yield* withGatewayScope(fixture.manager);
          const deniedPrincipal = yield* withGatewayScope(fixture.denied);
          const legalEntityPrincipal = yield* withGatewayScope(fixture.legalEntityOnly);
          const managerReadPrincipal = yield* withGatewayScope({
            ...fixture.manager,
            legalEntityId: fixture.legalEntityId,
          });
          const otherManagerPrincipal = yield* withGatewayScope(other.manager);
          const otherLegalEntityPrincipal = yield* withGatewayScope(other.legalEntityOnly);

          const seedCounterparty = Effect.fn('PartyIdentityRuntimeTest.seedCounterparty')(function* seedCounterparty(
            manager: TrustedPrincipalContext,
            legalEntity: TrustedPrincipalContext,
          ) {
            const created = yield* runAction({
              registration: createPartyAction,
              payload: { candidate: candidate(sharedIco) },
              principal: manager,
              transport: yield* freshTransport,
            });
            assert.isOk(created.outcome === 'CREATED');
            const counterparty = yield* runAction({
              registration: counterpartyCreateAction,
              payload: { partyRef: created.partyRef, provenance: counterpartyProvenance },
              principal: legalEntity,
              transport: yield* freshTransport,
            });
            return { counterpartyRef: counterparty.counterpartyRef, partyRef: created.partyRef };
          });
          const own = yield* seedCounterparty(managerPrincipal, legalEntityPrincipal).pipe(
            Effect.provideContext(fixtureContext),
          );
          const foreign = yield* seedCounterparty(otherManagerPrincipal, otherLegalEntityPrincipal).pipe(
            Effect.provideContext(otherContext),
          );

          const addContactPoint = (principal: TrustedPrincipalContext) =>
            Effect.gen(function* addContactPointEffect() {
              return yield* runAction({
                registration: addContactPointAction,
                payload: {
                  contactPoint: { preferred: true, type: 'EMAIL', value: 'identity-runtime@example.test' },
                  partyRef: own.partyRef,
                  privacyClassification: 'PERSONAL',
                  provenance: contactPointProvenance,
                  validFrom: '2026-09-01T00:00:00.000Z',
                },
                principal,
                transport: yield* freshTransport,
              });
            }).pipe(Effect.provideContext(fixtureContext));

          // A real Action on the Party request identity commits its event and outbox message.
          const before = yield* fixture.evidence(coreAdmin).pipe(Effect.orDie);
          const contactPoint = yield* addContactPoint(managerPrincipal);
          expect(contactPoint.partyRef).toEqual(own.partyRef);
          const afterAction = yield* fixture.evidence(coreAdmin).pipe(Effect.orDie);
          const addedEvents = afterAction.events.filter(
            (event) => event.eventType === 'party.registry.contact-point-added.v1',
          );
          expect(addedEvents.length).toBe(1);
          expect(
            afterAction.outbox.filter((message) => message.domainEventId === addedEvents[0]?.domainEventId).length,
          ).toBe(1);
          expect(afterAction.events.length).toBe(before.events.length + 1);
          expect(afterAction.outbox.length).toBe(before.outbox.length + 1);

          // A permission-denied Action changes nothing and leaves its rejection audit. v2 decides
          // this Action at the one access gate (O62): the fixture scripts its gate per capability,
          // so the refusal of this one principal is named on the fixture's own per-request owner
          // seam, which the runtime records exactly like a gate denial.
          deniedAccess.deny(deniedPrincipal.principalId, 'party.registry.contact-point.add');
          const denial = yield* addContactPoint(deniedPrincipal).pipe(Effect.flip);
          assert.isOk(Predicate.isTagged(denial, 'ActionPermissionDenied'));
          const afterDenial = yield* fixture.evidence(coreAdmin).pipe(Effect.orDie);
          expect(afterDenial.events.length).toBe(afterAction.events.length);
          expect(afterDenial.outbox.length).toBe(afterAction.outbox.length);
          expect(
            afterDenial.audits.filter(
              (audit) => audit.principalId === deniedPrincipal.principalId && audit.outcome === 'denied',
            ).length,
          ).toBeGreaterThanOrEqual(1);

          // A Read on the Party request identity sees the committed contact point.
          const contactPoints = yield* Effect.all([ReadRuntime, freshReadTransport]).pipe(
            Effect.flatMap(([runtime, transport]) =>
              runtime.runRead({
                registration: partyContactPointsRead,
                input: { partyRef: own.partyRef },
                principal: managerReadPrincipal,
                transport,
              }),
            ),
            Effect.provideContext(fixtureContext),
          );
          expect(contactPoints.items.map((item) => item.contactPointRef)).toEqual([contactPoint.contactPointRef]);

          // The worker projects both tenants' counterparties; Search returns only the caller's tenant.
          // Owning a Counterparty does not grant resource permission; Search filters results by it.
          yield* fixture.grantResourceAccess(own.counterpartyRef, legalEntityPrincipal.principalId);
          yield* runPartyWorkerCycle(compositionRevision);
          const searchContext = yield* Layer.build(
            PartySearchProjectionGatewayLive.pipe(
              Layer.provide(CoreSearchQueryRuntimeLive),
              Layer.provide(CoreSearchProjectionStoreLive),
            ),
          ).pipe(Effect.provideContext(fixtureContext));
          const search = (searchQuery: string) =>
            Effect.all([ReadRuntime, freshReadTransport]).pipe(
              Effect.flatMap(([runtime, transport]) =>
                runtime.runRead({
                  registration: counterpartiesRead,
                  input: { query: searchQuery },
                  principal: legalEntityPrincipal,
                  transport,
                }),
              ),
              Effect.provideContext(searchContext),
              Effect.provideContext(fixtureContext),
            );
          const hits = yield* search(sharedIco);
          const refs = hits.map(({ ref }) => ref);
          expect(refs).toContainEqual(own.counterpartyRef);
          expect(refs).not.toContainEqual(foreign.counterpartyRef);
          expect(refs.every((ref) => ref.tenantId === fixture.tenantId)).toBe(true);
          expect(yield* search('identity-runtime@example.test')).toEqual([]);

          deniedAccess.deny(deniedPrincipal.principalId, 'party.registry.search-index.rebuild');
          const beforeRebuildDenial = yield* fixture.evidence(coreAdmin);
          const rebuildDenied = yield* runAction({
            registration: requestSearchRebuildAction,
            payload: {},
            principal: deniedPrincipal,
            transport: yield* freshTransport,
          }).pipe(Effect.provideContext(fixtureContext), Effect.flip);
          assert.isOk(Predicate.isTagged(rebuildDenied, 'ActionPermissionDenied'));
          const afterRebuildDenial = yield* fixture.evidence(coreAdmin);
          expect(afterRebuildDenial.events).toEqual(beforeRebuildDenial.events);
          expect(afterRebuildDenial.outbox).toEqual(beforeRebuildDenial.outbox);

          const rebuildAndProject = Effect.fn('PartyIdentityRuntimeTest.rebuildAndProject')(function* rebuildAndProject(
            expectedWorker: string,
            referenceKey: string,
            referenceId: string,
          ) {
            const queued = yield* runAction({
              registration: requestSearchRebuildAction,
              payload: {},
              principal: managerPrincipal,
              transport: yield* freshTransport,
            }).pipe(Effect.provideContext(fixtureContext));
            expect(queued.status).toBe('QUEUED');
            const { cycle } = yield* runPartyWorkerCycle(compositionRevision);
            expect(cycle.succeeded).toBeGreaterThanOrEqual(1);
            const rebuildDeliveries = yield* query(
              adminClient,
              `select delivery.status, delivery.worker_key, message.payload_json
                 from core.outbox_deliveries delivery
                 join core.outbox_messages message using (outbox_message_id)
                where message.tenant_id = $1 and delivery.worker_key = 'party.registry.rebuild-search'
                  and message.payload_json ->> 'requestId' = $2`,
              [fixture.tenantId, queued.requestId],
            );
            expect(rebuildDeliveries).toEqual([
              {
                status: 'done',
                worker_key: 'party.registry.rebuild-search',
                payload_json: { requestId: queued.requestId },
              },
            ]);
            const lifecycleDeliveries = yield* query(
              adminClient,
              `select delivery.status, delivery.worker_key
                 from core.outbox_deliveries delivery
                 join core.outbox_messages message using (outbox_message_id)
                where message.tenant_id = $1 and delivery.worker_key = $2
                  and message.payload_json -> $3 ->> 'resourceId' = $4`,
              [fixture.tenantId, expectedWorker, referenceKey, referenceId],
            );
            expect(lifecycleDeliveries).toEqual([{ status: 'done', worker_key: expectedWorker }]);
          });
          const firstDic = 'CZ27074358';
          const correctedDic = 'CZ26168685';
          expect(yield* search(firstDic)).toEqual([]);
          const addedIdentifier = yield* runAction({
            registration: addPartyOfficialIdentifierAction,
            payload: {
              identifier: { identifierType: 'CZ_DIC', value: firstDic },
              partyRef: own.partyRef,
              provenanceMethod: 'DOCUMENT',
              provenanceSource: 'identity-runtime',
              validFrom: '2020-01-01T00:00:00.000Z',
            },
            principal: managerPrincipal,
            transport: yield* freshTransport,
          }).pipe(Effect.provideContext(fixtureContext));
          yield* rebuildAndProject(
            'party.registry.project-official-identifier-added-to-search',
            'officialIdentifierRef',
            addedIdentifier.officialIdentifierRef.resourceId,
          );
          expect((yield* search(firstDic)).map(({ ref }) => ref)).toEqual([own.counterpartyRef]);

          const corrected = yield* runAction({
            registration: correctPartyFactAction,
            payload: yield* Schema.decodeUnknownEffect(IdentityCorrectionCommandSchema)({
              partyId: own.partyRef.resourceId,
              targetAssertionId: addedIdentifier.officialIdentifierRef.resourceId,
              factKind: 'OFFICIAL_IDENTIFIER',
              replacementValue: correctedDic,
              reasonCode: 'WRONG_IDENTITY_VALUE',
              reasonDetail: 'Correct the declared identifier from retained source evidence',
              evidenceSource: 'DOCUMENT',
              evidenceRefs: ['identity-runtime/correction'],
              policyVersion: 'party-correction.v1',
              provenance: { method: 'DOCUMENT', source: 'identity-runtime' },
            }),
            principal: managerPrincipal,
            transport: yield* freshTransport,
          }).pipe(Effect.provideContext(fixtureContext));
          yield* rebuildAndProject(
            'party.registry.project-party-fact-corrected-to-search',
            'correctionRef',
            corrected.correctionRef.resourceId,
          );
          expect(yield* search(firstDic)).toEqual([]);
          expect((yield* search(correctedDic)).map(({ ref }) => ref)).toEqual([own.counterpartyRef]);
          const history = yield* Effect.all([ReadRuntime, freshReadTransport]).pipe(
            Effect.flatMap(([runtime, transport]) =>
              runtime.runRead({
                registration: partyOfficialIdentifierHistoryRead,
                input: { partyRef: own.partyRef },
                principal: managerReadPrincipal,
                transport,
              }),
            ),
            Effect.provideContext(fixtureContext),
          );
          const replacement = history.items.find((item) => item.normalizedValue === correctedDic);
          assert.isOk(replacement);
          expect(history.items.find((item) => item.normalizedValue === firstDic)?.state).toBe('SUPERSEDED');
          yield* runAction({
            registration: endPartyOfficialIdentifierAction,
            payload: {
              officialIdentifierRef: replacement.officialIdentifierRef,
              reason: 'Declared identifier validity ended',
              validTo: DateTime.formatIso(yield* DateTime.now),
            },
            principal: managerPrincipal,
            transport: yield* freshTransport,
          }).pipe(Effect.provideContext(fixtureContext));
          yield* rebuildAndProject(
            'party.registry.project-official-identifier-ended-to-search',
            'officialIdentifierRef',
            replacement.officialIdentifierRef.resourceId,
          );
          expect(yield* search(correctedDic)).toEqual([]);
          expect((yield* search(sharedIco)).map(({ ref }) => ref)).toEqual([own.counterpartyRef]);
          expect(yield* search('identity-runtime@example.test')).toEqual([]);
          // Rehearse the approved non-client reset on exactly three derived fixture records.
          // The previous worker-cycle scope has joined; no worker runs until all obsolete rows are gone.
          const resetDatabase = new URL(connections.admin.connectionString);
          expect(['127.0.0.1', 'localhost', '[::1]']).toContain(resetDatabase.hostname);
          expect(resetDatabase.port).toBe('5433');
          expect(resetDatabase.pathname).toBe('/ontos_ci');
          expect(resetDatabase.username).toBe('ontos_ci_admin');
          const canonicalControls = () =>
            query(
              adminClient,
              `select kind, digest from (
               select 'tenant' as kind, md5(to_jsonb(row)::text) as digest from core.tenants row where tenant_id in ($1, $2)
               union all select 'principal', md5(to_jsonb(row)::text) from core.principals row where tenant_id in ($1, $2)
               union all select 'auth_binding', md5(to_jsonb(row)::text) from core.principal_auth_bindings row where tenant_id in ($1, $2)
               union all select 'module_state', md5(to_jsonb(row)::text) from core.tenant_module_states row where tenant_id in ($1, $2)
               union all select 'party', md5(to_jsonb(row)::text) from party.parties row where tenant_id in ($1, $2)
               union all select 'fact', md5(to_jsonb(row)::text) from party.party_fact_assertions row where tenant_id in ($1, $2)
               union all select 'identifier', md5(to_jsonb(row)::text) from party.party_official_identifiers row where tenant_id in ($1, $2)
               union all select 'contact', md5(to_jsonb(row)::text) from party.party_contact_points row where tenant_id in ($1, $2)
               union all select 'purpose', md5(to_jsonb(row)::text) from party.party_contact_point_purposes row where tenant_id in ($1, $2)
               union all select 'counterparty', md5(to_jsonb(row)::text) from party.counterparties row where tenant_id in ($1, $2)
             ) controls order by kind, digest`,
              [fixture.tenantId, other.tenantId],
            );
          const foreignProjection = () =>
            query(
              adminClient,
              `select md5(to_jsonb(entry)::text) as digest from core.search_index_entries entry
              where tenant_id = $1 and source_module_key = 'party.registry' order by search_index_entry_id`,
              [other.tenantId],
            );
          const beforeResetControls = yield* canonicalControls();
          const beforeForeignProjection = yield* foreignProjection();
          expect(beforeForeignProjection.length).toBeGreaterThanOrEqual(1);
          const beforeResetEvidence = yield* fixture.evidence(coreAdmin);
          const [ownProjection] = yield* query(
            adminClient,
            `select search_index_entry_id from core.search_index_entries
              where tenant_id = $1 and source_module_key = 'party.registry'
                and source_resource_type = 'party.registry.counterparty' and source_resource_id = $2`,
            [fixture.tenantId, own.counterpartyRef.resourceId],
          );
          assert.isOk(ownProjection);
          const [obsoleteMessageId, obsoleteDeliveryId] = yield* Effect.all([nextUuid, nextUuid]);
          const [addedEvent] = addedEvents;
          assert.isOk(addedEvent);
          // Deliberately synthetic obsolete payload; historical contact outbox messages were reference-only.
          const syntheticObsoletePayload = {
            contactPointRef: contactPoint.contactPointRef,
            partyRef: own.partyRef,
            verification: { state: 'UNVERIFIED' },
          };
          yield* adminClient.withTransaction(
            Effect.gen(function* seedDisposableResetRecords() {
              expect(
                yield* query(
                  adminClient,
                  `update core.search_index_entries set title = 'Synthetic stale fixture projection', body_text = 'obsolete-fixture'
                where search_index_entry_id = $1 and tenant_id = $2 and source_module_key = 'party.registry'
                  and source_resource_type = 'party.registry.counterparty' and source_resource_id = $3
                returning search_index_entry_id`,
                  [ownProjection['search_index_entry_id'], fixture.tenantId, own.counterpartyRef.resourceId],
                ),
              ).toHaveLength(1);
              yield* query(
                adminClient,
                `insert into core.outbox_messages (outbox_message_id, tenant_id, domain_event_id, producer_module_key, topic, payload_json)
               values ($1, $2, $3, 'party.registry', 'party.registry.contact-point-added.v1', $4::jsonb)`,
                [obsoleteMessageId, fixture.tenantId, addedEvent.domainEventId, encodeJson(syntheticObsoletePayload)],
              );
              yield* query(
                adminClient,
                `insert into core.outbox_deliveries (outbox_delivery_id, outbox_message_id, worker_key, consumer_module_key, status, attempts_count)
               values ($1, $2, 'party.registry.project-contact-point-added-to-search', 'party.registry', 'pending', 0)`,
                [obsoleteDeliveryId, obsoleteMessageId],
              );
            }),
          );
          yield* adminClient.withTransaction(
            Effect.gen(function* resetAllowlistedDerivedRecords() {
              const locked = yield* query(
                adminClient,
                `select delivery.status, delivery.attempts_count, delivery.claimed_by, delivery.claimed_at, delivery.claim_expires_at,
                      message.completion_consumer_module_key, message.completion_original_revision, message.matched_at, message.payload_json
                 from core.outbox_messages message join core.outbox_deliveries delivery using (outbox_message_id)
                where message.outbox_message_id = $1 and message.tenant_id = $2 and message.domain_event_id = $3
                  and message.producer_module_key = 'party.registry' and message.topic = 'party.registry.contact-point-added.v1'
                  and delivery.outbox_delivery_id = $4 and delivery.consumer_module_key = 'party.registry'
                  and delivery.worker_key = 'party.registry.project-contact-point-added-to-search'
                for update of message, delivery`,
                [obsoleteMessageId, fixture.tenantId, addedEvent.domainEventId, obsoleteDeliveryId],
              );
              expect(locked).toEqual([
                {
                  status: 'pending',
                  attempts_count: 0,
                  claimed_by: null,
                  claimed_at: null,
                  claim_expires_at: null,
                  completion_consumer_module_key: null,
                  completion_original_revision: null,
                  matched_at: null,
                  payload_json: syntheticObsoletePayload,
                },
              ]);
              expect(
                yield* query(
                  adminClient,
                  `select (select count(*)::integer from core.outbox_attempts where outbox_delivery_id = $1) as attempts,
                      (select count(*)::integer from core.outbox_delivery_resolutions where outbox_delivery_id = $1 or outbox_message_id = $2) as resolutions`,
                  [obsoleteDeliveryId, obsoleteMessageId],
                ),
              ).toEqual([{ attempts: 0, resolutions: 0 }]);
              expect(
                yield* query(
                  adminClient,
                  `delete from core.outbox_deliveries where outbox_delivery_id = $1 and outbox_message_id = $2 returning outbox_delivery_id`,
                  [obsoleteDeliveryId, obsoleteMessageId],
                ),
              ).toEqual([{ outbox_delivery_id: obsoleteDeliveryId }]);
              expect(
                yield* query(
                  adminClient,
                  `delete from core.outbox_messages where outbox_message_id = $1 and tenant_id = $2 and domain_event_id = $3 returning outbox_message_id`,
                  [obsoleteMessageId, fixture.tenantId, addedEvent.domainEventId],
                ),
              ).toEqual([{ outbox_message_id: obsoleteMessageId }]);
              expect(
                yield* query(
                  adminClient,
                  `delete from core.search_index_entries where search_index_entry_id = $1 and tenant_id = $2
                and source_module_key = 'party.registry' and source_resource_type = 'party.registry.counterparty'
                and source_resource_id = $3 and title = 'Synthetic stale fixture projection' and body_text = 'obsolete-fixture'
                  returning search_index_entry_id`,
                  [ownProjection['search_index_entry_id'], fixture.tenantId, own.counterpartyRef.resourceId],
                ),
              ).toEqual([{ search_index_entry_id: ownProjection['search_index_entry_id'] }]);
            }),
          );
          const obsoleteQueue = () =>
            query(
              adminClient,
              `select outbox_message_id from core.outbox_messages where outbox_message_id = $1
             union all select outbox_message_id from core.outbox_deliveries where outbox_delivery_id = $2`,
              [obsoleteMessageId, obsoleteDeliveryId],
            );
          expect(yield* obsoleteQueue()).toEqual([]);
          expect(yield* canonicalControls()).toEqual(beforeResetControls);
          expect(yield* foreignProjection()).toEqual(beforeForeignProjection);
          const afterResetEvidence = yield* fixture.evidence(coreAdmin);
          expect(afterResetEvidence.events).toEqual(beforeResetEvidence.events);
          expect(afterResetEvidence.audits).toEqual(beforeResetEvidence.audits);
          expect(yield* search(sharedIco)).toEqual([]);
          yield* rebuildAndProject(
            'party.registry.project-contact-point-added-to-search',
            'contactPointRef',
            contactPoint.contactPointRef.resourceId,
          );
          expect((yield* search(sharedIco)).map(({ ref }) => ref)).toEqual([own.counterpartyRef]);
          expect(yield* search('identity-runtime@example.test')).toEqual([]);
          const afterResetDenial = yield* runAction({
            registration: requestSearchRebuildAction,
            payload: {},
            principal: deniedPrincipal,
            transport: yield* freshTransport,
          }).pipe(Effect.provideContext(fixtureContext), Effect.flip);
          assert.isOk(Predicate.isTagged(afterResetDenial, 'ActionPermissionDenied'));
          expect(yield* canonicalControls()).toEqual(beforeResetControls);
          expect(yield* foreignProjection()).toEqual(beforeForeignProjection);
          expect(yield* obsoleteQueue()).toEqual([]);
          const afterRebuildEvidence = yield* fixture.evidence(coreAdmin);
          expect(afterRebuildEvidence.events).toEqual(expect.arrayContaining(beforeResetEvidence.events));
          expect(afterRebuildEvidence.audits).toEqual(expect.arrayContaining(beforeResetEvidence.audits));
        }),
      ),
    { timeout: 120_000 },
  );

  suite.effect(
    'completes a Party search projection cycle through the worker entry layers on the worker identity',
    () =>
      Effect.scoped(
        Effect.gen(function* workerIdentityRuntimeEffect() {
          const connections = yield* loadDatabaseIdentityConnections({
            enrollment: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
            envPath: '/dev/null',
          });
          const admin = yield* makeTestPgClient(connections.admin.connectionString, { maxConnections: 1 });
          const compositionRevision = (yield* partyCompositionSnapshot).composition.revision;
          const [tenantId, partyId] = yield* Effect.all([nextUuid, nextUuid]);
          yield* Effect.addFinalizer(() => purgeWorkerTenant(admin, tenantId).pipe(Effect.orDie));

          yield* query(
            admin,
            `insert into core.tenants (tenant_id, slug, name, status, default_locale)
             values ($1, $2, 'Party identity runtime', 'active', 'en')`,
            [tenantId, `party-identity-runtime-${tenantId}`],
          );
          yield* query(
            admin,
            `insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, 'party.registry', 'active')`,
            [tenantId],
          );
          yield* query(
            admin,
            `insert into party.parties (party_id, tenant_id, current_type, current_display_name)
             values ($1, $2, 'ORGANIZATION', 'Identity Runtime Org')`,
            [partyId, tenantId],
          );
          const payload = {
            partyRef: {
              moduleId: 'party.registry',
              resourceId: partyId,
              resourceType: 'party.registry.party',
              tenantId,
            },
          };
          const [event] = yield* query(
            admin,
            `insert into core.domain_events (tenant_id, producer_module_key, event_type, subject_module_key,
               subject_resource_type, subject_resource_id, payload_json)
             values ($1, 'party.registry', $2, 'party.registry', 'party.registry.party', $3, $4::jsonb)
             returning domain_event_id`,
            [tenantId, partyCreatedTopic, partyId, encodeJson(payload)],
          );
          assert.isOk(event);
          yield* query(
            admin,
            `insert into core.outbox_messages (tenant_id, domain_event_id, producer_module_key, topic, payload_json)
             values ($1, $2, 'party.registry', $3, $4::jsonb)`,
            [tenantId, event['domain_event_id'], partyCreatedTopic, encodeJson(payload)],
          );

          const { cycle, matched } = yield* runPartyWorkerCycle(compositionRevision);
          expect(matched.deliveriesCreated).toBeGreaterThanOrEqual(1);
          expect(cycle.succeeded).toBeGreaterThanOrEqual(1);

          const deliveries = yield* query(
            admin,
            `select delivery.status, delivery.worker_key
               from core.outbox_deliveries delivery
               join core.outbox_messages message using (outbox_message_id)
              where message.tenant_id = $1`,
            [tenantId],
          );
          expect(deliveries).toEqual([
            { worker_key: 'party.registry.project-party-created-to-search', status: 'done' },
          ]);
          const projected = yield* query(
            admin,
            `select source_resource_id from core.search_index_entries
              where tenant_id = $1 and source_module_key = 'party.registry'`,
            [tenantId],
          );
          expect(projected.map((row) => row['source_resource_id'])).toContain(partyId);
        }),
      ),
    { timeout: 60_000 },
  );
});
