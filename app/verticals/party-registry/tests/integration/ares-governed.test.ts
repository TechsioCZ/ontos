// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
/* eslint-disable unicorn/no-await-expression-member -- Live HTTP acceptance scenarios inspect each committed boundary. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { text as readText } from 'node:stream/consumers';
import test from 'node:test';
import { loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { partyRegistryApi } from '../../shared/api.ts';
import { partyRegistryCommandsLive } from '../../api/party-command-server.ts';
import { aresLookupReadApiLive } from '../../api/ares-lookup-read-server.ts';
import { partyDetailReadApiLive } from '../../api/party-detail-read-server.ts';
import { partyOfficialIdentifierHistoryReadApiLive } from '../../api/party-official-identifier-history-read-server.ts';
import { partyContactPointsReadApiLive } from '../../api/party-contact-points-read-server.ts';
import { AresSubjectServiceLive } from '../../src/integrations/ares/ares-subject.service.ts';
import { applyAresObservation } from '../../src/api/party-registry-client.ts';
import {
  makeAresAppliedEvidence,
  deriveAresEvidenceApplication,
} from '../../shared/domain/ares-application.ts';
import { makeActionGateway } from '../../src/api/action-gateway.ts';
import type { AresApplyRequest } from '../../src/api/action-gateway.ts';
import {
  createPartyWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  correctPartyFactWithAuthorization,
  updatePartyWithAuthorization,
} from '../../src/api/party-command-client.ts';
import { executeAresLookupWithAuthorization } from '../../src/api/ares-lookup-client.ts';
import { executePartyDetailWithAuthorization } from '../../src/api/party-detail-client.ts';
import {
  partyDatabaseSchema,
  partyFactAssertions,
  partyOfficialIdentifiers,
  partyIdentifierClaims,
  partyContactPoints,
} from '../../src/db/schema.ts';
import type { PartyRef } from '../../shared/resources/party.ts';

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

test('exported ARES coordinator uses real authorized HTTP commands, canonical persistence and reviewed correction', async () => {
  const connections = await Effect.runPromise(loadDatabaseConnectionPair());
  const fixture = await makeLiveOperationFixture({
    runtimeConnectionString: connections.runtime.connectionString,
  });
  const pool = new Pool({ connectionString: connections.admin.connectionString });
  const admin = drizzle({ client: pool, schema: partyDatabaseSchema });
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const kid = `ares-live-${randomUUID()}`;
  const issuer = 'https://disposable-shell.ontos.test';
  const jwk = { ...(await exportJWK(publicKey)), alg: 'EdDSA', kid, use: 'sig' };
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
  const token = await sign(fixture.manager);
  const authorization = `Bearer ${token}`;
  const gateway = makeActionGateway(() =>
    Effect.promise(async () => ({ expiresAt: 0, token: await sign(fixture.manager) })),
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
    Layer.provide(fixture.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ...process.env,
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [jwk] }),
        }),
      ),
    ),
  );
  const app = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(api).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(fixture.layer),
      Layer.provideMerge(upstream),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  const server = createServer(async (incoming, outgoing) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
    }
    const response = await app.handler(
      new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method ?? 'POST',
        headers,
        body: await readText(incoming),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(
    server.address(),
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const options = () => ({ baseUrl, correlationId: randomUUID(), idempotencyKey: randomUUID() });
  const create = async () => {
    const created = await Effect.runPromise(
      createPartyWithAuthorization(
        {
          candidate: {
            partyType: 'ORGANIZATION',
            officialIdentifiers: [],
            evidenceRefs: ['live-review/ares'],
            subjectEvidence: subjectEvidence.map((item) => ({ ...item, subjectKey: randomUUID() })),
            provenance: { method: 'DOCUMENT', source: 'live-acceptance' },
            validFrom: '2020-01-01T00:00:00.000Z',
          },
        },
        authorization,
        options(),
      ),
    );
    assert.equal(created.outcome, 'AMBIGUOUS');
    assert.ok(created.outcome === 'AMBIGUOUS');
    const reviewed = await Effect.runPromise(
      resolveDuplicateCandidateCreateWithAuthorization(
        {
          caseRef: created.caseRef,
          expectedRevision: 1,
          reason: 'Reviewed concrete organization without a strong identifier',
        },
        authorization,
        options(),
      ),
    );
    assert.ok(reviewed.partyRef);
    return reviewed.partyRef;
  };
  const lookup = () =>
    Effect.runPromise(
      executeAresLookupWithAuthorization({ ico: '27074358' }, authorization, randomUUID(), {
        baseUrl,
      }),
    );
  const detail = (partyRef: PartyRef) =>
    Effect.runPromise(
      executePartyDetailWithAuthorization(
        { partyRef, includeFactHistory: true },
        authorization,
        randomUUID(),
        { baseUrl },
      ),
    );
  const state = async () => ({
    assertions: await admin
      .select()
      .from(partyFactAssertions)
      .where(eq(partyFactAssertions.tenantId, fixture.tenantId)),
    identifiers: await admin
      .select()
      .from(partyOfficialIdentifiers)
      .where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId)),
    claims: await admin
      .select()
      .from(partyIdentifierClaims)
      .where(eq(partyIdentifierClaims.tenantId, fixture.tenantId)),
    contacts: await admin
      .select()
      .from(partyContactPoints)
      .where(eq(partyContactPoints.tenantId, fixture.tenantId)),
    core: await fixture.evidence(),
  });
  try {
    const partyRef = await create();
    const observation = await lookup();
    const requestFor = (target: PartyRef): AresApplyRequest => ({
      correlationId: randomUUID(),
      observation,
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
    const beforeUnconfirmed = await state();
    const unconfirmed = await Effect.runPromise(
      applyAresObservation({ ...request, userConfirmed: false }, { gateway, baseUrl }).pipe(
        Effect.result,
      ),
    );
    assert.equal('failure' in unconfirmed && unconfirmed.failure._tag, 'AresApplySelectionInvalid');
    assert.equal(
      (await state()).core.invocations.length,
      beforeUnconfirmed.core.invocations.length,
    );
    const applied = await Effect.runPromise(applyAresObservation(request, { gateway, baseUrl }));
    assert.equal(applied._tag, 'AresApplyCompleted', JSON.stringify(applied));
    assert.equal(applied.completed.length, 3);
    const persisted = await state();
    assert.equal(persisted.claims.length, 1);
    assert.equal(persisted.contacts.length, 1);
    assert.equal(persisted.identifiers[0]?.externalEvidence?.queryIco, '27074358');
    assert.equal(
      persisted.assertions.find((item) => item.factKind === 'DISPLAY_NAME')?.externalEvidence
        ?.decidedAt,
      observation.servedAt,
    );
    assert.equal(persisted.core.events.length, 4);
    assert.equal(persisted.core.outbox.length, 4);
    assert.ok(persisted.core.invocations.every((item) => item.status === 'succeeded'));
    const replay = await Effect.runPromise(applyAresObservation(request, { gateway, baseUrl }));
    assert.equal(replay._tag, 'AresApplyCompleted');
    assert.equal(replay.completed.length, 0);
    assert.equal(replay.skipped.length, 3);
    assert.equal((await state()).core.events.length, persisted.core.events.length);
    const deniedGateway = makeActionGateway(() =>
      Effect.promise(async () => ({ expiresAt: 0, token: await sign(fixture.denied) })),
    );
    const denied = await Effect.runPromise(
      applyAresObservation(request, { gateway: deniedGateway, baseUrl }).pipe(Effect.result),
    );
    assert.equal('failure' in denied && denied.failure._tag, 'AresLookupForbiddenProblem');
    assert.equal((await state()).core.invocations.length, persisted.core.invocations.length);

    const collisionParty = await create();
    const collision = await Effect.runPromise(
      applyAresObservation(requestFor(collisionParty), { gateway, baseUrl }),
    );
    assert.equal(collision._tag, 'AresApplyPartiallyCompleted', JSON.stringify(collision));
    assert.ok(collision._tag === 'AresApplyPartiallyCompleted');
    assert.equal(collision.completed.length, 1);
    assert.equal(collision.failed.fact, 'ICO');
    assert.equal(collision.failed.recovery, 'RESOLVE_STANDARD_ACTION_BEFORE_RETRY');
    const afterCollision = await state();
    assert.equal(afterCollision.claims.length, 1);
    assert.equal(afterCollision.contacts.length, 1);
    assert.equal((await detail(collisionParty)).party.displayName, rawSubject.obchodniJmeno);

    const erroneousParty = await create();
    const logical = deriveAresEvidenceApplication({
      canonical: {
        archived: false,
        displayName: null,
        icoValues: [],
        identityAmbiguous: false,
        partyType: 'ORGANIZATION',
        registeredAddresses: [],
      },
      decidedAt: observation.servedAt,
      evidence: observation,
      selectedFacts: ['BUSINESS_NAME'],
      userConfirmed: true,
    });
    const [decision] = logical.factDecisions;
    assert.ok(decision);
    await Effect.runPromise(
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
        authorization,
        options(),
      ),
    );
    const erroneous = await detail(erroneousParty);
    const assertion = erroneous.currentFactAssertions.find(
      (item) => item.factKind === 'DISPLAY_NAME',
    );
    assert.ok(assertion);
    const correctionPayload = {
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
    };
    const beforeReview = await state();
    const review = await Effect.runPromise(
      applyAresObservation(
        {
          correlationId: randomUUID(),
          observation,
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
    assert.equal(review._tag, 'AresApplyDeferred', JSON.stringify(review));
    assert.ok(review._tag === 'AresApplyDeferred');
    assert.equal(review.application.outcome, 'CORRECTION_CANDIDATE');
    assert.equal(review.correctionCandidates[0]?.targetAssertionId, assertion.assertionId);
    assert.equal((await state()).core.invocations.length, beforeReview.core.invocations.length);
    await Effect.runPromise(
      correctPartyFactWithAuthorization(correctionPayload, authorization, options()),
    );
    assert.equal((await detail(erroneousParty)).party.displayName, rawSubject.obchodniJmeno);
    assert.ok(
      (await state()).assertions.some(
        (item) => item.assertionId === assertion.assertionId && item.state !== 'ACTIVE',
      ),
    );
    assert.ok(providerRequests >= 1);
  } finally {
    await promisify(server.close.bind(server))();
    await app.dispose();
    await pool.end();
    await fixture.close();
  }
});
