// Command reference validators are built per request from that request's scope. Two companies' requests in one
// process, interleaved, each get their own validators, their own reference credentials and their own lookups.
import { ActiveApplicationCompositionService, makeActiveApplicationCompositionService } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import {
  GATEWAY_ASSERTION_VERSION,
  REFERENCE_GATEWAY_CREDENTIALS_HEADER,
  ReferenceGatewayCredentialsSchema,
} from '@app/shared-contracts';
import { inProcessFetch, serveApi } from '@app/shared-contracts/testing/http-double';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import {
  RecordsApi as LeasingRecordsApi,
  RecordsResponseSchema as LeasingRecordsResponseSchema,
} from '@app/property-leasing/contracts/records';
import {
  RecordsApi as PropertyRecordsApi,
  RecordsResponseSchema as PropertyRecordsResponseSchema,
} from '@app/property-portfolio/contracts/records';
import { UnitRefSchema } from '@app/property-portfolio/resources/unit';
import { OccupancyRefSchema } from '@app/property-leasing/resources/occupancy';
import { Clock, ConfigProvider, Crypto, Effect, Layer, Predicate, Redacted, Schema, Tracer } from 'effect';
import type { PlatformError } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import {
  AgreementsReferenceValidators,
  AgreementsReferenceValidatorsLive,
} from '../../src/services/persistence.service.ts';

interface IssuedRead {
  readonly authorization: string | undefined;
  readonly baseUrl: string;
  readonly correlationId: string | undefined;
}

interface ReferenceCalls {
  readonly leasing: IssuedRead[];
  readonly property: IssuedRead[];
  readonly sources: Tracer.Span[];
}

// Observe real source construction through Effect's tracing API, retaining the native spans.
const sourceTracer = (sources: Tracer.Span[]) =>
  Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      if (span.name === 'GatewayPrincipalVerifier.referenceCredentialSource') {
        sources.push(span);
      }
      return span;
    },
  });

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyA = '20000000-0000-4000-8000-00000000000a';
const companyB = '20000000-0000-4000-8000-00000000000b';
const propertyId = '50000000-0000-4000-8000-000000000001';
const unitId = '50000000-0000-4000-8000-000000000002';
const buildMarker = 'reference-validator-test';
const issuer = 'https://shell.ontos.test';

const scopeOf = (legalEntityId: string, correlationId: string): OperationalScope => ({
  authBindingId: '30000000-0000-4000-8000-000000000002',
  authContextRef: 'reference-validator-session',
  authMethod: 'session',
  correlationId,
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000001',
  tenantId,
});

const unitRef = UnitRefSchema.make({
  moduleId: 'property.portfolio',
  resourceId: unitId,
  resourceType: 'property.portfolio.unit',
  tenantId,
});
const occupancyRef = OccupancyRefSchema.make({
  moduleId: 'property.leasing',
  resourceId: '60000000-0000-4000-8000-000000000001',
  resourceType: 'property.leasing.occupancy',
  tenantId,
});
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: propertyId,
  resourceType: 'property.portfolio.property',
  tenantId,
};
// The unit and its building belong to company A, whoever asks.
const propertyRecords = Schema.decodeUnknownSync(PropertyRecordsResponseSchema)({
  assets: [],
  properties: [
    {
      address: 'Test street 1',
      code: 'PROPERTY-1',
      createdAt: '2026-11-01T00:00:00.000Z',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: companyA,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Test building',
      note: null,
      propertyRef,
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  revision: 1,
  units: [
    {
      capacity: null,
      code: 'UNIT-1',
      lifecycleState: 'ACTIVE',
      name: 'Test unit',
      note: null,
      propertyRef,
      unitKind: null,
      unitRef,
    },
  ],
});
const leasingRecords = Schema.decodeUnknownSync(LeasingRecordsResponseSchema)({ occupancies: [], revision: 1 });

const issuedRead = (request: HttpServerRequest.HttpServerRequest, prefix: string) =>
  HttpServerRequest.toWeb(request).pipe(
    Effect.map((web): IssuedRead => ({
      authorization: request.headers['authorization'],
      baseUrl: new URL(prefix, web.url).href,
      correlationId: request.headers['x-correlation-id'],
    })),
  );

const signedCredential = (input: {
  readonly audience: string;
  readonly compositionRevision: string;
  readonly now: number;
  readonly privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  readonly scope: OperationalScope;
}) => {
  const { authBindingId, authContextRef, authMethod, legalEntityId, principalId } = input.scope;
  return Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(
    Effect.flatMap((jti) =>
      Effect.promise(() =>
        new SignJWT({
          compositionRevision: input.compositionRevision,
          principal: { authBindingId, authContextRef, authMethod, legalEntityId, principalId, tenantId },
          targetBuildMarker: buildMarker,
          ver: GATEWAY_ASSERTION_VERSION,
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: 'reference-validator-key', typ: 'JWT' })
          .setIssuer(issuer)
          .setAudience(input.audience)
          .setSubject(principalId)
          .setIssuedAt(input.now)
          .setExpirationTime(input.now + 300)
          .setJti(jti)
          .sign(input.privateKey),
      ),
    ),
    Effect.map((token) => `Bearer ${token}`),
  );
};

const requestFor = (
  scope: OperationalScope,
  credentialFor: (audience: string) => Effect.Effect<string, PlatformError.PlatformError, Crypto.Crypto>,
) =>
  Effect.gen(function* signRequestCredentials() {
    const property = yield* Effect.forEach([0, 1, 2, 3], () => credentialFor('property-portfolio'));
    const leasing = yield* credentialFor('property-leasing');
    const header = yield* Schema.encodeEffect(Schema.fromJsonString(ReferenceGatewayCredentialsSchema))([
      ...property.map((authorization) => ({
        audience: 'property-portfolio',
        authorization: Redacted.make(authorization),
      })),
      { audience: 'property-leasing', authorization: Redacted.make(leasing) },
    ]);
    const request = HttpServerRequest.fromWeb(
      new Request('https://ontos.test/reference-validators', {
        headers: {
          [REFERENCE_GATEWAY_CREDENTIALS_HEADER]: header,
          'x-correlation-id': scope.correlationId,
        },
      }),
    );
    return { leasing, property, request };
  });

/** The property and leasing owners in process, recording what each reference read carried to them. */
const referenceOwners = (calls: ReferenceCalls) => {
  const PropertyApi = PropertyRecordsApi.prefix('/property-portfolio-api');
  const LeasingApi = LeasingRecordsApi.prefix('/property-leasing-api');
  return inProcessFetch(
    serveApi(
      PropertyApi,
      HttpApiBuilder.group(PropertyApi, 'records', (group) =>
        group.handle('execute', () =>
          Effect.gen(function* propertyRead() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            calls.property.push(yield* issuedRead(request, '/property-portfolio-api').pipe(Effect.orDie));
            return propertyRecords;
          }),
        ),
      ),
    ),
    serveApi(
      LeasingApi,
      HttpApiBuilder.group(LeasingApi, 'records', (group) =>
        group.handle('execute', () =>
          Effect.gen(function* leasingRead() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            calls.leasing.push(yield* issuedRead(request, '/property-leasing-api').pipe(Effect.orDie));
            return leasingRecords;
          }),
        ),
      ),
    ),
  );
};

type SignedRequest = Effect.Success<ReturnType<typeof requestFor>>;

/** Company A's and company B's requests validated interleaved, and what each owner saw of them. */
const validateInterleavedRequests = (input: {
  readonly calls: ReferenceCalls;
  readonly credentialsA: SignedRequest;
  readonly credentialsB: SignedRequest;
  readonly scopeA: OperationalScope;
  readonly scopeB: OperationalScope;
  readonly snapshot: Effect.Success<ReturnType<typeof makeApplicationCompositionSnapshotFixture>>;
}) =>
  Effect.gen(function* checkInterleavedRequests() {
    const { calls, credentialsA, credentialsB, scopeA, scopeB, snapshot } = input;
    const referenceValidators = yield* AgreementsReferenceValidators;
    const forA = yield* referenceValidators
      .forScope(scopeA)
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, credentialsA.request),
        Effect.annotateSpans({ referenceScope: `${scopeA.tenantId}/${scopeA.legalEntityId}` }),
      );
    const forB = yield* referenceValidators
      .forScope(scopeB)
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, credentialsB.request),
        Effect.annotateSpans({ referenceScope: `${scopeB.tenantId}/${scopeB.legalEntityId}` }),
      );
    expect(forA).not.toBe(forB);
    expect(calls.sources.map((span) => span.attributes.get('referenceScope'))).toEqual([
      `${tenantId}/${companyA}`,
      `${tenantId}/${companyB}`,
    ]);

    const unitForA = yield* forA.unit(unitRef);
    const refusedForB = yield* Effect.flip(forB.unit(unitRef));
    const unitForAAgain = yield* forA.unit(unitRef);
    expect(unitForA.legalEntityId).toBe(companyA);
    expect(unitForAAgain.legalEntityId).toBe(companyA);
    expect(Predicate.isTagged(refusedForB, 'AgreementsRejected')).toBe(true);
    expect(refusedForB).toMatchObject({ code: 'agreements_rejected', reason: 'unit_not_usable' });

    yield* Effect.flip(forB.occupancy(occupancyRef));
    yield* Effect.flip(forA.occupancy(occupancyRef));

    expect(calls.property.map((read) => [read.correlationId, read.authorization])).toEqual([
      ['request-a', credentialsA.property[0]],
      ['request-a', credentialsA.property[1]],
      ['request-b', credentialsB.property[0]],
      ['request-b', credentialsB.property[1]],
      ['request-a', credentialsA.property[2]],
      ['request-a', credentialsA.property[3]],
    ]);
    const leasingModule = yield* Effect.fromNullishOr(
      snapshot.composition.modules.find((module) => module.deployment.appId === 'property-leasing'),
    );
    const leasingBaseUrl = new URL('/property-leasing-api', leasingModule.backend.baseUrl).href;
    expect(calls.leasing.map((read) => [read.correlationId, read.authorization, read.baseUrl])).toEqual([
      ['request-b', credentialsB.leasing, leasingBaseUrl],
      ['request-a', credentialsA.leasing, leasingBaseUrl],
    ]);
  });

it.layer(NodeCrypto.layer, { excludeTestServices: true })('reference validators scope', (suite) => {
  suite.effect('two companies interleaved never share validators, credentials or lookups', () =>
    Effect.gen(function* interleavedCompanies() {
      const calls: ReferenceCalls = {
        leasing: [],
        property: [],
        sources: [],
      };
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(
        ['property-leasing', 'property-portfolio'],
        buildMarker,
      );
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(() => exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: 'reference-validator-key',
        use: 'sig',
      };
      const verifier = makeGatewayPrincipalVerifierLayer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      );
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const scopeA = scopeOf(companyA, 'request-a');
      const scopeB = scopeOf(companyB, 'request-b');
      const credentialsFor = (scope: OperationalScope) =>
        requestFor(scope, (audience) =>
          signedCredential({ audience, compositionRevision: snapshot.composition.revision, now, privateKey, scope }),
        );
      const credentialsA = yield* credentialsFor(scopeA);
      const credentialsB = yield* credentialsFor(scopeB);
      const context = yield* Layer.build(
        AgreementsReferenceValidatorsLive.pipe(
          Layer.provideMerge(verifier),
          Layer.provideMerge(referenceOwners(calls)),
          Layer.provideMerge(
            Layer.succeed(
              ActiveApplicationCompositionService,
              makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
            ),
          ),
        ),
      );
      yield* validateInterleavedRequests({ calls, credentialsA, credentialsB, scopeA, scopeB, snapshot }).pipe(
        Effect.provide(context),
        Effect.withTracer(sourceTracer(calls.sources)),
        Effect.withTracerEnabled(true),
      );
    }),
  );
});
