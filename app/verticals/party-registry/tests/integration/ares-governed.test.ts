import {
  makeEffectTestCallback as nativeTestCallback,
  runEffectTestPromise,
  runEffectTestSync as runNativeSync,
} from '@app/core-runtime/testing/effect-runtime';
import { DatabaseConfig, loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';

import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { eq } from 'drizzle-orm';
import {
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Exit as NativeExit,
  Scope as NativeScope,
  Option,
  Redacted,
  Schema,
} from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after as afterNativeDatabase } from 'node:test';
import { Pool } from 'pg';
import { makeTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { aresLookupReadApiLive } from '../../api/ares-lookup-read-server.ts';
import { ActionPrincipalVerifierLive } from '../../api/auth/action-principal.ts';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { partyRegistryCommandsLive } from '../../api/party-command-server.ts';
import { partyContactPointsReadApiLive } from '../../api/party-contact-points-read-server.ts';
import { partyDetailReadApiLive } from '../../api/party-detail-read-server.ts';
import { partyOfficialIdentifierHistoryReadApiLive } from '../../api/party-official-identifier-history-read-server.ts';
import { partyRegistryApi } from '../../shared/api.ts';
import {
  deriveAresEvidenceApplication,
  makeAresAppliedEvidence,
} from '../../shared/domain/ares-application.ts';
import {
  AresSubjectEvidenceSchema,
  AresSubjectLookupIcoSchema,
} from '../../shared/domain/ares-evidence.ts';
import { IdentityCorrectionCommandSchema } from '../../shared/domain/correction-contracts.ts';
import { partySubjectKeyFromString } from '../../shared/domain/identity-contracts.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { correctPartyFactAction } from '../../src/actions/correct-party-fact.action.ts';
import { createPartyAction } from '../../src/actions/create-party.action.ts';
import { resolveDuplicateCandidateCreateAction } from '../../src/actions/resolve-duplicate-candidate-create.action.ts';
import { updatePartyAction } from '../../src/actions/update-party.action.ts';
import type { AresApplyRequest } from '../../src/api/action-gateway.ts';
import { makeOperationGateway } from '../../src/api/action-gateway.ts';
import { executeAresLookupWithAuthorization } from '../../src/api/ares-lookup-client.ts';
import {
  correctPartyFactWithAuthorization,
  createPartyWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  updatePartyWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executePartyDetailWithAuthorization } from '../../src/api/party-detail-client.ts';
import { applyAresObservation } from '../../src/api/party-registry-client.ts';
import {
  partyContactPoints,
  partyFactAssertions,
  partyIdentifierClaims,
  partyOfficialIdentifiers,
  partyRelations,
} from '../../src/db/schema.ts';
import { AresSubjectServiceLive } from '../../src/integrations/ares/ares-subject.service.ts';

const nativeDatabaseScope = runNativeSync(NativeScope.make());
afterNativeDatabase(
  NativeScope.close(nativeDatabaseScope, NativeExit.void).pipe(nativeTestCallback),
);

const subjectEvidence = [
  {
    kind: 'ACTOR_ATTESTATION' as const,
    basis: 'REVIEWED_DOCUMENT' as const,
    evidenceRef: 'live-review/ares',
    observedSubject: 'ORGANIZATION' as const,
    subjectKey: 'external-subject',
    statement: 'Reviewed a concrete external organization in its document',
  },
];
const rawSubject = {
  datumAktualizace: '2026-09-01',
  datumVzniku: '2020-01-01',
  ico: '27074358',
  icoId: 'live-provider-record',
  obchodniJmeno: 'Governed ARES organization',
  pravniForma: '112',
  sidlo: {
    cisloDomovni: 10,
    kodStatu: 'CZ',
    nazevObce: 'Praha',
    nazevUlice: 'Main',
    psc: '11000',
    textovaAdresa: 'Main 10, Praha',
  },
};
const emptyRequestContext = Context.makeUnsafe<unknown>(new Map());
const lookupIco = Schema.decodeUnknownSync(AresSubjectLookupIcoSchema)('27074358');
const endPool = (pool: Pool) => pool.end();
const promiseEffect = <Value>(operation: () => PromiseLike<Value>) => Effect.promise(operation);

test('exported ARES coordinator uses real authorized HTTP commands, canonical persistence and reviewed correction', () =>
  runEffectTestPromise(
    Effect.scoped(
      Effect.gen(function* aresGovernedTestEffect() {
        const connections = yield* loadDatabaseConnectionPair();
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [
              addContactPointAction,
              addPartyOfficialIdentifierAction,
              correctPartyFactAction,
              createPartyAction,
              resolveDuplicateCandidateCreateAction,
              updatePartyAction,
            ].map(({ descriptor }) => descriptor.actionKey),
            runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
          }).pipe(Effect.orDie),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const pool = yield* Effect.acquireRelease(
          Effect.sync(() => new Pool({ connectionString: connections.admin.connectionString })),
          (resource) => promiseEffect(endPool.bind(undefined, resource)).pipe(Effect.orDie),
        );
        const admin = yield* makeTestDatabaseFromPool(pool, partyRelations).pipe(
          NativeScope.provide(nativeDatabaseScope),
        );
        const { privateKey, publicKey } = yield* promiseEffect(
          generateKeyPair.bind(undefined, 'Ed25519'),
        );
        const kid = `ares-live-${randomUUID()}`;
        const issuer = 'https://disposable-shell.ontos.test';
        const publicJwk = yield* promiseEffect(exportJWK.bind(undefined, publicKey));
        const jwk = { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' };
        const encodedPublicJwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          { keys: [jwk] },
        );
        const sign = (principal: typeof fixture.manager) =>
          new SignJWT({ principal, ver: 1 })
            .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience('party-registry')
            .setSubject(principal.principalId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .setJti(randomUUID())
            .sign(privateKey);
        const authorization = () =>
          promiseEffect(sign.bind(undefined, fixture.manager)).pipe(
            Effect.map((signedToken) => `Bearer ${signedToken}`),
          );
        const gateway = makeOperationGateway(() =>
          promiseEffect(sign.bind(undefined, fixture.manager)).pipe(
            Effect.map((signedToken) => ({ expiresAt: 0, token: signedToken })),
          ),
        );
        let providerRequests = 0;
        const provider = HttpClient.make((request, url) => {
          assert.equal(
            url.href,
            'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/27074358',
          );
          providerRequests += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(rawSubject)));
        });
        const upstream = AresSubjectServiceLive.pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, provider)),
        );
        const redemption = GatewayAssertionRedemptionLive.pipe(
          Layer.provide(GatewayAssertionRedemptionDatabaseLive),
          Layer.provide(Layer.succeed(DatabaseConfig, connections.runtime)),
        );
        const api = HttpApi.make('PartyRegistryApi')
          .add(partyRegistryApi.groups.partyCommands)
          .add(partyRegistryApi.groups.aresLookup)
          .add(partyRegistryApi.groups.partyDetail)
          .add(partyRegistryApi.groups.partyOfficialIdentifierHistory)
          .add(partyRegistryApi.groups.partyContactPoints);
        const handlers = Layer.mergeAll(
          partyRegistryCommandsLive,
          partyDetailReadApiLive,
          partyOfficialIdentifierHistoryReadApiLive,
          partyContactPointsReadApiLive,
          aresLookupReadApiLive.pipe(Layer.provide(upstream)),
        ).pipe(
          Layer.provide(ActionPrincipalVerifierLive),
          Layer.provide(redemption),
          Layer.provide(fixture.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ONTOS_GATEWAY_ISSUER: issuer,
                ONTOS_GATEWAY_PUBLIC_JWKS: encodedPublicJwks,
              }),
            ),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(api).pipe(
                Layer.provide(handlers),
                Layer.provideMerge(fixture.layer),
                Layer.provideMerge(upstream),
                Layer.provide(HttpServer.layerServices),
              ),
              { disableLogger: true },
            ),
          ),
          (resource) => promiseEffect(resource.dispose.bind(resource)).pipe(Effect.orDie),
        );
        const inMemoryFetch: typeof fetch = (input, init) =>
          app.handler(new Request(input, init), emptyRequestContext);
        const runHttpEffect = <Success, Failure>(effect: Effect.Effect<Success, Failure>) =>
          effect.pipe(Effect.provideService(FetchHttpClient.Fetch, inMemoryFetch));
        const baseUrl = 'https://party.ontos.test';
        const options = () => ({
          baseUrl,
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
        const create = Effect.fn('AresGovernedTest.create')(function* createEffect() {
          const created = yield* runHttpEffect(
            createPartyWithAuthorization(
              {
                candidate: {
                  partyType: 'ORGANIZATION',
                  officialIdentifiers: [],
                  evidenceRefs: ['live-review/ares'],
                  subjectEvidence: subjectEvidence.map((item) => ({
                    ...item,
                    subjectKey: partySubjectKeyFromString(randomUUID()),
                  })),
                  provenance: { method: 'DOCUMENT', source: 'live-acceptance' },
                  validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
                },
              },
              yield* authorization(),
              options(),
            ),
          );
          assert.equal(created.outcome, 'AMBIGUOUS');
          assert.ok(created.outcome === 'AMBIGUOUS');
          const reviewed = yield* runHttpEffect(
            resolveDuplicateCandidateCreateWithAuthorization(
              {
                caseRef: created.caseRef,
                expectedRevision: 1,
                reason: 'Reviewed concrete organization without a strong identifier',
              },
              yield* authorization(),
              options(),
            ),
          );
          assert.ok(reviewed.partyRef);
          return reviewed.partyRef;
        });
        const lookup = Effect.fn('AresGovernedTest.lookup')(function* lookupEffect() {
          return yield* runHttpEffect(
            executeAresLookupWithAuthorization(
              { ico: lookupIco },
              yield* authorization(),
              randomUUID(),
              { baseUrl },
            ),
          );
        });
        const detail = Effect.fn('AresGovernedTest.detail')(function* detailEffect(
          partyRef: PartyRef,
        ) {
          return yield* runHttpEffect(
            executePartyDetailWithAuthorization(
              { partyRef, includeFactHistory: true },
              yield* authorization(),
              randomUUID(),
              { baseUrl },
            ),
          );
        });
        const state = Effect.fn('AresGovernedTest.state')(() =>
          Effect.all(
            {
              assertions: admin
                .select()
                .from(partyFactAssertions)
                .where(eq(partyFactAssertions.tenantId, fixture.tenantId)),
              claims: admin
                .select()
                .from(partyIdentifierClaims)
                .where(eq(partyIdentifierClaims.tenantId, fixture.tenantId)),
              contacts: admin
                .select()
                .from(partyContactPoints)
                .where(eq(partyContactPoints.tenantId, fixture.tenantId)),
              core: fixture.evidence(),
              identifiers: admin
                .select()
                .from(partyOfficialIdentifiers)
                .where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId)),
            },
            { concurrency: 5 },
          ),
        );
        const partyRef = yield* create();
        const observation = yield* lookup();
        const encodedObservation =
          yield* Schema.encodeEffect(AresSubjectEvidenceSchema)(observation);
        const requestFor = (target: PartyRef): AresApplyRequest => ({
          correlationId: randomUUID(),
          observation: encodedObservation,
          partyRef: target,
          userConfirmed: true,
          selections: [
            {
              fact: 'BUSINESS_NAME',
              route: 'PARTY_UPDATE',
              idempotencyKey: randomUUID(),
              payload: {
                partyRef: target,
                displayName: rawSubject.obchodniJmeno,
                expectedRevision: 1,
                validFrom: observation.observedAt,
                provenanceMethod: 'ARES_USER_CONFIRMED',
                provenanceSource: 'ARES',
              },
            },
            {
              fact: 'ICO',
              route: 'IDENTIFIER_ADD',
              idempotencyKey: randomUUID(),
              payload: {
                partyRef: target,
                identifier: { identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' },
                validFrom: observation.observedAt,
                provenanceMethod: 'ARES_USER_CONFIRMED',
                provenanceSource: 'ARES',
              },
            },
            {
              fact: 'REGISTERED_ADDRESS',
              route: 'CONTACT_POINT_ADD',
              idempotencyKey: randomUUID(),
              payload: {
                partyRef: target,
                privacyClassification: 'PUBLIC',
                validFrom: observation.observedAt,
                contactPoint: {
                  type: 'ADDRESS',
                  address: {
                    addressLine1: 'Main 10',
                    city: 'Praha',
                    countryCode: 'CZ',
                    postalCode: '11000',
                  },
                  purposes: [
                    {
                      preferred: false,
                      purpose: 'REGISTERED',
                      registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
                    },
                  ],
                },
                provenance: {
                  authoritative: true,
                  evidenceReference: 'live-review/ares',
                  method: 'PROVIDER_OBSERVATION',
                  source: 'EXTERNAL_EVIDENCE',
                },
                verification: { state: 'UNVERIFIED' },
              },
            },
          ],
        });
        const request = requestFor(partyRef);
        const beforeUnconfirmed = yield* state();
        const unconfirmed = yield* runHttpEffect(
          applyAresObservation({ ...request, userConfirmed: false }, { gateway, baseUrl }).pipe(
            Effect.result,
          ),
        );
        assert.equal(
          'failure' in unconfirmed && unconfirmed.failure._tag,
          'AresApplySelectionInvalid',
        );
        const afterUnconfirmed = yield* state();
        assert.equal(
          afterUnconfirmed.core.invocations.length,
          beforeUnconfirmed.core.invocations.length,
        );
        const applied = yield* runHttpEffect(applyAresObservation(request, { gateway, baseUrl }));
        const appliedMessage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          applied,
        );
        assert.equal(applied._tag, 'AresApplyCompleted', appliedMessage);
        assert.equal(applied.completed.length, 3);
        const persisted = yield* state();
        assert.equal(persisted.claims.length, 1);
        assert.equal(persisted.contacts.length, 1);
        const identifierEvidence = persisted.identifiers[0]?.externalEvidence;
        const contactEvidence = persisted.contacts[0]?.externalEvidence;
        assert.equal(identifierEvidence?.queryIco, '27074358');
        assert.equal(identifierEvidence?.observedAt, encodedObservation.observedAt);
        assert.equal(identifierEvidence?.servedAt, encodedObservation.servedAt);
        assert.equal(identifierEvidence?.providerChangedOn, encodedObservation.providerChangedOn);
        assert.equal(identifierEvidence?.providerRecordRef, encodedObservation.providerRecordRef);
        assert.equal(contactEvidence?.observedAt, encodedObservation.observedAt);
        assert.equal(contactEvidence?.providerChangedOn, encodedObservation.providerChangedOn);
        assert.equal(contactEvidence?.providerRecordRef, encodedObservation.providerRecordRef);
        assert.equal(
          persisted.assertions.find((item) => item.factKind === 'DISPLAY_NAME')?.externalEvidence
            ?.decidedAt,
          encodedObservation.servedAt,
        );
        assert.equal(persisted.core.events.length, 4);
        assert.equal(persisted.core.outbox.length, 4);
        assert.ok(persisted.core.invocations.every((item) => item.status === 'succeeded'));
        const replay = yield* runHttpEffect(applyAresObservation(request, { gateway, baseUrl }));
        assert.equal(replay._tag, 'AresApplyCompleted');
        assert.equal(replay.completed.length, 0);
        assert.equal(replay.skipped.length, 3);
        const afterReplay = yield* state();
        assert.equal(afterReplay.core.events.length, persisted.core.events.length);
        const deniedGateway = makeOperationGateway(() =>
          promiseEffect(sign.bind(undefined, fixture.denied)).pipe(
            Effect.map((signedToken) => ({ expiresAt: 0, token: signedToken })),
          ),
        );
        const denied = yield* runHttpEffect(
          applyAresObservation(request, { gateway: deniedGateway, baseUrl }).pipe(Effect.result),
        );
        assert.equal('failure' in denied && denied.failure._tag, 'AresLookupForbiddenProblem');
        const afterDenied = yield* state();
        assert.equal(afterDenied.core.invocations.length, persisted.core.invocations.length);

        const collisionParty = yield* create();
        const collision = yield* runHttpEffect(
          applyAresObservation(requestFor(collisionParty), { gateway, baseUrl }),
        );
        const collisionOutcome = Match.value(collision).pipe(
          Match.tag('AresApplyPartiallyCompleted', (outcome) => outcome),
          Match.orElse(() =>
            assert.fail(`Expected partial completion, received ${collision._tag}`),
          ),
        );
        assert.equal(collisionOutcome.completed.length, 1);
        assert.equal(collisionOutcome.failed.fact, 'ICO');
        assert.equal(collisionOutcome.failed.recovery, 'RESOLVE_STANDARD_ACTION_BEFORE_RETRY');
        const afterCollision = yield* state();
        assert.equal(afterCollision.claims.length, 1);
        assert.equal(afterCollision.contacts.length, 1);
        const collisionDetail = yield* detail(collisionParty);
        assert.equal(
          Option.getOrUndefined(collisionDetail.party.displayName),
          rawSubject.obchodniJmeno,
        );

        const erroneousParty = yield* create();
        const logical = deriveAresEvidenceApplication({
          canonical: {
            archived: false,
            displayName: null,
            icoValues: [],
            identityAmbiguous: false,
            partyType: 'ORGANIZATION',
            registeredAddresses: [],
          },
          decidedAt: encodedObservation.servedAt,
          evidence: encodedObservation,
          selectedFacts: ['BUSINESS_NAME'],
          userConfirmed: true,
        });
        const [decision] = logical.factDecisions;
        assert.ok(decision);
        yield* runHttpEffect(
          updatePartyWithAuthorization(
            {
              partyRef: erroneousParty,
              displayName: 'Clerical wrong name',
              expectedRevision: 1,
              validFrom: observation.observedAt,
              provenanceMethod: 'ARES_USER_CONFIRMED',
              provenanceSource: 'ARES',
              externalEvidence: makeAresAppliedEvidence(logical, decision),
            },
            yield* authorization(),
            options(),
          ),
        );
        const erroneous = yield* detail(erroneousParty);
        const assertion = erroneous.currentFactAssertions.find(
          (item) => item.factKind === 'DISPLAY_NAME',
        );
        assert.ok(assertion);
        const correctionPayload = yield* Schema.decodeUnknownEffect(
          IdentityCorrectionCommandSchema,
        )({
          partyId: erroneousParty.resourceId,
          factKind: 'DISPLAY_NAME' as const,
          targetAssertionId: assertion.assertionId,
          replacementValue: rawSubject.obchodniJmeno,
          evidenceRefs: ['live-review/ares'],
          evidenceSource: 'MANUAL_REVIEW' as const,
          policyVersion: 'party-correction.v1' as const,
          reasonCode: 'WRONG_IDENTITY_VALUE' as const,
          provenance: { method: 'DOCUMENT_REVIEW', source: 'live-acceptance' },
          subjectEvidence,
        });
        const beforeReview = yield* state();
        const review = yield* runHttpEffect(
          applyAresObservation(
            {
              correlationId: randomUUID(),
              observation: encodedObservation,
              partyRef: erroneousParty,
              userConfirmed: true,
              selections: [
                {
                  fact: 'BUSINESS_NAME',
                  route: 'PARTY_CORRECTION',
                  idempotencyKey: randomUUID(),
                  payload: correctionPayload,
                },
              ],
            },
            { gateway, baseUrl },
          ),
        );
        const reviewOutcome = Match.value(review).pipe(
          Match.tag('AresApplyDeferred', (outcome) => outcome),
          Match.orElse(() => assert.fail(`Expected deferred review, received ${review._tag}`)),
        );
        assert.equal(reviewOutcome.application.outcome, 'CORRECTION_CANDIDATE');
        assert.equal(
          reviewOutcome.correctionCandidates[0]?.targetAssertionId,
          assertion.assertionId,
        );
        const afterReview = yield* state();
        assert.equal(afterReview.core.invocations.length, beforeReview.core.invocations.length);
        yield* runHttpEffect(
          correctPartyFactWithAuthorization(correctionPayload, yield* authorization(), options()),
        );
        const corrected = yield* detail(erroneousParty);
        assert.equal(Option.getOrUndefined(corrected.party.displayName), rawSubject.obchodniJmeno);
        const correctedState = yield* state();
        assert.ok(
          correctedState.assertions.some(
            (item) => item.assertionId === assertion.assertionId && item.state !== 'ACTIVE',
          ),
        );
        assert.ok(providerRequests >= 1);
      }),
    ),
  ));
