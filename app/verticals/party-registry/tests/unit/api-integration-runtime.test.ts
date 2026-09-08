// @effect-diagnostics asyncFunction:off cryptoRandomUUID:off nodeBuiltinImport:off -- Test-only HTTP/JWT fixture; expires: 2027-09-07.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ActionRuntime, GatewayAssertionRedemptionService, ReadRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/plugin-bff/effect-edge';
import { ConfigProvider, Context, Effect, Layer, Schema } from 'effect';
import * as FastCheck from 'fast-check';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makePartyRegistryApiRuntime, partyRegistryFoundationLive } from '../../api/index.ts';
import { partyRegistryApi, partyRegistryReadinessSchema } from '../../shared/api.ts';
import { PartyCommandInvalidRequestProblemSchema } from '../../shared/command-api.ts';
import { PartyDetailAuthenticationProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { AresSubjectService } from '../../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectServiceContract } from '../../src/integrations/ares/ares-subject.service.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  partyRegistryCorsAllowedHeaders,
  partyRegistryCorsAllowedMethods,
} from '../../api/read-server-support.ts';

const principal = {
  authBindingId: 'a1000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:party-runtime-assembly-test',
  authMethod: 'session',
  principalId: 'a2000000-0000-4000-8000-000000000001',
  tenantId: 'a3000000-0000-4000-8000-000000000001',
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: 'a4000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party',
  tenantId: principal.tenantId,
} as const;
const commaSeparatedHeader = (value: string | null): readonly string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .toSorted();
const makeAssertion = async () => {
  const issuer = 'https://shell.runtime-assembly.test';
  const { privateKey, publicKey } = await generateKeyPair('Ed25519');
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: 'EdDSA',
    kid: 'party-runtime-assembly-test',
    use: 'sig',
  };
  const token = await new SignJWT({ principal, ver: 1 })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'party-runtime-assembly-test', typ: 'JWT' })
    .setIssuer(issuer)
    .setAudience('party-registry')
    .setSubject(principal.principalId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(privateKey);
  return { issuer, publicJwks: JSON.stringify({ keys: [publicJwk] }), token };
};

test('serves readiness and rejects the removed placeholder write without business dependencies', async () => {
  const readinessApi = HttpApi.make('PartyRegistryApi').add(partyRegistryApi.groups.foundation);
  const server = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(readinessApi).pipe(
      Layer.provide(partyRegistryFoundationLive),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
  try {
    const response = await server.handler(
      new Request('http://localhost/party-registry/readiness'),
      Context.empty(),
    );
    assert.equal(response.status, 200);
    const readiness = Schema.decodeUnknownSync(partyRegistryReadinessSchema)(await response.json());
    assert.deepEqual(readiness.marker, ultramodernApiMarker);
    assert.equal(readiness.status, 'ready');

    const removedWrite = await server.handler(
      new Request('http://localhost/party-registry', {
        body: JSON.stringify({ name: 'Must not create an item' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      Context.empty(),
    );
    assert.equal(removedWrite.status, 404);
  } finally {
    await server.dispose();
  }
});

test('builds every declared handler and preserves owner-local CORS through the injectable runtime', async () => {
  const assertion = await makeAssertion();
  let redemptionCalls = 0;
  let actionCalls = 0;
  let actionCommitCalls = 0;
  let aresCalls = 0;
  let aresLayerLoads = 0;
  let counterpartySearchCalls = 0;
  let partySearchCalls = 0;
  let readCalls = 0;
  let searchLayerLoads = 0;
  const actionRuntime: ActionRuntimeService = {
    resolveActionCommit: () =>
      Effect.sync(() => {
        actionCommitCalls += 1;
        throw new Error('Action commit substitute reached through the assembled runtime');
      }),
    runAction: () =>
      Effect.sync(() => {
        actionCalls += 1;
        throw new Error('Action substitute reached through the assembled runtime');
      }),
  };
  const aresSubjectService = {
    subject: (_input) =>
      Effect.sync(() => {
        aresCalls += 1;
        throw new Error('ARES substitute reached through the assembled runtime');
      }),
  } satisfies AresSubjectServiceContract;
  const searchProjectionGateway = {
    searchCounterparties: (_input) =>
      Effect.sync(() => {
        counterpartySearchCalls += 1;
        throw new Error('Counterparty search substitute reached through the assembled runtime');
      }),
    searchParties: (_input) =>
      Effect.sync(() => {
        partySearchCalls += 1;
        throw new Error('Party search substitute reached through the assembled runtime');
      }),
  } satisfies PartySearchProjectionGatewayService;
  const readRuntime: ReadRuntimeService = {
    runRead: ({ registration }) =>
      Effect.context<never>().pipe(
        Effect.flatMap((context) => {
          readCalls += 1;
          if (registration.descriptor.readKey === 'party.registry.api.ares-lookup') {
            const service = Context.getOrUndefined(context, AresSubjectService);
            assert.ok(service !== undefined);
            return service
              .subject({
                correlationId: 'runtime-assembly-proof',
                ico: '27074358',
              })
              .pipe(
                Effect.orDie,
                Effect.andThen(Effect.die('ARES substitute completed unexpectedly')),
              );
          }
          if (registration.descriptor.readKey === 'party.registry.search.parties') {
            const service = Context.getOrUndefined(context, PartySearchProjectionGateway);
            assert.ok(service !== undefined);
            return service
              .searchParties({
                includeArchived: false,
                query: 'runtime assembly proof',
                tenantId: principal.tenantId,
              })
              .pipe(
                Effect.orDie,
                Effect.andThen(Effect.die('Party search substitute completed unexpectedly')),
              );
          }
          if (registration.descriptor.readKey === 'party.registry.search.counterparties') {
            const service = Context.getOrUndefined(context, PartySearchProjectionGateway);
            assert.ok(service !== undefined);
            return service
              .searchCounterparties({
                effectiveAt: '2026-09-07T00:00:00.000Z',
                includeArchived: false,
                legalEntityId: 'a5000000-0000-4000-8000-000000000001',
                query: 'runtime assembly proof',
                tenantId: principal.tenantId,
              })
              .pipe(
                Effect.orDie,
                Effect.andThen(Effect.die('Counterparty search substitute completed unexpectedly')),
              );
          }
          return Effect.die('Read substitute reached through the assembled runtime');
        }),
      ),
  };
  const actionRuntimeLayer = Layer.mergeAll(
    Layer.succeed(ActionRuntime, actionRuntime),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        ONTOS_GATEWAY_ISSUER: assertion.issuer,
        ONTOS_GATEWAY_PUBLIC_JWKS: assertion.publicJwks,
      }),
    ),
  );
  const aresSubjectLayer = Layer.effect(
    AresSubjectService,
    Effect.sync(() => {
      aresLayerLoads += 1;
      return aresSubjectService;
    }),
  );
  const searchProjectionLayer = Layer.effect(
    PartySearchProjectionGateway,
    Effect.sync(() => {
      searchLayerLoads += 1;
      return searchProjectionGateway;
    }),
  );
  const assembledRuntime = makePartyRegistryApiRuntime(
    Layer.succeed(ReadRuntime, readRuntime),
    aresSubjectLayer,
    searchProjectionLayer,
    actionRuntimeLayer,
    Layer.succeed(GatewayAssertionRedemptionService, {
      consume: () =>
        Effect.sync(() => {
          redemptionCalls += 1;
        }),
    }),
  );
  const runtime = assembledRuntime.createHandler();

  try {
    const unauthenticatedRead = await runtime.handler(
      new Request('http://localhost/reads/party-detail', {
        body: JSON.stringify({
          partyRef: {
            moduleId: 'party.registry',
            resourceId: 'a4000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party',
            tenantId: 'a3000000-0000-4000-8000-000000000001',
          },
        }),
        headers: {
          'content-type': 'application/json',
          'x-correlation-id': 'runtime-missing-credentials',
        },
        method: 'POST',
      }),
    );
    assert.equal(unauthenticatedRead.status, 401);
    assert.equal(redemptionCalls, 0);
    assert.equal(unauthenticatedRead.headers.get('www-authenticate'), 'Bearer');
    Schema.decodeUnknownSync(PartyDetailAuthenticationProblemSchema)(
      await unauthenticatedRead.json(),
    );

    const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
      Object.values(group.endpoints),
    );
    const headers = {
      authorization: `Bearer ${assertion.token}`,
      'content-type': 'application/json',
      'x-correlation-id': 'runtime-assembly-proof',
    };
    const counterpartyRef = {
      moduleId: 'party.registry',
      resourceId: 'a6000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.counterparty',
      tenantId: principal.tenantId,
    };
    const provenance = {
      evidenceReference: 'runtime-assembly-proof',
      method: 'TEST',
      source: 'runtime-assembly-proof',
    };
    const candidate = {
      displayName: 'Runtime assembly proof',
      evidenceRefs: ['document:verified'],
      officialIdentifiers: [],
      partyType: 'ORGANIZATION',
      provenance: { method: 'DOCUMENT', source: 'operator' },
      validFrom: '2026-09-07T00:00:00.000Z',
    };
    const contactPointRef = {
      moduleId: 'party.registry',
      resourceId: 'a9000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.party-contact-point',
      tenantId: principal.tenantId,
    };
    const contactPointProvenance = {
      authoritative: true,
      method: 'DOCUMENT_REVIEW',
      source: 'USER_ASSERTION',
    };
    const addContactPointPayload = {
      contactPoint: { preferred: false, type: 'EMAIL', value: 'contact@example.test' },
      partyRef,
      privacyClassification: 'PUBLIC',
      provenance: contactPointProvenance,
      validFrom: '2026-09-07T00:00:00.000Z',
      verification: { state: 'UNVERIFIED' },
    } as const;
    const invalidContactResponse = await runtime.handler(
      new Request('http://localhost/party-registry/actions/add-contact-point', {
        body: JSON.stringify({
          ...addContactPointPayload,
          contactPoint: { ...addContactPointPayload.contactPoint, value: 'not-an-email' },
        }),
        headers: { ...headers, 'idempotency-key': 'invalid-contact-point' },
        method: 'POST',
      }),
    );
    assert.equal(invalidContactResponse.status, 400);
    assert.match(
      invalidContactResponse.headers.get('content-type') ?? '',
      /application\/problem\+json/u,
    );
    Schema.decodeUnknownSync(PartyCommandInvalidRequestProblemSchema)(
      await invalidContactResponse.json(),
    );
    assert.equal(actionCalls, 0);
    assert.equal(redemptionCalls, 0);
    const manualPayloads = {
      '/party-registry/actions/add-contact-point': addContactPointPayload,
      '/party-registry/actions/add-party-official-identifier': {
        identifier: {
          identifierType: 'ICO',
          value: '27074358',
          verification: 'VERIFIED',
        },
        partyRef,
        provenanceMethod: 'DOCUMENT',
        provenanceSource: 'runtime-assembly-proof',
        validFrom: '2026-09-07T00:00:00.000Z',
      },
      '/party-registry/actions/counterparty-role-add': {
        counterpartyRef,
        provenance,
        roleType: 'CUSTOMER',
        validFrom: '2026-09-07T00:00:00.000Z',
      },
      '/party-registry/actions/counterparty-role-end': {
        counterpartyRef,
        provenance,
        rolePeriodRef: {
          moduleId: 'party.registry',
          resourceId: 'a7000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.counterparty-role-period',
          tenantId: principal.tenantId,
        },
        validTo: '2026-09-07T00:00:00.000Z',
      },
      '/party-registry/actions/create-party': { candidate },
      '/party-registry/actions/end-contact-point': {
        contactPointRef,
        effectiveEnd: '2026-09-07T00:00:00.000Z',
        provenance: contactPointProvenance,
        reason: 'Runtime assembly proof',
        target: { type: 'WHOLE_CONTACT_POINT' },
      },
      '/party-registry/actions/match-party': { candidate },
      '/party-registry/actions/update-party': {
        displayName: 'Updated runtime assembly proof',
        expectedRevision: 1,
        partyRef,
        provenanceMethod: 'DOCUMENT',
        provenanceSource: 'runtime-assembly-proof',
        validFrom: '2026-09-07T00:00:00.000Z',
      },
      '/party-registry/actions/update-contact-point': {
        change: { preferred: true, type: 'SET_CHANNEL_PREFERRED' },
        contactPointRef,
        expectedRevision: 1,
        provenance: contactPointProvenance,
      },
      '/party-registry/actions/update-party-official-identifier': {
        change: {
          expectedVerification: 'UNVERIFIED',
          type: 'SET_VERIFICATION',
          verification: 'VERIFIED',
        },
        evidenceRefs: ['document:verified'],
        officialIdentifierRef: {
          moduleId: 'party.registry',
          resourceId: 'a8000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party-official-identifier',
          tenantId: principal.tenantId,
        },
        reason: 'Runtime assembly proof',
      },
      '/party-registry/actions/update-party-relationship': {
        changeReason: 'Runtime assembly proof',
        expectedRevision: 1,
        provenance: { method: 'TEST', source: 'runtime-assembly-proof' },
        relationshipRef: {
          moduleId: 'party.registry',
          resourceId: 'aa000000-0000-4000-8000-000000000001',
          resourceType: 'party.registry.party-relationship',
          tenantId: principal.tenantId,
        },
      },
      '/reads/party-match': { candidate },
    } as const;
    for (const [index, endpoint] of endpoints.entries()) {
      const callsBefore: number = actionCalls + actionCommitCalls + readCalls;
      const payloadSchema = endpoint.payload.get('application/json')?.schemas[0];
      const manualPayload = Object.entries(manualPayloads).find(
        ([path]) => path === endpoint.path,
      )?.[1];
      const payload =
        payloadSchema === undefined
          ? undefined
          : (manualPayload ??
            Schema.encodeSync(payloadSchema)(
              FastCheck.sample(Schema.toArbitrary(payloadSchema)(FastCheck), {
                numRuns: 1,
                seed: index + 1,
              })[0],
            ));
      const request =
        payload === undefined
          ? new Request(`http://localhost${endpoint.path}`, {
              headers: { ...headers, 'idempotency-key': `runtime-assembly-${index + 1}` },
              method: endpoint.method,
            })
          : new Request(`http://localhost${endpoint.path}`, {
              body: JSON.stringify(payload),
              headers: { ...headers, 'idempotency-key': `runtime-assembly-${index + 1}` },
              method: endpoint.method,
            });
      // oxlint-disable-next-line no-await-in-loop -- Counter deltas prove each endpoint reaches exactly one substitute before the next request.
      const response = await runtime.handler(request);
      if (endpoint.path === '/party-registry/readiness') {
        assert.equal(response.status, 200);
        assert.equal(actionCalls + actionCommitCalls + readCalls, callsBefore);
      } else {
        assert.equal(
          response.status,
          500,
          `${endpoint.method} ${endpoint.path} must execute a supplied runtime substitute`,
        );
        assert.equal(
          actionCalls + actionCommitCalls + readCalls,
          callsBefore + 1,
          `${endpoint.method} ${endpoint.path} must reach exactly one supplied core runtime`,
        );
      }
    }
    assert.ok(redemptionCalls > 0);
    assert.ok(actionCalls > 0);
    assert.equal(actionCommitCalls, 1);
    assert.ok(readCalls > 0);
    assert.equal(aresCalls, 1);
    assert.equal(aresLayerLoads, 1);
    assert.equal(partySearchCalls, 1);
    assert.equal(counterpartySearchCalls, 1);
    assert.equal(searchLayerLoads, 1);

    const preflight = await runtime.handler(
      new Request('http://localhost/party-registry/readiness', {
        headers: {
          'access-control-request-headers': 'Authorization, X-Correlation-Id',
          'access-control-request-method': 'GET',
          origin: 'http://localhost:3020',
        },
        method: 'OPTIONS',
      }),
    );
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3020');
    assert.deepEqual(
      commaSeparatedHeader(preflight.headers.get('access-control-allow-methods')),
      [...partyRegistryCorsAllowedMethods].toSorted(),
    );
    assert.deepEqual(
      commaSeparatedHeader(preflight.headers.get('access-control-allow-headers')),
      [...partyRegistryCorsAllowedHeaders].toSorted(),
    );
    assert.equal(preflight.headers.get('access-control-max-age'), '600');

    const loopbackPreflight = await runtime.handler(
      new Request('http://localhost/party-registry/readiness', {
        headers: {
          'access-control-request-method': 'GET',
          origin: 'http://127.0.0.1:3020',
        },
        method: 'OPTIONS',
      }),
    );
    assert.equal(
      loopbackPreflight.headers.get('access-control-allow-origin'),
      'http://127.0.0.1:3020',
    );
    const foreignPreflight = await runtime.handler(
      new Request('http://localhost/party-registry/readiness', {
        headers: {
          'access-control-request-method': 'GET',
          origin: 'https://foreign.example.test',
        },
        method: 'OPTIONS',
      }),
    );
    assert.equal(foreignPreflight.headers.get('access-control-allow-origin'), null);
  } finally {
    await runtime.dispose();
  }
});
