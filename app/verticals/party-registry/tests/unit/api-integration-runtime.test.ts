import { assert, expect, it } from 'effect-rstest';
import { randomUUID } from 'node:crypto';

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
const makeAssertion = () =>
  Effect.gen(function* signRuntimeAssemblyAssertion() {
    const issuer = 'https://shell.runtime-assembly.test';
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'party-runtime-assembly-test',
      use: 'sig',
    };
    const token = yield* Effect.promise(() =>
      new SignJWT({ principal, ver: 1 })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'party-runtime-assembly-test', typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('party-registry')
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(randomUUID())
        .sign(privateKey),
    );
    return {
      issuer,
      publicJwks: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [publicJwk],
      }),
      token,
    };
  });

it.effect(
  'serves readiness and rejects the removed placeholder write without business dependencies',
  () =>
    Effect.gen(function* apiIntegrationRuntimeCase1() {
      const readinessApi = HttpApi.make('PartyRegistryApi').add(partyRegistryApi.groups.foundation);
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(readinessApi).pipe(
              Layer.provide(partyRegistryFoundationLive),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const response = yield* Effect.promise(() =>
        server.handler(new Request('http://localhost/party-registry/readiness'), Context.empty()),
      );
      expect(response.status).toBe(200);
      const readiness = yield* Schema.decodeUnknownEffect(partyRegistryReadinessSchema)(
        yield* Effect.promise(() => response.json()),
      );
      expect(readiness.marker).toEqual(ultramodernApiMarker);
      expect(readiness.status).toBe('ready');

      const removedWrite = yield* Effect.promise(() =>
        server.handler(
          new Request('http://localhost/party-registry', {
            body: '{"name":"Must not create an item"}',
            headers: { 'content-type': 'application/json' },
            method: 'POST',
          }),
          Context.empty(),
        ),
      );
      expect(removedWrite.status).toBe(404);
    }),
);

it.live(
  'builds every declared handler and preserves owner-local CORS through the injectable runtime',
  () =>
    Effect.gen(function* verifyRuntimeAssemblyAndCors() {
      const assertion = yield* makeAssertion();
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
          Effect.suspend(() => {
            actionCommitCalls += 1;
            return Effect.die('Action commit substitute reached through the assembled runtime');
          }),
        runAction: () =>
          Effect.suspend(() => {
            actionCalls += 1;
            return Effect.die('Action substitute reached through the assembled runtime');
          }),
      };
      const aresSubjectService = {
        subject: (_input) =>
          Effect.suspend(() => {
            aresCalls += 1;
            return Effect.die('ARES substitute reached through the assembled runtime');
          }),
      } satisfies AresSubjectServiceContract;
      const searchProjectionGateway = {
        searchCounterparties: (_input) =>
          Effect.suspend(() => {
            counterpartySearchCalls += 1;
            return Effect.die(
              'Counterparty search substitute reached through the assembled runtime',
            );
          }),
        searchParties: (_input) =>
          Effect.suspend(() => {
            partySearchCalls += 1;
            return Effect.die('Party search substitute reached through the assembled runtime');
          }),
      } satisfies PartySearchProjectionGatewayService;
      const readRuntime: ReadRuntimeService = {
        runRead: ({ registration }) =>
          Effect.context<never>().pipe(
            Effect.flatMap((context) => {
              readCalls += 1;
              if (registration.descriptor.readKey === 'party.registry.api.ares-lookup') {
                const service = Context.getOrUndefined(context, AresSubjectService);
                assert.isOk(service !== undefined);
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
                assert.isOk(service !== undefined);
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
                assert.isOk(service !== undefined);
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
                    Effect.andThen(
                      Effect.die('Counterparty search substitute completed unexpectedly'),
                    ),
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
      const runtime = yield* Effect.acquireRelease(
        Effect.sync(() => assembledRuntime.createHandler()),
        (resource) => Effect.promise(() => resource.dispose()).pipe(Effect.orDie),
      );

      const unauthenticatedReadRequest = new Request('http://localhost/reads/party-detail', {
        body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
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
      });
      const unauthenticatedRead = yield* Effect.promise(() =>
        runtime.handler(unauthenticatedReadRequest),
      );
      expect(unauthenticatedRead.status).toBe(401);
      expect(redemptionCalls).toBe(0);
      expect(unauthenticatedRead.headers.get('www-authenticate')).toBe('Bearer');
      yield* Schema.decodeUnknownEffect(PartyDetailAuthenticationProblemSchema)(
        yield* Effect.promise(() => unauthenticatedRead.json()),
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
      const invalidContactResponseRequest = new Request(
        'http://localhost/party-registry/actions/add-contact-point',
        {
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            ...addContactPointPayload,
            contactPoint: { ...addContactPointPayload.contactPoint, value: 'not-an-email' },
          }),
          headers: { ...headers, 'idempotency-key': 'invalid-contact-point' },
          method: 'POST',
        },
      );
      const invalidContactResponse = yield* Effect.promise(() =>
        runtime.handler(invalidContactResponseRequest),
      );
      expect(invalidContactResponse.status).toBe(400);
      expect(invalidContactResponse.headers.get('content-type') ?? '').toMatch(
        /application\/problem\+json/u,
      );
      yield* Schema.decodeUnknownEffect(PartyCommandInvalidRequestProblemSchema)(
        yield* Effect.promise(() => invalidContactResponse.json()),
      );
      expect(actionCalls).toBe(0);
      expect(redemptionCalls).toBe(0);
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
        const rawPayloadSchema = endpoint.payload.get('application/json')?.schemas[0];
        // Runtime HTTP descriptors erase codec types. These wire codecs require no services.
        const payloadSchema =
          rawPayloadSchema === undefined
            ? undefined
            : Schema.make<Schema.Codec<unknown, unknown>>(rawPayloadSchema.ast);
        const manualPayload = Object.entries(manualPayloads).find(
          ([path]) => path === endpoint.path,
        )?.[1];
        const payload =
          payloadSchema === undefined
            ? undefined
            : (manualPayload ??
              (yield* Schema.encodeEffect(payloadSchema)(
                FastCheck.sample(Schema.toArbitrary(payloadSchema)(FastCheck), {
                  numRuns: 1,
                  seed: index + 1,
                })[0],
              )));
        const request =
          payload === undefined
            ? new Request(`http://localhost${endpoint.path}`, {
                headers: { ...headers, 'idempotency-key': `runtime-assembly-${index + 1}` },
                method: endpoint.method,
              })
            : new Request(`http://localhost${endpoint.path}`, {
                body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload),
                headers: { ...headers, 'idempotency-key': `runtime-assembly-${index + 1}` },
                method: endpoint.method,
              });
        const response = yield* Effect.promise(() => runtime.handler(request));
        if (endpoint.path === '/party-registry/readiness') {
          expect(response.status).toBe(200);
          expect(actionCalls + actionCommitCalls + readCalls).toBe(callsBefore);
        } else {
          expect(
            response.status,
            `${endpoint.method} ${endpoint.path} must execute a supplied runtime substitute`,
          ).toBe(500);
          expect(
            actionCalls + actionCommitCalls + readCalls,
            `${endpoint.method} ${endpoint.path} must reach exactly one supplied core runtime`,
          ).toBe(callsBefore + 1);
        }
      }
      assert.isOk(redemptionCalls > 0);
      assert.isOk(actionCalls > 0);
      expect(actionCommitCalls).toBe(1);
      assert.isOk(readCalls > 0);
      expect(aresCalls).toBe(1);
      expect(aresLayerLoads).toBe(1);
      expect(partySearchCalls).toBe(1);
      expect(counterpartySearchCalls).toBe(1);
      expect(searchLayerLoads).toBe(1);
      const preflight = yield* Effect.promise(() =>
        runtime.handler(
          new Request('http://localhost/party-registry/readiness', {
            headers: {
              'access-control-request-headers': 'Authorization, X-Correlation-Id',
              'access-control-request-method': 'GET',
              origin: 'http://localhost:3020',
            },
            method: 'OPTIONS',
          }),
        ),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:3020');
      expect(commaSeparatedHeader(preflight.headers.get('access-control-allow-methods'))).toEqual(
        [...partyRegistryCorsAllowedMethods].toSorted(),
      );
      expect(commaSeparatedHeader(preflight.headers.get('access-control-allow-headers'))).toEqual(
        [...partyRegistryCorsAllowedHeaders].toSorted(),
      );
      expect(preflight.headers.get('access-control-max-age')).toBe('600');
      const loopbackPreflight = yield* Effect.promise(() =>
        runtime.handler(
          new Request('http://localhost/party-registry/readiness', {
            headers: {
              'access-control-request-method': 'GET',
              origin: 'http://127.0.0.1:3020',
            },
            method: 'OPTIONS',
          }),
        ),
      );
      expect(loopbackPreflight.headers.get('access-control-allow-origin')).toBe(
        'http://127.0.0.1:3020',
      );
      const foreignPreflight = yield* Effect.promise(() =>
        runtime.handler(
          new Request('http://localhost/party-registry/readiness', {
            headers: {
              'access-control-request-method': 'GET',
              origin: 'https://foreign.example.test',
            },
            method: 'OPTIONS',
          }),
        ),
      );
      expect(foreignPreflight.headers.get('access-control-allow-origin')).toBe(null);
    }),
);
