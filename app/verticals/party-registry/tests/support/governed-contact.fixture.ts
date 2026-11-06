import type { DatabaseConnectionPair } from '@app/core-runtime';
import { PgClient } from '@effect/sql-pg';
import { DatabaseConfig, makeContextPermissionRelationshipMutationLive } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime/modules/active-application-composition';
import { makeActiveApplicationCompositionLayer } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { addTestGatewayScopeGrantCleanup } from '@app/core-runtime/testing/gateway-scope-grant';
import { deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { Reactivity } from 'effect/reactivity';
import { assert } from 'effect-rstest';

import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { partyContactPointDetailReadApiLive } from '../../api/party-contact-point-detail-read-server.ts';
import { partyContactPointsReadApiLive } from '../../api/party-contact-points-read-server.ts';
import { partyRegistryCommandsLive } from '../../api/party-command-server.ts';
import type { AddContactPointPayload } from '../../shared/actions/add-contact-point.ts';
import type { UpdateContactPointPayload } from '../../shared/actions/update-contact-point.ts';
import { partyRegistryApi } from '../../shared/api.ts';
import type { ContactPointProvenance } from '../../shared/domain/contact-point.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type { PartyContactPointRef } from '../../shared/resources/party-contact-point.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { updateContactPointAction } from '../../src/actions/update-contact-point.action.ts';
import {
  addContactPointWithAuthorization,
  createPartyWithAuthorization,
  updateContactPointWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executePartyContactPointDetailWithAuthorization } from '../../src/api/party-contact-point-detail-client.ts';
import { executePartyContactPointsWithAuthorization } from '../../src/api/party-contact-points-client.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';
import type { PartyReconciliationGateway } from './party-reconciliation-native.fixture.ts';

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const emptyContext = Context.makeUnsafe<unknown>(new Map());
const declared = {
  authoritative: false,
  method: 'DECLARED_BY_PARTY',
  source: 'PARTY_DECLARATION',
} satisfies ContactPointProvenance;

export const makeGovernedContactFixture = Effect.fn('GovernedContactFixture.make')(
  function* makeFixture(configuration: {
    readonly adminConnectionString: string;
    readonly composition: ActiveApplicationCompositionSnapshot;
    readonly gateway: PartyReconciliationGateway;
    readonly partyConfiguration: DatabaseConnectionPair['runtime'];
  }) {
    const { adminConnectionString, composition, gateway, partyConfiguration } = configuration;
    const adminContext = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(adminConnectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const adminClient = Context.get(adminContext, PgClient.PgClient);
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        access: 'allowed',
        actionKeys: [addContactPointAction, createPartyAction, updateContactPointAction].map(
          ({ descriptor }) => descriptor.actionKey,
        ),
        adminConnectionString: Redacted.make(adminConnectionString),
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        ownerRegistration: partyRegistryBackendRegistration,
        runtimeConnectionString: Redacted.make(partyConfiguration.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    yield* Effect.addFinalizer(() => deleteTestCoreOutbox(adminClient, fixture.tenantId).pipe(Effect.orDie));
    yield* addTestGatewayScopeGrantCleanup(adminClient, [fixture.tenantId]);
    const permissions = yield* makeContextPermissionRelationshipMutationLive();
    const modulePermission = {
      principal: fixture.manager,
      target: { moduleId: 'party.registry', permission: 'module.access' },
      tenantId: fixture.tenantId,
    };
    yield* permissions.mutate({ ...modulePermission, operation: 'grant' });
    yield* Effect.addFinalizer(() =>
      permissions.mutate({ ...modulePermission, operation: 'revoke' }).pipe(Effect.orDie),
    );
    const authorization = gateway.authorization(fixture.manager).pipe(Effect.orDie);
    const redemption = GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(Layer.succeed(DatabaseConfig, partyConfiguration)),
    );
    const api = HttpApi.make('PartyRegistryApi')
      .add(partyRegistryApi.groups.partyCommands)
      .add(partyRegistryApi.groups.partyContactPointDetail)
      .add(partyRegistryApi.groups.partyContactPoints);
    const handlers = Layer.mergeAll(
      partyRegistryCommandsLive,
      partyContactPointDetailReadApiLive,
      partyContactPointsReadApiLive,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          ActionPrincipalVerifierLive,
          makeActiveApplicationCompositionLayer(Effect.succeed(composition)),
        ).pipe(Layer.provide(ActiveApplicationCompositionSourceLive), Layer.provide(FetchHttpClient.layer)),
      ),
      Layer.provide(redemption),
      Layer.provide(fixture.layer),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ONTOS_GATEWAY_ISSUER: gateway.issuer, ONTOS_GATEWAY_PUBLIC_JWKS: gateway.jwks }),
        ),
      ),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(api).pipe(
            Layer.provide(handlers),
            Layer.provideMerge(fixture.layer),
            Layer.provide(HttpServer.layerServices),
            Layer.provide(NodeCrypto.layer),
          ),
          { disableLogger: true },
        ),
      ),
      (resource) => Effect.promise(resource.dispose.bind(resource)).pipe(Effect.orDie),
    );
    const fetch: typeof globalThis.fetch = (input, init) => app.handler(new Request(input, init), emptyContext);
    const runHttp = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
      operation.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    const readOptions = { baseUrl: 'https://party.ontos.test', compositionRevision: composition.composition.revision };
    const commandOptions = Effect.gen(function* commandOptions() {
      return { ...readOptions, correlationId: yield* nextId, idempotencyKey: yield* nextId };
    });
    const validFrom = DateTime.makeUnsafe('2020-01-01T00:00:00.000Z');
    const created = yield* runHttp(
      createPartyWithAuthorization(
        {
          candidate: {
            partyType: 'ORGANIZATION',
            businessName: 'Declared address organization',
            officialIdentifiers: [],
            evidenceRefs: ['fixture/organization-document'],
            subjectEvidence: [
              {
                basis: 'REVIEWED_DOCUMENT',
                evidenceRef: 'fixture/organization-document',
                kind: 'ACTOR_ATTESTATION',
                observedSubject: 'ORGANIZATION',
                statement: 'Reviewed the organization used to exercise address acceptance',
                subjectKey: partySubjectKeyFromString(yield* nextId),
              },
            ],
            provenance: { method: 'DOCUMENT', source: 'declared-address-fixture' },
            validFrom,
          },
        },
        yield* authorization,
        yield* commandOptions,
      ),
    );
    assert.isOk(created.outcome === 'CREATED');
    const { partyRef } = created;
    const add = Effect.fn('DeclaredRegisteredAddressTest.add')(function* add(
      contactPoint: AddContactPointPayload['contactPoint'],
      provenance: ContactPointProvenance = declared,
    ) {
      return yield* runHttp(
        addContactPointWithAuthorization(
          { contactPoint, partyRef, privacyClassification: 'BUSINESS_SENSITIVE', provenance, validFrom },
          yield* authorization,
          yield* commandOptions,
        ),
      );
    });
    const update = Effect.fn('DeclaredRegisteredAddressTest.update')(function* update(
      contactPoint: { contactPointRef: PartyContactPointRef; revision: number },
      change: UpdateContactPointPayload['change'],
    ) {
      return yield* runHttp(
        updateContactPointWithAuthorization(
          {
            contactPointRef: contactPoint.contactPointRef,
            expectedRevision: contactPoint.revision,
            change,
            provenance: declared,
          },
          yield* authorization,
          yield* commandOptions,
        ),
      );
    });
    const detail = Effect.fn('DeclaredRegisteredAddressTest.detail')(function* detail(
      contactPointRef: PartyContactPointRef,
    ) {
      return yield* runHttp(
        executePartyContactPointDetailWithAuthorization(
          { contactPointRef },
          yield* authorization,
          yield* nextId,
          readOptions,
        ),
      );
    });
    const list = Effect.fn('DeclaredRegisteredAddressTest.list')(function* list(includeHistorical: boolean) {
      return yield* runHttp(
        executePartyContactPointsWithAuthorization(
          { includeHistorical, partyRef, type: 'ADDRESS' },
          yield* authorization,
          yield* nextId,
          readOptions,
        ),
      );
    });
    return { add, update, detail, list, partyRef };
  },
  Effect.orDie,
);
