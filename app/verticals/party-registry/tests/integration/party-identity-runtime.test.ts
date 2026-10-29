import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  loadDatabaseIdentityConnections,
  OutboxRuntime,
  ReadRuntime,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  runAction,
  DatabaseIdentityEnrollmentContext,
} from '@app/core-runtime';
import { extractOutboxWorkerSubscriptions } from '@app/core-runtime/outbox/worker';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import {
  addTestGatewayScopeGrantCleanup,
  registerTestGatewayScopeGrant,
} from '@app/core-runtime/testing/gateway-scope-grant';
import { trustVerifiedGatewayPrincipalContext } from '@app/core-runtime/auth/system-principal-context-provenance';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { Crypto, Effect, Layer, Predicate, Redacted, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import type { Row } from 'effect/sql/SqlConnection';

import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { testCoreDatabase, deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { makeTestPgClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { outboxTopic as partyCreatedTopic } from '../../shared/outbox/party-registry-party-created-v1.ts';
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
  officialIdentifiers: [{ identifierType: 'ICO', value: ico, verification: 'VERIFIED' }],
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
    const claimOwner = `party.registry-identity-runtime-${yield* nextUuid}`;
    const matched = yield* runtime.matchMessages({ compositionRevision });
    const cycle = yield* runtime.runCycle({
      claimOwner,
      compositionRevision,
      registrations: outboxWorkers,
      subscriptions: extractOutboxWorkerSubscriptions(outboxWorkers),
    });
    return { cycle, matched };
  });

/** One match + claim/handle/complete cycle over the Party Outbox Workers as `party_registry_worker`. */
const runPartyWorkerCycle = (compositionRevision: string) =>
  Effect.gen(function* runPartyWorkerCycleEffect() {
    const workerContext = yield* Layer.build(partyWorkerRuntimeLive);
    return yield* runCycleOnce(compositionRevision).pipe(Effect.provideContext(workerContext));
  });

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const query = (client: PgClient.PgClient, statement: string, parameters: readonly unknown[] = []) =>
  client.unsafe<Row>(statement, parameters);

/**
 * Each integration file's setup republishes the composition authority and resets its
 * subscriptions, so a test re-applies the Party subscriptions right before a worker cycle matches.
 */
const applyPartyWorkerSubscriptions = (admin: PgClient.PgClient) =>
  query(
    admin,
    `update core.application_composition_authority set subscriptions_json = $1::jsonb
      where authority_key = 'active'`,
    [encodeJson(extractOutboxWorkerSubscriptions(outboxWorkers))],
  );

/**
 * Subscribes the active Application Composition to the Party Outbox Workers for this scope, as a
 * deployment with those workers would, and restores the previous subscriptions afterwards.
 */
const subscribePartyWorkers = (admin: PgClient.PgClient) =>
  Effect.gen(function* subscribePartyWorkersEffect() {
    const [previous] = yield* query(
      admin,
      `select subscriptions_json::text as subscriptions from core.application_composition_authority
        where authority_key = 'active'`,
    );
    assert.isOk(previous);
    yield* Effect.addFinalizer(() =>
      query(
        admin,
        `update core.application_composition_authority set subscriptions_json = $1::jsonb
          where authority_key = 'active'`,
        [previous['subscriptions']],
      ).pipe(Effect.orDie),
    );
    yield* applyPartyWorkerSubscriptions(admin);
  });

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
          const requestConnection = connections.runtime[PARTY_REGISTRY_REQUEST_IDENTITY.id];
          const issuerConnection = connections.runtime[SHELL_GATEWAY_ISSUER_IDENTITY.id];
          assert.isOk(requestConnection !== undefined);
          assert.isOk(issuerConnection !== undefined);
          const partyRuntimeConnectionString = requestConnection.connectionString;
          const issuerClient = yield* makeTestPgClient(issuerConnection.connectionString, { maxConnections: 1 });
          const compositionSnapshot = yield* partyCompositionSnapshot;
          const compositionRevision = compositionSnapshot.composition.revision;
          const actionKeys = [createPartyAction, counterpartyCreateAction, addContactPointAction].map(
            ({ descriptor }) => descriptor.actionKey,
          );
          const openFixture = Effect.acquireRelease(
            makeLiveOperationFixture({
              databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
              legalEntityManagerRelations: ['counterparty_manager', 'counterparty_reader'],
              tenantManagerRelations: [
                'party_identity_manager',
                'party_identity_reader',
                'party_identity_reviewer',
                'party_relationship_manager',
              ],
              actionKeys,
              adminConnectionString: Redacted.make(connections.admin.connectionString),
              audience: 'party-registry',
              authenticationNamespaceId: testAuthenticationNamespaceId,
              compositionRevision,
              moduleKey: 'party.registry',
              runtimeConnectionString: Redacted.make(partyRuntimeConnectionString),
            }).pipe(Effect.orDie),
            (resource) => resource.close().pipe(Effect.orDie),
          );
          const fixture = yield* openFixture;
          const other = yield* openFixture;
          const adminClient = yield* makeTestPgClient(connections.admin.connectionString);
          const coreAdmin = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, adminClient));
          yield* subscribePartyWorkers(adminClient);
          yield* addTestGatewayScopeGrantCleanup(adminClient, [fixture.tenantId, other.tenantId]);
          // Release only these disposable tenants' dispatch queues; retain append-only Core evidence.
          yield* Effect.addFinalizer(() =>
            Effect.forEach([fixture.tenantId, other.tenantId], (tenantId) =>
              deleteTestCoreOutbox(adminClient, tenantId),
            ).pipe(Effect.orDie),
          );
          const fixtureContext = yield* Layer.build(fixture.layer);
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
                  verification: { state: 'UNVERIFIED' },
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

          // A permission-denied Action changes nothing and leaves its rejection audit.
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
          yield* applyPartyWorkerSubscriptions(adminClient);
          yield* runPartyWorkerCycle(compositionRevision);
          const searchContext = yield* Layer.build(
            PartySearchProjectionGatewayLive.pipe(
              Layer.provide(CoreSearchQueryRuntimeLive),
              Layer.provide(CoreSearchProjectionStoreLive),
            ),
          ).pipe(
            Effect.provideContext(fixtureContext),
            Effect.provideService(DatabaseIdentityEnrollmentContext, PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT),
          );
          const hits = yield* Effect.all([ReadRuntime, freshReadTransport]).pipe(
            Effect.flatMap(([runtime, transport]) =>
              runtime.runRead({
                registration: counterpartiesRead,
                input: { query: sharedIco },
                principal: legalEntityPrincipal,
                transport,
              }),
            ),
            Effect.provideContext(searchContext),
            Effect.provideContext(fixtureContext),
          );
          const refs = hits.map(({ ref }) => ref);
          expect(refs).toContainEqual(own.counterpartyRef);
          expect(refs).not.toContainEqual(foreign.counterpartyRef);
          expect(refs.every((ref) => ref.tenantId === fixture.tenantId)).toBe(true);
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
          yield* subscribePartyWorkers(admin);

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
