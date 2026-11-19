// Command reference validators are built per request from that request's scope. Two companies' requests in one
// process, interleaved, each get their own validators, their own reference credentials and their own lookups.
import { ActiveApplicationCompositionService, makeActiveApplicationCompositionService } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeGatewayPrincipalVerifierLayer } from '@app/gateway-principal-verifier/server';
import {
  RecordsApi as AgreementsApi,
  RecordsResponseSchema as AgreementsResponseSchema,
} from '@app/legal-agreements/contracts/records';
import { ContractRefSchema } from '@app/legal-agreements/resources/contract';
import {
  RecordsApi as PropertyApi,
  RecordsResponseSchema as PropertyResponseSchema,
} from '@app/property-portfolio/contracts/records';
import { UnitRefSchema } from '@app/property-portfolio/resources/unit';
import {
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_ASSERTION_VERSION,
  GatewayTrustedPrincipalContextSchema,
  REFERENCE_GATEWAY_CREDENTIALS_HEADER,
} from '@app/shared-contracts';
import { inProcessFetch, serveApi } from '@app/shared-contracts/testing/http-double';
import { NodeCrypto } from '@effect/platform-node';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { Clock, ConfigProvider, Crypto, Effect, Layer, Predicate, Schema, Tracer } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  OccupancyReferenceValidators,
  OccupancyReferenceValidatorsLive,
} from '../../src/services/persistence.service.ts';

interface IssuedRead {
  readonly authorization: string;
  readonly baseUrl: string;
  readonly correlationId: string;
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
const buildMarker = 'reference-scope-test';
const issuer = 'https://shell.ontos.test';
const keyId = 'reference-scope-key';

const scopeOf = (legalEntityId: string, correlationId: string): OperationalScope => ({
  authBindingId: '30000000-0000-4000-8000-000000000002',
  authContextRef: 'reference-scope-session',
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
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: propertyId,
  resourceType: 'property.portfolio.property',
  tenantId,
};
const contractRef = ContractRefSchema.make({
  moduleId: 'legal.agreements',
  resourceId: '60000000-0000-4000-8000-000000000001',
  resourceType: 'legal.agreements.contract',
  tenantId,
});

// The unit and its building belong to company A, whoever asks. Both owners encode through their real schemas.
const propertyRecords = Schema.decodeUnknownSync(PropertyResponseSchema)({
  assets: [],
  properties: [
    {
      address: 'Test address',
      code: 'PROPERTY-A',
      createdAt: '2026-11-01T00:00:00.000Z',
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: companyA,
        resourceType: 'core.identity.legal-entity',
        tenantId,
      },
      lifecycleState: 'ACTIVE',
      name: 'Company A property',
      note: null,
      propertyRef,
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
  revision: 1,
  units: [
    {
      capacity: null,
      code: 'UNIT-A',
      lifecycleState: 'ACTIVE',
      name: 'Company A unit',
      note: null,
      propertyRef,
      unitKind: null,
      unitRef,
    },
  ],
});
const agreementRecords = Schema.decodeUnknownSync(AgreementsResponseSchema)({
  contracts: [],
  documents: [],
  revision: 1,
});

type CompositionSnapshot = Effect.Success<ReturnType<typeof makeApplicationCompositionSnapshotFixture>>;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** One single-use reference credential for `audience`, signed by the Shell's gateway key. */
const signedCredential = (input: {
  readonly audience: string;
  readonly now: number;
  readonly principal: typeof GatewayTrustedPrincipalContextSchema.Type;
  readonly privateKey: SigningKey;
  readonly scope: OperationalScope;
  readonly snapshot: CompositionSnapshot;
}) =>
  Effect.gen(function* signCredential() {
    const jti = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: input.snapshot.composition.revision,
        principal: input.principal,
        targetBuildMarker: buildMarker,
        ver: GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience(input.audience)
        .setSubject(input.scope.principalId)
        .setIssuedAt(input.now)
        .setExpirationTime(input.now + GATEWAY_ASSERTION_TTL_SECONDS)
        .setJti(jti)
        .sign(input.privateKey),
    );
    return { audience: input.audience, authorization: `Bearer ${token}` };
  });

const credentialsFor = (
  scope: OperationalScope,
  propertyReads: number,
  snapshot: CompositionSnapshot,
  privateKey: SigningKey,
) =>
  Effect.gen(function* signReferenceCredentials() {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const principal = yield* Schema.decodeUnknownEffect(GatewayTrustedPrincipalContextSchema)(scope);
    return yield* Effect.forEach(
      [...Array.from({ length: propertyReads }, () => 'property-portfolio'), 'legal-agreements'],
      (audience) => signedCredential({ audience, now, principal, privateKey, scope, snapshot }),
    );
  });

type ReferenceCredentials = Effect.Success<ReturnType<typeof credentialsFor>>;

/** The command request carrying a company's reference credentials, as the Shell relays it. */
const requestWith = (credentials: ReferenceCredentials) =>
  HttpServerRequest.fromWeb(
    new Request('https://ontos.test/reference-validators', {
      headers: { [REFERENCE_GATEWAY_CREDENTIALS_HEADER]: JSON.stringify(credentials) },
    }),
  );

interface ReferenceCalls {
  readonly agreements: IssuedRead[];
  readonly property: IssuedRead[];
  readonly sources: Tracer.Span[];
}

// What each read carried to its owner at the HTTP boundary.
const issuedRead = (prefix: string) =>
  Effect.gen(function* receiveReferenceRead() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers['authorization'] ?? '';
    return {
      authorization,
      baseUrl: new URL(prefix, request.originalUrl).href,
      correlationId: request.headers['x-correlation-id'] ?? '',
    } satisfies IssuedRead;
  }).pipe(Effect.orDie);

/** The property and agreements owners in process, recording what each reference read carried to them. */
const referenceOwners = (calls: ReferenceCalls) => {
  const PropertyRecordsApi = PropertyApi.prefix('/property-portfolio-api');
  const AgreementsRecordsApi = AgreementsApi.prefix('/legal-agreements-api');
  return inProcessFetch(
    serveApi(
      PropertyRecordsApi,
      HttpApiBuilder.group(PropertyRecordsApi, 'records', (group) =>
        group.handle('execute', () =>
          Effect.gen(function* propertyRead() {
            calls.property.push(yield* issuedRead('/property-portfolio-api'));
            return propertyRecords;
          }),
        ),
      ),
    ),
    serveApi(
      AgreementsRecordsApi,
      HttpApiBuilder.group(AgreementsRecordsApi, 'records', (group) =>
        group.handle('execute', () =>
          Effect.gen(function* agreementRead() {
            calls.agreements.push(yield* issuedRead('/legal-agreements-api'));
            return agreementRecords;
          }),
        ),
      ),
    ),
  );
};

/** Company A's and company B's requests validated interleaved, and what each owner saw of them. */
const validateInterleavedRequests = (input: {
  readonly calls: ReferenceCalls;
  readonly credentialsA: ReferenceCredentials;
  readonly credentialsB: ReferenceCredentials;
  readonly scopeA: OperationalScope;
  readonly scopeB: OperationalScope;
  readonly snapshot: CompositionSnapshot;
}) =>
  Effect.gen(function* checkInterleavedRequests() {
    const { calls, credentialsA, credentialsB, scopeA, scopeB, snapshot } = input;
    const referenceValidators = yield* OccupancyReferenceValidators;
    const forA = yield* referenceValidators
      .forScope(scopeA)
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, requestWith(credentialsA)),
        Effect.annotateSpans({ referenceScope: `${scopeA.tenantId}/${scopeA.legalEntityId}` }),
      );
    const forB = yield* referenceValidators
      .forScope(scopeB)
      .pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, requestWith(credentialsB)),
        Effect.annotateSpans({ referenceScope: `${scopeB.tenantId}/${scopeB.legalEntityId}` }),
      );
    expect(forA).not.toBe(forB);
    // Each request's credential source is built once, when its validators are built, before any lookup.
    expect(calls.sources.map((span) => span.attributes.get('referenceScope'))).toEqual([
      `${tenantId}/${companyA}`,
      `${tenantId}/${companyB}`,
    ]);

    const unitForA = yield* forA.unit(unitRef);
    const refusedForB = yield* Effect.flip(forB.unit(unitRef));
    const unitForAAgain = yield* forA.unit(unitRef);
    expect(unitForA.legalEntityId).toBe(companyA);
    expect(unitForAAgain.legalEntityId).toBe(companyA);
    expect(Predicate.isTagged(refusedForB, 'OccupancyRejected')).toBe(true);
    expect(refusedForB).toMatchObject({ code: 'occupancy_rejected', reason: 'unit_not_usable' });

    yield* Effect.flip(forB.contract(contractRef));
    yield* Effect.flip(forA.contract(contractRef));

    // The lookups built no further source.
    expect(calls.sources).toHaveLength(2);
    expect(calls.property.map((read) => [read.correlationId, read.authorization])).toEqual([
      ['request-a', credentialsA[0]?.authorization],
      ['request-a', credentialsA[1]?.authorization],
      ['request-b', credentialsB[0]?.authorization],
      ['request-b', credentialsB[1]?.authorization],
      ['request-a', credentialsA[2]?.authorization],
      ['request-a', credentialsA[3]?.authorization],
    ]);
    const agreementsModule = snapshot.composition.modules.find(
      (module) => module.deployment.appId === 'legal-agreements',
    );
    const agreementsBaseUrl = new URL('/legal-agreements-api', agreementsModule?.backend.baseUrl).href;
    expect(calls.agreements.map((read) => [read.correlationId, read.authorization, read.baseUrl])).toEqual([
      ['request-b', credentialsB[2]?.authorization, agreementsBaseUrl],
      ['request-a', credentialsA[4]?.authorization, agreementsBaseUrl],
    ]);
  });

it.layer(NodeCrypto.layer, { excludeTestServices: true })('per-request reference validators', (suite) => {
  suite.effect('two companies interleaved never share validators, credentials or lookups', () =>
    Effect.gen(function* interleavedCompanies() {
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(
        ['property-portfolio', 'legal-agreements'],
        buildMarker,
      );
      const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
      const publicJwk = {
        ...(yield* Effect.promise(() => exportJWK(publicKey))),
        alg: 'EdDSA',
        kid: keyId,
        use: 'sig',
      };
      const scopeA = scopeOf(companyA, 'request-a');
      const scopeB = scopeOf(companyB, 'request-b');
      const credentialsA = yield* credentialsFor(scopeA, 4, snapshot, privateKey);
      const credentialsB = yield* credentialsFor(scopeB, 2, snapshot, privateKey);
      const calls: ReferenceCalls = { agreements: [], property: [], sources: [] };
      const verifier = makeGatewayPrincipalVerifierLayer(
        ConfigProvider.fromUnknown({
          ONTOS_GATEWAY_ISSUER: issuer,
          ONTOS_GATEWAY_PUBLIC_JWKS: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: [publicJwk],
          }),
        }),
      );
      const context = yield* Layer.build(
        referenceOwners(calls).pipe(
          Layer.provideMerge(OccupancyReferenceValidatorsLive),
          Layer.provideMerge(verifier),
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
