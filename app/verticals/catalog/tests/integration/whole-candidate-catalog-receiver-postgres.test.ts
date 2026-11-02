import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import type { Cause } from 'effect';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeContextPermissionRelationshipMutationLive } from '@app/core-runtime';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  SupportedGatewayContextClaimsSchema,
  decodeSupportedGatewayContextClaims,
} from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  Context,
  Crypto,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  Scope,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';

import { executeQuantityPreparationWithAuthorization } from '../../src/api/quantity-preparation-client.ts';
import { executePricingPurposeEquivalenceWithAuthorization } from '../../src/api/pricing-purpose-equivalence-client.ts';
import { executeQuantityBasisCompatibilityWithAuthorization } from '../../src/api/quantity-basis-compatibility-client.ts';
import { executeCatalogMediaCurrentWithAuthorization } from '../../src/api/catalog-media-current-client.ts';
import {
  QuantityPreparationRequestSchema,
  QuantityPreparationAuthenticationProblemSchema,
  QuantityPreparationForbiddenProblemSchema,
  QuantityPreparationUnavailableProblemSchema,
} from '../../shared/apis/quantity-preparation.ts';
import {
  PricingPurposeEquivalenceRequestSchema,
  PricingPurposeEquivalenceForbiddenProblemSchema,
} from '../../shared/apis/pricing-purpose-equivalence.ts';
import { QuantityBasisCompatibilityForbiddenProblemSchema } from '../../shared/apis/quantity-basis-compatibility.ts';
import { CatalogMediaCurrentForbiddenProblemSchema } from '../../shared/apis/catalog-media-current.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  WholeCandidateCatalogCommandSchema,
  WholeCandidateCatalogDescriptionSchema,
  WholeCandidateCatalogProducedSchema,
  WholeCandidateCatalogPrepareSchema,
  WholeCandidateCatalogReadySchema,
  WholeCandidateCatalogResponseSchema,
  wholeCandidateCatalogActionKeys,
} from '../support/whole-candidate-catalog-receiver.fixture.ts';

const version = 'ontos.catalog.whole-candidate.fixture.v1' as const;
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const appRoot = new URL('../../../../', import.meta.url).pathname;
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
class WholeCandidateReceiverTestUnavailable extends Schema.TaggedError<WholeCandidateReceiverTestUnavailable>()(
  'WholeCandidateReceiverTestUnavailable',
  { stage: Schema.String },
) {}
const unavailable = (stage: string) => new WholeCandidateReceiverTestUnavailable({ stage });

const launchReceiver = Effect.fn('CatalogTargetAgreement.launchReceiver')(function* launchReceiver(
  artifact: string,
  environment: Readonly<Record<string, string>> = {},
) {
  const commands = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const responses = yield* Queue.unbounded<typeof WholeCandidateCatalogResponseSchema.Type>();
  const child = yield* ChildProcess.make(process.execPath, [artifact, '--serve-whole-candidate'], {
    additionalFds: { fd3: { type: 'output' }, fd4: { stream: Stream.fromQueue(commands), type: 'input' } },
    cwd: appRoot,
    env: environment,
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  yield* child.getOutputFd(3).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(WholeCandidateCatalogResponseSchema), {
        onExcessProperty: 'error',
      })(line),
    ),
    Stream.runForEach((response) => Queue.offer(responses, response)),
    Effect.forkScoped,
  );
  const send = (command: typeof WholeCandidateCatalogCommandSchema.Type) =>
    Schema.encodeEffect(Schema.fromJsonString(WholeCandidateCatalogCommandSchema))(command).pipe(
      Effect.flatMap((line) => Queue.offer(commands, new TextEncoder().encode(`${line}\n`))),
    );
  const receive = () =>
    Effect.raceFirst(
      Queue.take(responses),
      child.exitCode.pipe(Effect.flatMap(() => Effect.fail(unavailable('child-exited-before-response')))),
    );
  return { child, commands, receive, send };
});

const runCatalogReceiver = (mode: 'strict-whole-candidate' | 'target-agreement') =>
  Effect.gen(function* actualCatalogWholeCandidateReceiver() {
    const composition = yield* makeApplicationCompositionSnapshotFixture(
      ['catalog', 'pricing'],
      ultramodernApiMarker.buildMarker,
    );
    const isolated = yield* makeIsolatedNativeDatabaseFixture({
      compositionSnapshot: composition,
      mode: 'schema-only',
      purpose: 'stabilization-1225-whole-candidate',
    });
    yield* isolated.assertClonedSchema();
    const adminContext = yield* Layer.build(
      PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: wholeCandidateCatalogActionKeys,
        adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
        allowedAudiences: ['catalog', 'pricing'],
        authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
        compositionRevision: composition.composition.revision,
        moduleKeys: ['commerce.catalog', 'commerce.pricing'],
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      }),
      (value) => value.close().pipe(Effect.orDie),
    );
    const permissions = yield* makeContextPermissionRelationshipMutationLive();
    const principal = { principalId: fixture.manager.principalId, tenantId: fixture.tenantId };
    const targets = [
      { moduleId: 'commerce.catalog', permission: 'module.access' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.quantity-preparation' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.pricing-purpose-equivalence' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.quantity-basis-compatibility' },
      { moduleId: 'commerce.catalog', permission: 'commerce.catalog.read.media' },
    ];
    for (const target of targets) {
      yield* permissions.mutate({
        legalEntityId: fixture.legalEntityId,
        operation: 'grant',
        principal,
        target,
        tenantId: fixture.tenantId,
      });
      yield* Effect.addFinalizer(() =>
        permissions
          .mutate({
            legalEntityId: fixture.legalEntityId,
            operation: 'revoke',
            principal,
            target,
            tenantId: fixture.tenantId,
          })
          .pipe(Effect.orDie),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    const directory = `${appRoot}verticals/catalog/.cache/ontos-1225/`;
    yield* fs.makeDirectory(directory, { recursive: true });
    const artifact = `${directory}${yield* nextId}.mjs`;
    yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
    const build = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/catalog/tests/support/whole-candidate-catalog-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [buildExit] = yield* Effect.all(
      [build.exitCode, Stream.runDrain(build.stdout), Stream.runDrain(build.stderr)],
      { concurrency: 3 },
    );
    expect(buildExit).toBe(0);
    const keys = yield* Effect.tryPromise({
      catch: () => unavailable('signing-key'),
      try: () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
    });
    assert('privateKey' in keys);
    const publicKey = yield* Effect.tryPromise({
      catch: () => unavailable('public-key'),
      try: () => globalThis.crypto.subtle.exportKey('jwk', keys.publicKey),
    });
    const kid = 'whole-candidate-native';
    const issuer = 'https://whole-candidate-native.ontos.test';
    const publicJwkSchema = Schema.Struct({
      crv: Schema.Literal('Ed25519'),
      kty: Schema.Literal('OKP'),
      x: Schema.String,
    });
    const jwksSchema = Schema.Struct({
      keys: Schema.Array(
        Schema.Struct({
          ...publicJwkSchema.fields,
          alg: Schema.Literal('EdDSA'),
          kid: Schema.String,
          use: Schema.Literal('sig'),
        }),
      ),
    });
    const publicJwk = yield* Schema.decodeUnknownEffect(publicJwkSchema)(publicKey);
    const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(jwksSchema))({
      keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }],
    });
    const { child, commands, receive, send } = yield* launchReceiver(artifact);
    const bootstrap = {
      actor: fixture.manager,
      composition,
      databaseName: isolated.connections.runtime.database,
      issuer,
      jwks,
      legalEntityId: WholeCandidateCatalogProducedSchema.fields.legalEntityId.make(fixture.legalEntityId),
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
      type: 'bootstrap' as const,
      version,
    };
    // Strict equivalence needs a finite Current interval, which only a real scheduled successor provides.
    if (mode === 'strict-whole-candidate') {
      Object.assign(bootstrap, { scheduledConfiguration: true });
    }
    yield* send(bootstrap);
    const produced = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogProducedSchema)(yield* receive());
    expect(produced.actor).toEqual(fixture.manager);
    const [p1, p2, q1] = produced.selections;
    for (const resource of [p1.productRef, q1.productRef, p1.variantRef]) {
      yield* fixture.grantResourceAccess(resource, fixture.manager.principalId);
      yield* Effect.addFinalizer(() =>
        fixture.revokeResourceAccess(resource, fixture.manager.principalId).pipe(Effect.orDie),
      );
    }
    const authorization = Effect.fn('WholeCandidateNative.authorization')(function* authorization(
      options: {
        readonly actor?: typeof fixture.manager;
        readonly audience?: string;
        readonly expired?: boolean;
        readonly includeLegalEntity?: boolean;
      } = {},
    ) {
      const actor =
        options.includeLegalEntity === false
          ? (options.actor ?? fixture.manager)
          : { ...(options.actor ?? fixture.manager), legalEntityId: fixture.legalEntityId };
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000) - (options.expired === true ? 600 : 0);
      const headerSchema = Schema.Struct({
        alg: Schema.Literal('EdDSA'),
        kid: Schema.String,
        typ: Schema.Literal('JWT'),
      });
      const header = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(headerSchema))({ alg: 'EdDSA', kid, typ: 'JWT' }),
      ).toString('base64url');
      const claims = yield* decodeSupportedGatewayContextClaims({
        aud: options.audience ?? 'catalog',
        compositionRevision: composition.composition.revision,
        exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
        iat: now,
        iss: issuer,
        jti: yield* nextId,
        principal: actor,
        sub: actor.principalId,
        targetBuildMarker: produced.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      });
      const payload = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
      ).toString('base64url');
      const content = `${header}.${payload}`;
      const signature = yield* Effect.tryPromise({
        catch: () => unavailable('assertion-sign'),
        try: () => globalThis.crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(content)),
      });
      return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
    });
    yield* send({
      authorizations: [
        Redacted.make(yield* authorization()),
        Redacted.make(yield* authorization()),
        Redacted.make(yield* authorization()),
      ],
      type: 'prepare',
      version,
    });
    const ready = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogReadySchema)(yield* receive());
    const [handoffP1, handoffP2, handoffQ1] = ready.handoffs;
    expect(ready.handoffs.map((handoff) => handoff.status)).toEqual(['READY', 'READY', 'READY']);
    expect(ready.handoffs.map((handoff) => handoff.selection)).toEqual([p1, p2, q1]);
    const endpoint = {
      baseUrl: new URL(`http://127.0.0.1:${ready.port}`),
      compositionRevision: ready.compositionRevision,
    };
    // #1262: exact Product media and transport refusal remain observable before #1225's strict equivalence gate.
    expect(
      yield* executeCatalogMediaCurrentWithAuthorization(
        { target: p1.productRef },
        yield* authorization(),
        yield* nextId,
        endpoint,
      ),
    ).toMatchObject({ ordered: [], target: p1.productRef });
    const beforeTransportRefusal = yield* fixture.evidence(coreEvidenceExecutor);
    const http = yield* HttpClient.HttpClient;
    const quantityPayload = yield* Schema.encodeEffect(Schema.fromJsonString(QuantityPreparationRequestSchema))({
      amount: '1',
      purpose: 'PRICING',
      selection: p1,
    });
    for (const [credential, expectedStatus, problemSchema] of [
      [yield* authorization({ expired: true }), 401, QuantityPreparationAuthenticationProblemSchema],
      [yield* authorization({ actor: fixture.denied }), 403, QuantityPreparationForbiddenProblemSchema],
    ] as const) {
      const response = yield* http.execute(
        HttpClientRequest.post(new URL('/reads/quantity-preparation', endpoint.baseUrl)).pipe(
          HttpClientRequest.setHeaders({
            authorization: credential,
            'x-correlation-id': yield* nextId,
            'x-ontos-composition-revision': endpoint.compositionRevision,
          }),
          HttpClientRequest.bodyText(quantityPayload, 'application/json'),
        ),
      );
      expect(response.status).toBe(expectedStatus);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const serialized = yield* response.text;
      const problem = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(problemSchema), {
        onExcessProperty: 'error',
      })(serialized);
      expect(problem.status).toBe(expectedStatus);
      expect(serialized).not.toMatch(/\b(?:cause|stack|sql|postgres|spicedb|grpc|resolver|driver)\b/iu);
      expect(serialized).not.toContain(credential);
      expect(serialized).not.toContain('READY');
      expect(serialized).not.toContain('CONFIRMED');
    }
    expect((yield* fixture.evidence(coreEvidenceExecutor)).accesses).toEqual(beforeTransportRefusal.accesses);
    const equivalenceInput = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
      anchorSelection: p1,
      effectiveAt: handoffP1.evidence.assessedAt,
      members: [{ handoff: handoffP1, occurrenceId: 'original-P1' }],
    });
    const beforeFourReadResults = yield* fixture.evidence(coreEvidenceExecutor);
    const equivalence = yield* executePricingPurposeEquivalenceWithAuthorization(
      equivalenceInput,
      yield* authorization(),
      yield* nextId,
      endpoint,
    );
    if (mode === 'target-agreement') {
      // #1262 proves target admission and actual handler reach. Missing finite
      // Current authority remains an honest #1225 owner result, never a TTL fixture.
      assert(equivalence.outcome === 'CATALOG_EQUIVALENCE_UNVERIFIABLE');
      expect(equivalence.reason).toBe('Catalog cannot prove a finite Current interval for every exact selection');
    } else {
      expect(equivalence.outcome).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
    }
    if (mode === 'strict-whole-candidate') {
      const equalOccurrences = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
        anchorSelection: p1,
        effectiveAt: handoffP1.evidence.assessedAt,
        members: [
          { handoff: handoffP1, occurrenceId: 'original-P1-first' },
          { handoff: handoffP1, occurrenceId: 'original-P1-second' },
        ],
      });
      expect(
        (yield* executePricingPurposeEquivalenceWithAuthorization(
          equalOccurrences,
          yield* authorization(),
          yield* nextId,
          endpoint,
        )).outcome,
      ).toBe('CATALOG_EQUIVALENCE_CONFIRMED');
      const nonEquivalent = yield* Schema.decodeUnknownEffect(PricingPurposeEquivalenceRequestSchema)({
        anchorSelection: p1,
        effectiveAt: handoffP2.evidence.assessedAt,
        members: [
          { handoff: handoffP1, occurrenceId: 'original-P1' },
          { handoff: handoffP2, occurrenceId: 'original-P2' },
        ],
      });
      expect(
        (yield* executePricingPurposeEquivalenceWithAuthorization(
          nonEquivalent,
          yield* authorization(),
          yield* nextId,
          endpoint,
        )).outcome,
      ).not.toBe('CATALOG_EQUIVALENCE_CONFIRMED');
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(PricingPurposeEquivalenceRequestSchema)({
            anchorSelection: p1,
            effectiveAt: handoffQ1.evidence.assessedAt,
            members: [
              { handoff: handoffP1, occurrenceId: 'original-P1' },
              { handoff: handoffQ1, occurrenceId: 'original-Q1' },
            ],
          }),
        ),
      ).toBe(true);
    }
    const compatibilityInput = {
      effectiveAt: handoffP1.evidence.assessedAt,
      handoff: handoffP1,
      price: { quantity: handoffP1.quantity.resulting, quantityBasis: handoffP1.quantityBasis },
    };
    expect(
      (yield* executeQuantityBasisCompatibilityWithAuthorization(
        compatibilityInput,
        yield* authorization(),
        yield* nextId,
        endpoint,
      )).outcome,
    ).toBe('NO_CONVERSION_REQUIRED');
    expect(
      yield* executeCatalogMediaCurrentWithAuthorization(
        { target: p1.variantRef },
        yield* authorization(),
        yield* nextId,
        endpoint,
      ),
    ).toMatchObject({ ordered: [], target: p1.variantRef });
    if (mode === 'target-agreement') {
      const afterFourReadResults = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterFourReadResults.accesses.length).toBe(beforeFourReadResults.accesses.length + 3);
      const previousIds = new Set(beforeFourReadResults.accesses.map((access) => access.dataAccessEventId));
      const recorded = afterFourReadResults.accesses.filter((access) => !previousIds.has(access.dataAccessEventId));
      expect(recorded).toHaveLength(3);
      for (const access of recorded) {
        expect(access).toMatchObject({
          legalEntityId: fixture.legalEntityId,
          outcome: 'allowed',
          outcomeCode: 'read_allowed',
          outcomeStage: 'evidence',
          principalId: fixture.manager.principalId,
          targetModuleKey: 'commerce.catalog',
          tenantId: fixture.tenantId,
        });
      }
      expect(recorded.filter((access) => access.targetResourceId === p1.productRef.resourceId)).toHaveLength(2);
      expect(recorded.filter((access) => access.targetResourceId === p1.variantRef.resourceId)).toHaveLength(1);
    }
    const reused = yield* authorization();
    expect(
      (yield* executeQuantityPreparationWithAuthorization(
        { amount: '1', purpose: 'PRICING', selection: p1 },
        reused,
        yield* nextId,
        endpoint,
      )).status,
    ).toBe('READY');
    expect(
      Schema.is(QuantityPreparationAuthenticationProblemSchema)(
        yield* executeQuantityPreparationWithAuthorization(
          { amount: '1', purpose: 'PRICING', selection: p1 },
          reused,
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    for (const credential of [yield* authorization({ expired: true }), yield* authorization({ audience: 'pricing' })]) {
      expect(
        Schema.is(QuantityPreparationAuthenticationProblemSchema)(
          yield* executeQuantityPreparationWithAuthorization(
            { amount: '1', purpose: 'PRICING', selection: p1 },
            credential,
            yield* nextId,
            endpoint,
          ).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    // Same active manager/context grants, but exact resource read is independently denied.
    yield* fixture.revokeResourceAccess(p1.productRef, fixture.manager.principalId);
    expect(
      Schema.is(QuantityPreparationForbiddenProblemSchema)(
        yield* executeQuantityPreparationWithAuthorization(
          { amount: '1', purpose: 'PRICING', selection: p1 },
          yield* authorization(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingPurposeEquivalenceForbiddenProblemSchema)(
        yield* executePricingPurposeEquivalenceWithAuthorization(
          equivalenceInput,
          yield* authorization(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      Schema.is(QuantityBasisCompatibilityForbiddenProblemSchema)(
        yield* executeQuantityBasisCompatibilityWithAuthorization(
          compatibilityInput,
          yield* authorization(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      yield* executeCatalogMediaCurrentWithAuthorization(
        { target: p1.variantRef },
        yield* authorization(),
        yield* nextId,
        endpoint,
      ),
    ).toMatchObject({ target: p1.variantRef });
    yield* fixture.revokeResourceAccess(p1.variantRef, fixture.manager.principalId);
    expect(
      Schema.is(CatalogMediaCurrentForbiddenProblemSchema)(
        yield* executeCatalogMediaCurrentWithAuthorization(
          { target: p1.variantRef },
          yield* authorization(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    // All tuples belong to these fresh fixture Resources; existing finalizers own their restoration/revocation.
    yield* fixture.grantResourceAccess(p1.productRef, fixture.manager.principalId);
    yield* fixture.grantResourceAccess(p1.variantRef, fixture.manager.principalId);
    const beforeDenied = yield* fixture.evidence(coreEvidenceExecutor);
    const deniedCredential = () => authorization({ actor: fixture.denied });
    expect(
      Schema.is(QuantityPreparationForbiddenProblemSchema)(
        yield* executeQuantityPreparationWithAuthorization(
          { amount: '1', purpose: 'PRICING', selection: p1 },
          yield* deniedCredential(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      Schema.is(PricingPurposeEquivalenceForbiddenProblemSchema)(
        yield* executePricingPurposeEquivalenceWithAuthorization(
          equivalenceInput,
          yield* deniedCredential(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      Schema.is(QuantityBasisCompatibilityForbiddenProblemSchema)(
        yield* executeQuantityBasisCompatibilityWithAuthorization(
          compatibilityInput,
          yield* deniedCredential(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    expect(
      Schema.is(CatalogMediaCurrentForbiddenProblemSchema)(
        yield* executeCatalogMediaCurrentWithAuthorization(
          { target: p1.variantRef },
          yield* deniedCredential(),
          yield* nextId,
          endpoint,
        ).pipe(Effect.flip),
      ),
    ).toBe(true);
    const afterDenied = yield* fixture.evidence(coreEvidenceExecutor);
    expect(afterDenied.accesses).toEqual(beforeDenied.accesses);
    const invalidScopes = [{ includeLegalEntity: false }, { actor: { ...fixture.manager, tenantId: yield* nextId } }];
    for (const scope of invalidScopes) {
      expect(
        Schema.is(QuantityPreparationForbiddenProblemSchema)(
          yield* executeQuantityPreparationWithAuthorization(
            { amount: '1', purpose: 'PRICING', selection: p1 },
            yield* authorization(scope),
            yield* nextId,
            endpoint,
          ).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(PricingPurposeEquivalenceForbiddenProblemSchema)(
          yield* executePricingPurposeEquivalenceWithAuthorization(
            equivalenceInput,
            yield* authorization(scope),
            yield* nextId,
            endpoint,
          ).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(QuantityBasisCompatibilityForbiddenProblemSchema)(
          yield* executeQuantityBasisCompatibilityWithAuthorization(
            compatibilityInput,
            yield* authorization(scope),
            yield* nextId,
            endpoint,
          ).pipe(Effect.flip),
        ),
      ).toBe(true);
      expect(
        Schema.is(CatalogMediaCurrentForbiddenProblemSchema)(
          yield* executeCatalogMediaCurrentWithAuthorization(
            { target: p1.variantRef },
            yield* authorization(scope),
            yield* nextId,
            endpoint,
          ).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    expect((yield* fixture.evidence(coreEvidenceExecutor)).accesses).toEqual(afterDenied.accesses);
    if (mode === 'target-agreement') {
      const endpointScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(endpointScope, exit));
      const endpointLayer = yield* Layer.build(NodeHttpServer.layerTest).pipe(
        Effect.provideService(Scope.Scope, endpointScope),
      );
      const endpointServer = Context.get(endpointLayer, HttpServer.HttpServer);
      const closedAddress = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: Schema.Int }))(
        endpointServer.address,
      );
      yield* Scope.close(endpointScope, Exit.void);
      const beforeUnavailable = yield* fixture.evidence(coreEvidenceExecutor);
      const outage = yield* launchReceiver(artifact, { SPICEDB_ENDPOINT: `localhost:${closedAddress.port}` });
      yield* outage.send({
        actor: fixture.manager,
        composition,
        databaseName: isolated.connections.runtime.database,
        issuer,
        jwks,
        legalEntityId: WholeCandidateCatalogProducedSchema.fields.legalEntityId.make(fixture.legalEntityId),
        runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        selections: produced.selections,
        type: 'bootstrap-read-only',
        units: produced.units,
        version,
      });
      const outageReady = yield* Schema.decodeUnknownEffect(WholeCandidateCatalogProducedSchema)(
        yield* outage.receive(),
      );
      expect(outageReady.selections).toEqual(produced.selections);
      expect(outageReady.units).toEqual(produced.units);
      const outageCredential = yield* authorization();
      const unavailableResponse = yield* http.execute(
        HttpClientRequest.post(`http://127.0.0.1:${outageReady.port}/reads/quantity-preparation`).pipe(
          HttpClientRequest.setHeaders({
            authorization: outageCredential,
            'x-correlation-id': yield* nextId,
            'x-ontos-composition-revision': endpoint.compositionRevision,
          }),
          HttpClientRequest.bodyText(quantityPayload, 'application/json'),
        ),
      );
      expect(unavailableResponse.status).toBe(503);
      expect(unavailableResponse.headers['content-type']).toContain('application/problem+json');
      const unavailableBody = yield* unavailableResponse.text;
      const unavailableProblem = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(QuantityPreparationUnavailableProblemSchema),
        { onExcessProperty: 'error' },
      )(unavailableBody);
      expect(unavailableProblem.status).toBe(503);
      expect(unavailableBody).not.toMatch(/\b(?:cause|stack|sql|postgres|spicedb|grpc|resolver|driver)\b/iu);
      expect(unavailableBody).not.toContain(outageCredential);
      expect(unavailableBody).not.toContain('READY');
      expect(unavailableBody).not.toContain('CONFIRMED');
      const afterUnavailable = yield* fixture.evidence(coreEvidenceExecutor);
      expect(afterUnavailable.accesses).toEqual(beforeUnavailable.accesses);
      expect(afterUnavailable.invocations).toEqual(beforeUnavailable.invocations);
      yield* outage.send({ type: 'stop', version });
      yield* Queue.end(outage.commands);
      expect(yield* outage.child.exitCode).toBe(0);
      expect(
        (yield* executeQuantityPreparationWithAuthorization(
          { amount: '1', purpose: 'PRICING', selection: p1 },
          yield* authorization(),
          yield* nextId,
          endpoint,
        )).status,
      ).toBe('READY');
      yield* send({ type: 'stop', version });
      yield* Queue.end(commands);
      expect(yield* child.exitCode).toBe(0);
      return;
    }
    yield* send({ expectedRevision: 1, type: 'revise-first-unit', version });
    expect(yield* receive()).toMatchObject({ ruleRevision: 2, type: 'revised' });
    expect(
      (yield* executeQuantityBasisCompatibilityWithAuthorization(
        compatibilityInput,
        yield* authorization(),
        yield* nextId,
        endpoint,
      )).outcome,
    ).not.toBe('NO_CONVERSION_REQUIRED');
    const refreshed = yield* executeQuantityPreparationWithAuthorization(
      { amount: '1', purpose: 'PRICING', selection: p1 },
      yield* authorization(),
      yield* nextId,
      endpoint,
    );
    assert(refreshed.status === 'READY');
    // The targets are indivisible, so the finer 0.5 step keeps the whole amount; only the revised rule changes.
    expect(refreshed.quantity).toMatchObject({ resulting: '1', step: '0.5', unitRuleRevision: 2 });
    expect(
      (yield* executeQuantityBasisCompatibilityWithAuthorization(
        {
          effectiveAt: refreshed.evidence.assessedAt,
          handoff: refreshed,
          price: { quantity: refreshed.quantity.resulting, quantityBasis: refreshed.quantityBasis },
        },
        yield* authorization(),
        yield* nextId,
        endpoint,
      )).outcome,
    ).toBe('NO_CONVERSION_REQUIRED');
    yield* send({ type: 'stop', version });
    yield* Queue.end(commands);
    expect(yield* child.exitCode).toBe(0);
  }).pipe(Effect.scoped);

it.layer(services, { excludeTestServices: true })((suite) => {
  suite.effect(
    'receives real Catalog READY, equivalence, compatibility and media with one native Core identity',
    () => runCatalogReceiver('strict-whole-candidate'),
    120_000,
  );
  suite.effect(
    '#1262 admits four exact resource targets through public Core gates and preserves security refusals',
    () => runCatalogReceiver('target-agreement'),
    120_000,
  );
});

it('keeps the whole-candidate process protocol closed and describes only the fixed setup Actions', () => {
  const description = {
    actionKeys: wholeCandidateCatalogActionKeys,
    appId: 'catalog',
    buildMarker: 'TEST-build',
    type: 'description',
    version,
  };
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(WholeCandidateCatalogDescriptionSchema, { onExcessProperty: 'error' })(description),
    ),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(WholeCandidateCatalogDescriptionSchema, { onExcessProperty: 'error' })({
        ...description,
        runtimeConnectionString: 'TEST-private-not-output',
      }),
    ),
  ).toBe(true);
  expect(
    Option.isSome(
      Schema.decodeUnknownOption(WholeCandidateCatalogCommandSchema, { onExcessProperty: 'error' })({
        expectedRevision: 1,
        type: 'revise-first-unit',
        version,
      }),
    ),
  ).toBe(true);
  expect(
    Option.isNone(
      Schema.decodeUnknownOption(WholeCandidateCatalogCommandSchema, { onExcessProperty: 'error' })({
        expectedRevision: 1,
        sql: 'TEST-forbidden-generic-command',
        type: 'revise-first-unit',
        version,
      }),
    ),
  ).toBe(true);
});

it('encodes private process credentials as wire strings and redacts them after decoding', () => {
  const schema = Schema.fromJsonString(WholeCandidateCatalogPrepareSchema);
  const authorizations = [
    Redacted.make('TEST-only-P1'),
    Redacted.make('TEST-only-P2'),
    Redacted.make('TEST-only-Q1'),
  ] as const;
  const wire = Schema.encodeSync(schema)({ authorizations, type: 'prepare', version });
  const decoded = Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(wire);
  expect(decoded.authorizations.map(Redacted.value)).toEqual(['TEST-only-P1', 'TEST-only-P2', 'TEST-only-Q1']);
});
