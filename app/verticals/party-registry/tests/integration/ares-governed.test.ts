import { assert, expect, it } from 'effect-rstest';

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
  Option,
  Redacted,
  Schema,
  Predicate,
} from 'effect';
import { FetchHttpClient, HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
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
const endPool = (pool: Pool) => Effect.promise(() => pool.end());

it.live(
  'exported ARES coordinator uses real authorized HTTP commands, canonical persistence and reviewed correction',
  () =>
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
        endPool,
      );
      const admin = yield* makeTestDatabaseFromPool(pool, partyRelations);
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const kid = `ares-live-${randomUUID()}`;
      const issuer = 'https://disposable-shell.ontos.test';
      const publicJwk = yield* Effect.promise(exportJWK.bind(undefined, publicKey));
      const jwk = { ...publicJwk, alg: 'EdDSA', kid, use: 'sig' };
      const encodedPublicJwks = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [jwk],
      });
      const sign = (principal: typeof fixture.manager) =>
        Effect.promise(() =>
          new SignJWT({ principal, ver: 1 })
            .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
            .setIssuer(issuer)
            .setAudience('party-registry')
            .setSubject(principal.principalId)
            .setIssuedAt()
            .setExpirationTime('5m')
            .setJti(randomUUID())
            .sign(privateKey),
        );
      const authorization = () =>
        sign(fixture.manager).pipe(Effect.map((token) => `Bearer ${token}`));
      const gateway = makeOperationGateway(() =>
        sign(fixture.manager).pipe(
          Effect.map((signedToken) => ({ expiresAt: 0, token: signedToken })),
        ),
      );
      let providerRequests = 0;
      const provider = HttpClient.make((request, url) => {
        expect(url.href).toBe(
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
        (resource) => Effect.promise(resource.dispose.bind(resource)).pipe(Effect.orDie),
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
        expect(created.outcome).toBe('AMBIGUOUS');
        assert.isOk(created.outcome === 'AMBIGUOUS');

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
        assert.isOk(reviewed.partyRef);

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
      const replayAuthorization = yield* authorization();
      const replayLookup = () =>
        runHttpEffect(
          executeAresLookupWithAuthorization(
            { ico: lookupIco },
            replayAuthorization,
            randomUUID(),
            { baseUrl },
          ),
        );
      yield* replayLookup();
      const providerRequestsBeforeReplay = providerRequests;
      const replayRejected = yield* replayLookup().pipe(
        Effect.as(false),
        Effect.catchTag('AresLookupAuthenticationProblem', () => Effect.succeed(true)),
      );
      expect(replayRejected).toBe(true);
      expect(providerRequests).toBe(providerRequestsBeforeReplay);
      const observation = yield* lookup();
      const encodedObservation = yield* Schema.encodeEffect(AresSubjectEvidenceSchema)(observation);
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
      assert.isOk(
        'failure' in unconfirmed &&
          Predicate.isTagged(unconfirmed.failure, 'AresApplySelectionInvalid'),
      );

      const afterUnconfirmed = yield* state();
      expect(afterUnconfirmed.core.invocations.length).toBe(
        beforeUnconfirmed.core.invocations.length,
      );
      const applied = yield* runHttpEffect(applyAresObservation(request, { gateway, baseUrl }));
      const appliedMessage = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        applied,
      );
      assert.isOk(Predicate.isTagged(applied, 'AresApplyCompleted'), appliedMessage);

      expect(applied.completed.length).toBe(3);
      const persisted = yield* state();
      expect(persisted.claims.length).toBe(1);
      expect(persisted.contacts.length).toBe(1);
      const identifierEvidence = persisted.identifiers[0]?.externalEvidence;
      const contactEvidence = persisted.contacts[0]?.externalEvidence;
      expect(identifierEvidence?.queryIco).toBe('27074358');
      expect(identifierEvidence?.observedAt).toBe(encodedObservation.observedAt);
      expect(identifierEvidence?.servedAt).toBe(encodedObservation.servedAt);
      expect(identifierEvidence?.providerChangedOn).toBe(encodedObservation.providerChangedOn);
      expect(identifierEvidence?.providerRecordRef).toBe(encodedObservation.providerRecordRef);
      expect(contactEvidence?.observedAt).toBe(encodedObservation.observedAt);
      expect(contactEvidence?.providerChangedOn).toBe(encodedObservation.providerChangedOn);
      expect(contactEvidence?.providerRecordRef).toBe(encodedObservation.providerRecordRef);
      expect(
        persisted.assertions.find((item) => item.factKind === 'DISPLAY_NAME')?.externalEvidence
          ?.decidedAt,
      ).toBe(encodedObservation.servedAt);
      expect(persisted.core.events.length).toBe(4);
      expect(persisted.core.outbox.length).toBe(4);
      assert.isOk(persisted.core.invocations.every((item) => item.status === 'succeeded'));

      const replay = yield* runHttpEffect(applyAresObservation(request, { gateway, baseUrl }));
      assert.isOk(Predicate.isTagged(replay, 'AresApplyCompleted'));

      expect(replay.completed.length).toBe(0);
      expect(replay.skipped.length).toBe(3);
      const afterReplay = yield* state();
      expect(afterReplay.core.events.length).toBe(persisted.core.events.length);
      const deniedGateway = makeOperationGateway(() =>
        sign(fixture.denied).pipe(
          Effect.map((signedToken) => ({ expiresAt: 0, token: signedToken })),
        ),
      );
      const denied = yield* runHttpEffect(
        applyAresObservation(request, { gateway: deniedGateway, baseUrl }).pipe(Effect.result),
      );
      assert.isOk(
        'failure' in denied && Predicate.isTagged(denied.failure, 'AresLookupForbiddenProblem'),
      );

      const afterDenied = yield* state();
      expect(afterDenied.core.invocations.length).toBe(persisted.core.invocations.length);

      const collisionParty = yield* create();
      const collision = yield* runHttpEffect(
        applyAresObservation(requestFor(collisionParty), { gateway, baseUrl }),
      );
      const collisionOutcome = Match.value(collision).pipe(
        Match.tag('AresApplyPartiallyCompleted', (outcome) => outcome),
        Match.orElse(() => assert.fail(`Expected partial completion, received ${collision._tag}`)),
      );
      expect(collisionOutcome.completed.length).toBe(1);
      expect(collisionOutcome.failed.fact).toBe('ICO');
      expect(collisionOutcome.failed.recovery).toBe('RESOLVE_STANDARD_ACTION_BEFORE_RETRY');
      const afterCollision = yield* state();
      expect(afterCollision.claims.length).toBe(1);
      expect(afterCollision.contacts.length).toBe(1);
      const collisionDetail = yield* detail(collisionParty);
      expect(Option.getOrUndefined(collisionDetail.party.displayName)).toBe(
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
      assert.isOk(decision);

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
      assert.isOk(assertion);

      const correctionPayload = yield* Schema.decodeUnknownEffect(IdentityCorrectionCommandSchema)({
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
      expect(reviewOutcome.application.outcome).toBe('CORRECTION_CANDIDATE');
      expect(reviewOutcome.correctionCandidates[0]?.targetAssertionId).toBe(assertion.assertionId);
      const afterReview = yield* state();
      expect(afterReview.core.invocations.length).toBe(beforeReview.core.invocations.length);
      yield* runHttpEffect(
        correctPartyFactWithAuthorization(correctionPayload, yield* authorization(), options()),
      );
      const corrected = yield* detail(erroneousParty);
      expect(Option.getOrUndefined(corrected.party.displayName)).toBe(rawSubject.obchodniJmeno);
      const correctedState = yield* state();
      assert.isOk(
        correctedState.assertions.some(
          (item) => item.assertionId === assertion.assertionId && item.state !== 'ACTIVE',
        ),
      );

      assert.isOk(providerRequests >= 1);
    }),
);
