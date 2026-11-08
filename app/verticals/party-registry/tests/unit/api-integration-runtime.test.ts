import { NodeCrypto } from '@effect/platform-node';

import {
  ActionRuntime,
  ActionTransportMetadataSchema,
  GatewayAssertionRedemptionService,
  ReadRuntime,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import {
  OwnerActionApprovalApi,
  OwnerActionApprovalAuthenticationSchema,
  OwnerActionApprovalRequestSchema,
} from '@app/core-runtime/access/approvals/owner-api';
import {
  decodeTrustedPrincipalContext,
  preserveSystemPrincipalContextTrust,
} from '@app/core-runtime/auth/system-principal-context-provenance';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { ActiveApplicationCompositionSource } from '@app/core-runtime/testing/application-composition-source';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { HttpApi, HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { Arbitrary, Clock, ConfigProvider, Context, Crypto, Effect, Layer, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { makePartyRegistryApiRuntime, partyRegistryFoundationLive } from '../../api/index.ts';
import { partyRegistryCorsAllowedHeaders, partyRegistryCorsAllowedMethods } from '../../api/read-server-support.ts';
import { partyRegistryApi, partyRegistryReadinessSchema } from '../../shared/api.ts';
import { PartyDetailAuthenticationProblemSchema } from '../../shared/apis/party-detail.ts';
import { PartyCommandInvalidRequestProblemSchema } from '../../shared/command-api.ts';
import { PartySearchProjectionGateway } from '../../shared/domain/search-projection-gateway.ts';
import type { PartySearchProjectionGatewayService } from '../../shared/domain/search-projection-gateway.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { AresSubjectService } from '../../src/integrations/ares/ares-subject.service.ts';
import type { AresSubjectServiceContract } from '../../src/integrations/ares/ares-subject.service.ts';
import { makeRootOwnerApprovals } from '../support/root-owner-approvals.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

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
    const { snapshot: compositionSnapshot } = yield* makeOwnerApplicationCompositionFixture({
      appId: ultramodernApiMarker.appId,
      buildMarker: ultramodernApiMarker.buildMarker,
      ownerRegistration: partyRegistryBackendRegistration,
    });
    const compositionDocument = yield* Schema.encodeEffect(
      Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
    )(compositionSnapshot);
    const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
    const publicJwk = {
      ...(yield* Effect.promise(() => exportJWK(publicKey))),
      alg: 'EdDSA',
      kid: 'party-runtime-assembly-test',
      use: 'sig',
    };
    const jti = yield* nextUuid;
    const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: compositionSnapshot.composition.revision,
        principal,
        targetBuildMarker: ultramodernApiMarker.buildMarker,
        ver: 1,
      })
        .setProtectedHeader({
          alg: 'EdDSA',
          kid: 'party-runtime-assembly-test',
          typ: 'JWT',
        })
        .setIssuer(issuer)
        .setAudience('party-registry')
        .setSubject(principal.principalId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + 300)
        .setJti(jti)
        .sign(privateKey),
    );
    return {
      compositionDocument,
      compositionSnapshot,
      issuer,
      publicJwks: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        keys: [publicJwk],
      }),
      token,
    };
  });

it.effect('serves readiness and rejects the removed placeholder write without business dependencies', () =>
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

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'builds every declared handler and preserves owner-local CORS through the injectable runtime',
    () =>
      Effect.gen(function* verifyRuntimeAssemblyAndCors() {
        const assertion = yield* makeAssertion();
        const ownerApprovals = yield* makeRootOwnerApprovals(assertion.compositionSnapshot, {
          ...principal,
          correlationId: 'party-runtime-assembly-test',
        });
        let redemptionCalls = 0;
        let actionCalls = 0;
        let actionExecutionCalls = 0;
        let aresCalls = 0;
        let aresLayerLoads = 0;
        let counterpartySearchCalls = 0;
        let partySearchCalls = 0;
        let readCalls = 0;
        let searchLayerLoads = 0;
        let compositionLoads = 0;
        const actionRuntime: ActionRuntimeService = {
          resolveActionExecution: () =>
            Effect.suspend(() => {
              actionExecutionCalls += 1;
              return Effect.die('Action execution recovery substitute reached through the assembled runtime');
            }),
          resolveActionCommit: () => Effect.die('Action commit lookup is outside this fixture'),
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
              return Effect.die('Counterparty search substitute reached through the assembled runtime');
            }),
          searchParties: (_input) =>
            Effect.suspend(() => {
              partySearchCalls += 1;
              return Effect.die('Party search substitute reached through the assembled runtime');
            }),
        } satisfies PartySearchProjectionGatewayService;
        const readRuntime: ReadRuntimeService = {
          runRead: ({ registration, principal: invocationPrincipal, transport: invocationTransport }) =>
            Effect.all({
              context: Effect.context<never>(),
              principal: decodeTrustedPrincipalContext(invocationPrincipal),
              transport: Schema.decodeUnknownEffect(ActionTransportMetadataSchema)(invocationTransport),
            }).pipe(
              Effect.orDie,
              Effect.flatMap(({ context, principal: readPrincipal, transport }) => {
                const scope = preserveSystemPrincipalContextTrust(readPrincipal, { ...readPrincipal, ...transport });
                readCalls += 1;
                if (registration.descriptor.readKey === 'party.registry.api.ares-lookup') {
                  const service = Context.getOrUndefined(context, AresSubjectService);
                  assert.isOk(service !== undefined);
                  return service
                    .subject({
                      correlationId: 'runtime-assembly-proof',
                      ico: '27074358',
                    })
                    .pipe(Effect.orDie, Effect.andThen(Effect.die('ARES substitute completed unexpectedly')));
                }
                if (registration.descriptor.readKey === 'party.registry.search.parties') {
                  const service = Context.getOrUndefined(context, PartySearchProjectionGateway);
                  assert.isOk(service !== undefined);
                  return service
                    .searchParties(
                      {
                        includeArchived: false,
                        query: 'runtime assembly proof',
                        tenantId: readPrincipal.tenantId,
                      },
                      scope,
                      { hiddenTextFields: [], listAccess: { groups: [] } },
                    )
                    .pipe(Effect.orDie, Effect.andThen(Effect.die('Party search substitute completed unexpectedly')));
                }
                if (registration.descriptor.readKey === 'party.registry.search.counterparties') {
                  const service = Context.getOrUndefined(context, PartySearchProjectionGateway);
                  assert.isOk(service !== undefined);
                  return service
                    .searchCounterparties(
                      {
                        effectiveAt: '2026-09-07T00:00:00.000Z',
                        includeArchived: false,
                        legalEntityId: 'a5000000-0000-4000-8000-000000000001',
                        query: 'runtime assembly proof',
                        tenantId: readPrincipal.tenantId,
                      },
                      scope,
                      { hiddenTextFields: [], listAccess: { groups: [] } },
                    )
                    .pipe(
                      Effect.orDie,
                      Effect.andThen(Effect.die('Counterparty search substitute completed unexpectedly')),
                    );
                }
                return Effect.die('Read substitute reached through the assembled runtime');
              }),
            ),
        };
        const assertionConfigurationLive = Layer.mergeAll(
          Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
            const request = new Request(input, init);
            expect(request.url).toBe('https://composition.runtime-assembly.test/active');
            compositionLoads += 1;
            return Promise.resolve(
              new Response(assertion.compositionDocument, { headers: { 'content-type': 'application/json' } }),
            );
          }),
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: 'https://composition.runtime-assembly.test/active',
              ONTOS_GATEWAY_ISSUER: assertion.issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: assertion.publicJwks,
            }),
          ),
        );
        const compositionSourceContext = yield* Layer.build(
          ActiveApplicationCompositionSourceLive.pipe(
            Layer.provide(
              FetchHttpClient.layer.pipe(
                Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { cache: 'no-store', redirect: 'manual' })),
              ),
            ),
            Layer.provide(assertionConfigurationLive),
          ),
        );
        const actionRuntimeLayer = Layer.mergeAll(
          Layer.succeedContext(ownerApprovals),
          Layer.succeed(ActionRuntime, actionRuntime),
          assertionConfigurationLive,
          Layer.succeed(
            ActiveApplicationCompositionSource,
            Context.get(compositionSourceContext, ActiveApplicationCompositionSource),
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
        const unauthenticatedRead = yield* Effect.promise(() => runtime.handler(unauthenticatedReadRequest));
        expect(unauthenticatedRead.status).toBe(401);
        expect(redemptionCalls).toBe(0);
        expect(unauthenticatedRead.headers.get('www-authenticate')).toBe('Bearer');
        yield* Schema.decodeUnknownEffect(PartyDetailAuthenticationProblemSchema)(
          yield* Effect.promise(() => unauthenticatedRead.json()),
        );
        // Native addHttpApi merges annotations on the group, preserving its endpoint identities.
        expect(partyRegistryApi.groups.ownerActionApprovals.endpoints).toBe(
          OwnerActionApprovalApi.groups.ownerActionApprovals.endpoints,
        );
        const endpoints = Object.values(partyRegistryApi.groups).flatMap((group) =>
          Object.values(group.endpoints).map((endpoint) => ({ endpoint, group })),
        );
        let platformAuthenticationDenials = 0;
        const headers = {
          authorization: `Bearer ${assertion.token}`,
          'content-type': 'application/json',
          'x-correlation-id': 'runtime-assembly-proof',
          'x-ontos-composition-revision': assertion.compositionSnapshot.composition.revision,
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
          businessName: 'Runtime assembly proof',
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
          contactPoint: {
            preferred: false,
            type: 'EMAIL',
            value: 'contact@example.test',
          },
          partyRef,
          privacyClassification: 'PUBLIC',
          provenance: contactPointProvenance,
          validFrom: '2026-09-07T00:00:00.000Z',
        } as const;
        const invalidContactResponseRequest = new Request('http://localhost/party-registry/actions/add-contact-point', {
          body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            ...addContactPointPayload,
            contactPoint: {
              ...addContactPointPayload.contactPoint,
              value: 'not-an-email',
            },
          }),
          headers: { ...headers, 'idempotency-key': 'invalid-contact-point' },
          method: 'POST',
        });
        const invalidContactResponse = yield* Effect.promise(() => runtime.handler(invalidContactResponseRequest));
        expect(invalidContactResponse.status).toBe(400);
        expect(invalidContactResponse.headers.get('content-type') ?? '').toMatch(/application\/problem\+json/u);
        yield* Schema.decodeUnknownEffect(PartyCommandInvalidRequestProblemSchema)(
          yield* Effect.promise(() => invalidContactResponse.json()),
        );
        expect(actionCalls).toBe(0);
        expect(redemptionCalls).toBe(0);
        const manualPayloads = {
          '/reads/privacy-measure-execution': { idempotencyKey: 'runtime-test:1' },
          '/party-registry/actions/execute-privacy-measure': {
            handoff: {
              contentScopeRefs: ['party.registry.counterparty.lifecycle'],
              controllerObligationRef: 'obligation:runtime-test',
              dispositionDecision: 'RESTRICT',
              expectedEvidenceRefs: ['party.registry.counterparty.restricted'],
              idempotencyKey: 'runtime-test:1',
              kind: 'RESTRICT',
              measureId: 'measure:runtime-test',
              owningCapability: 'party.registry',
              preconditionRefs: ['decision:runtime-test'],
              requestedAt: '2026-09-14T10:00:00.000Z',
              requestedResult: 'RESTRICTED',
              resourceRefs: [
                'party.registry|party.registry.counterparty|a5000000-0000-4000-8000-000000000001|a6000000-0000-4000-8000-000000000001',
              ],
              right: null,
              sourceDecisionRef: 'decision:runtime-test',
              sourceDecisionRevision: 1,
              subjectRef: 'subject:runtime-test',
              taskId: 'task:runtime-test',
              tenantId: principal.tenantId,
            },
          },
          '/party-registry/actions/add-contact-point': addContactPointPayload,
          '/party-registry/actions/add-party-official-identifier': {
            identifier: {
              identifierType: 'ICO',
              value: '27074358',
            },
            partyRef,
            provenanceMethod: 'DOCUMENT',
            provenanceSource: 'runtime-assembly-proof',
            validFrom: '2026-09-07T00:00:00.000Z',
          },
          '/party-registry/actions/counterparty-customer-onboard': {
            counterpartyProvenance: { ...provenance, reason: 'Runtime assembly proof' },
            customerEvidence: provenance,
            partyRef,
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
          '/party-registry/actions/create-crm-client-party': {
            candidate,
            clientId: 'runtime-client',
            sourceScope: { tenantId: principal.tenantId, legalEntityId: 'a5000000-0000-4000-8000-000000000001' },
          },
          // Sampled DateTimeUtc values include extended years that the canonical ISO wire format rejects.
          '/party-registry/actions/create-party-relationship': {
            fromPartyRef: partyRef,
            provenance: { method: 'TEST', source: 'runtime-assembly-proof' },
            relationshipType: 'CONTACT_PERSON_OF',
            toPartyRef: { ...partyRef, resourceId: 'ab000000-0000-4000-8000-000000000001' },
            validFrom: '2026-09-07T00:00:00.000Z',
            validTo: null,
          },
          '/party-registry/actions/end-contact-point': {
            contactPointRef,
            effectiveEnd: '2026-09-07T00:00:00.000Z',
            provenance: contactPointProvenance,
            reason: 'Runtime assembly proof',
            target: { type: 'WHOLE_CONTACT_POINT' },
          },
          '/party-registry/actions/end-party-relationship': {
            effectiveAt: '2026-09-07T00:00:00.000Z',
            expectedRevision: 1,
            provenance: { method: 'TEST', source: 'runtime-assembly-proof' },
            relationshipRef: {
              moduleId: 'party.registry',
              resourceId: 'aa000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party-relationship',
              tenantId: principal.tenantId,
            },
          },
          '/party-registry/actions/match-party': { candidate },
          '/party-registry/actions/update-party': {
            businessName: 'Updated runtime assembly proof',
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
              type: 'END_VALIDITY',
              validTo: '2026-10-01T00:00:00.000Z',
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
          '/reads/crm-client-intake-review': {
            clientId: 'runtime-client',
            sourceScope: { tenantId: principal.tenantId, legalEntityId: 'a5000000-0000-4000-8000-000000000001' },
            caseRef: {
              moduleId: 'party.registry',
              resourceType: 'party.registry.duplicate-candidate-case',
              resourceId: 'a8000000-0000-4000-8000-000000000001',
              tenantId: principal.tenantId,
            },
            decisionRef: {
              moduleId: 'party.registry',
              resourceType: 'party.registry.party-match-decision',
              resourceId: 'a8000000-0000-4000-8000-000000000002',
              tenantId: principal.tenantId,
            },
          },
        } as const;
        for (const [index, { endpoint, group }] of endpoints.entries()) {
          const callsBefore: number = actionCalls + actionExecutionCalls + readCalls;
          const redemptionsBefore = redemptionCalls;
          const isOwnerApproval = group.endpoints === OwnerActionApprovalApi.groups.ownerActionApprovals.endpoints;
          const requestHeaders = new Headers({
            ...headers,
            'idempotency-key': `runtime-assembly-${index + 1}`,
          });
          const rawPayloadSchema = endpoint.payload.get('application/json')?.schemas[0];
          // Runtime HTTP descriptors erase codec types. These wire codecs require no services.
          const payloadSchema =
            rawPayloadSchema === undefined
              ? undefined
              : Schema.make<Schema.Codec<unknown, unknown>>(rawPayloadSchema.ast);
          const manualPayload = Object.entries(manualPayloads).find(([path]) => path === endpoint.path)?.[1];
          const sampledPayload =
            payloadSchema === undefined
              ? undefined
              : (manualPayload ??
                (yield* Schema.encodeEffect(payloadSchema)(
                  (yield* Arbitrary.sampleEffect(Arbitrary.schema(payloadSchema), {
                    count: 1,
                    seed: index + 1,
                  }))[0],
                )));
          // An audience-valid assertion cannot authenticate a different request composition.
          const payload = isOwnerApproval
            ? {
                ...(yield* Schema.decodeUnknownEffect(OwnerActionApprovalRequestSchema)(sampledPayload)),
                compositionRevision: '0'.repeat(64),
              }
            : sampledPayload;
          const request =
            payload === undefined
              ? new Request(`http://localhost${endpoint.path}`, {
                  headers: requestHeaders,
                  method: endpoint.method,
                })
              : new Request(`http://localhost${endpoint.path}`, {
                  body: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload),
                  headers: requestHeaders,
                  method: endpoint.method,
                });
          const unauthenticatedApprovalRequest = isOwnerApproval ? request.clone() : undefined;
          const response = yield* Effect.promise(() => runtime.handler(request));
          if (isOwnerApproval) {
            expect(response.status).toBe(401);
            yield* Schema.decodeUnknownEffect(OwnerActionApprovalAuthenticationSchema)(
              yield* Effect.promise(() => response.json()),
            );
            expect(actionCalls + actionExecutionCalls + readCalls).toBe(callsBefore);
            expect(redemptionCalls).toBe(redemptionsBefore + 1);
            assert.isOk(unauthenticatedApprovalRequest !== undefined);
            unauthenticatedApprovalRequest.headers.delete('authorization');
            const missingAuthentication = yield* Effect.promise(() => runtime.handler(unauthenticatedApprovalRequest));
            expect(missingAuthentication.status).toBe(401);
            yield* Schema.decodeUnknownEffect(OwnerActionApprovalAuthenticationSchema)(
              yield* Effect.promise(() => missingAuthentication.json()),
            );
            expect(actionCalls + actionExecutionCalls + readCalls).toBe(callsBefore);
            expect(redemptionCalls).toBe(redemptionsBefore + 1);
            platformAuthenticationDenials += 1;
          } else if (endpoint.path === '/party-registry/readiness') {
            expect(response.status).toBe(200);
            expect(actionCalls + actionExecutionCalls + readCalls).toBe(callsBefore);
          } else {
            expect(
              response.status,
              `${endpoint.method} ${endpoint.path} must execute a supplied runtime substitute`,
            ).toBe(500);
            expect(
              actionCalls + actionExecutionCalls + readCalls,
              `${endpoint.method} ${endpoint.path} must reach exactly one supplied core runtime`,
            ).toBe(callsBefore + 1);
          }
        }
        expect(platformAuthenticationDenials).toBe(2);
        expect(compositionLoads).toBe(1);
        assert.isOk(redemptionCalls > 0);
        assert.isOk(actionCalls > 0);
        expect(actionExecutionCalls).toBe(1);
        assert.isOk(readCalls > 0);
        expect(aresCalls).toBe(1);
        expect(aresLayerLoads).toBe(1);
        expect(partySearchCalls).toBe(1);
        expect(counterpartySearchCalls).toBe(1);
        expect(searchLayerLoads).toBe(1);
        const callsBeforePreflight = {
          actionCalls,
          actionExecutionCalls,
          aresCalls,
          counterpartySearchCalls,
          partySearchCalls,
          readCalls,
          redemptionCalls,
        };
        const preflight = yield* Effect.promise(() =>
          runtime.handler(
            new Request('http://localhost/party-registry/actions/create-party', {
              headers: {
                'access-control-request-headers':
                  'Authorization, X-Action-Intent, X-Correlation-Id, X-Ontos-Composition-Revision',
                'access-control-request-method': 'POST',
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
        expect(commaSeparatedHeader(preflight.headers.get('access-control-allow-headers'))).toContain(
          'X-Ontos-Composition-Revision',
        );
        expect(commaSeparatedHeader(preflight.headers.get('access-control-allow-headers'))).toContain(
          'X-Action-Intent',
        );
        expect({
          actionCalls,
          actionExecutionCalls,
          aresCalls,
          counterpartySearchCalls,
          partySearchCalls,
          readCalls,
          redemptionCalls,
        }).toEqual(callsBeforePreflight);
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
        expect(loopbackPreflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3020');
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
    15_000,
  );
});
