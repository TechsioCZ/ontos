import type { DatabaseConnectionPair } from '@app/core-runtime';
import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import { createHash } from 'node:crypto';
import { makeLiveOperationFixture, makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
  makeContextPermissionRelationshipMutationLive,
  ReadRuntime,
  runAction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { CreatePartyPayloadSchema } from '@app/party-registry/api';
import {
  createPartyWithAuthorization,
  executePartyDetailWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
} from '@app/party-registry/api/client';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { SignJWT, decodeJwt, exportJWK, generateKeyPair } from 'jose';
import {
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { TestClock } from 'effect/testing';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createProcessingPurposeAction } from '../../src/actions/create-processing-purpose.action.ts';
import { assignPrivacyResponsibilityAction } from '../../src/actions/assign-privacy-responsibility.action.ts';
import { AssignPrivacyResponsibilityPayloadSchema } from '../../shared/actions/assign-privacy-responsibility.ts';
import { recordApplicabilityPolicyAction } from '../../src/actions/record-applicability-policy.action.ts';
import { recordPrivacyApplicabilityAction } from '../../src/actions/record-privacy-applicability.action.ts';
import { assignLegalBasisAction } from '../../src/actions/assign-legal-basis.action.ts';
import { upsertRetentionRuleAction } from '../../src/actions/upsert-retention-rule.action.ts';
import { UpsertRetentionRulePayloadSchema } from '../../shared/actions/upsert-retention-rule.ts';
import { createProcessingActivityAction } from '../../src/actions/create-processing-activity.action.ts';
import { transitionProcessingActivityAction } from '../../src/actions/transition-processing-activity.action.ts';
import {
  PrivacyApplicabilityBusinessFactAuthority,
  privacyApplicabilityBusinessFactAuthorityUnavailable,
} from '../../src/actions/privacy-applicability-business-fact-authority-service.ts';
import {
  RetentionRuleGovernanceAuthority,
  retentionRuleGovernanceAuthorityUnavailable,
} from '../../src/actions/retention-rule-governance-authority.ts';
import { ProcessingActivityCoverageAuthority } from '../../src/actions/processing-activity-coverage-authority.ts';
import { PrivacyActionRejected } from '../../src/actions/privacy-action-rejected.ts';
import { ProcessingActivityRegistryError } from '../../src/domain/processing-activity-registry.ts';
import {
  PrivacyApplicabilityAuthoritySchema,
  PrivacyApplicabilityPolicySchema,
  PrivacyApplicabilityScopeSchema,
} from '../../shared/domain/privacy-applicability.ts';
import { PrivacyResponsibilityAssignmentSchema } from '../../shared/domain/privacy-responsibility-assignment.ts';
import { PrivacyLegalBasisAssignmentInputSchema } from '../../shared/domain/privacy-legal-basis.ts';
import {
  PrivacyRetentionRuleUpsertRequestSchema,
  RetentionRuleAuthorityResolutionSchema,
} from '../../shared/domain/privacy-retention-rule.ts';
import { CreateProcessingActivityInputSchema } from '../../shared/domain/processing-activity.ts';
import { ProcessingActivityAuthoritativeCoverageSchema } from '../../shared/domain/processing-coverage.ts';
import { responsibilityAssignmentsRead } from '../../src/api/responsibility-assignments.read.ts';
import { legalBasisAssignmentsRead } from '../../src/api/legal-basis-assignments.read.ts';
import { processingActivitiesRead } from '../../src/api/processing-activities.read.ts';

const appRoot = new URL('../../../../', import.meta.url).pathname;
class PrivacyPartyNativeIdentityError extends Schema.TaggedError<PrivacyPartyNativeIdentityError>()(
  'PrivacyPartyNativeIdentityError',
  { stage: Schema.String },
) {}
const identityFailure = (stage: string) => new PrivacyPartyNativeIdentityError({ stage });

const partyNativeCloneTargetMatches = (
  connections: DatabaseConnectionPair,
  source: DatabaseConnectionPair,
  databaseName: string,
): boolean =>
  connections.admin.host === connections.runtime.host &&
  connections.admin.port === connections.runtime.port &&
  connections.admin.database !== source.admin.database &&
  connections.admin.database !== source.runtime.database &&
  connections.admin.database === databaseName &&
  connections.runtime.database === databaseName &&
  /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(databaseName);

// Fixed root-owned setup CLI: metadata-only request/status; credentials stay in its explicit environment.
const preparePartyNativeIdentities = Effect.fn('PrivacyPartyNative.prepareIdentities')(
  function* preparePartyNativeIdentities(connections: DatabaseConnectionPair) {
    // Read physical identity from the creator-owned clone after owner fixture preparation.
    const services = yield* Layer.build(
      PgClient.layer({ maxConnections: 1, url: Redacted.make(connections.admin.connectionString) }).pipe(
        Layer.provideMerge(Reactivity.layer),
      ),
    );
    const admin = Context.get(services, PgClient.PgClient);
    const [capability] = yield* admin
      .unsafe(
        'select current_database() as "databaseName", d.oid::text as "databaseOid", (pg_control_system()).system_identifier::text as "systemIdentifier" from pg_database d where d.datname=current_database()',
      )
      .pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Tuple([
              Schema.Struct({
                databaseName: Schema.String,
                databaseOid: Schema.String,
                systemIdentifier: Schema.String,
              }),
            ]),
          ),
        ),
      );
    const source = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' }).pipe(
      Effect.mapError(() => identityFailure('Canonical fixture database configuration was unavailable')),
    );
    if (!partyNativeCloneTargetMatches(connections, source, capability.databaseName)) {
      return yield* identityFailure('Canonical native fixture clone target was refused');
    }
    const urls: Record<string, string> = {};
    for (const identity of [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY]) {
      const canonical = yield* loadDatabaseConfig({ envPath: '/dev/null', identity }).pipe(
        Effect.mapError(() => identityFailure('Canonical fixture identity configuration was unavailable')),
      );
      const address = new URL(canonical.connectionString);
      if (
        canonical.database !== source.runtime.database ||
        canonical.host !== source.runtime.host ||
        canonical.port !== source.runtime.port ||
        canonical.user !== identity.role ||
        canonical.host !== connections.admin.host ||
        canonical.port !== connections.admin.port ||
        !['localhost', '127.0.0.1'].includes(canonical.host) ||
        address.search !== '' ||
        address.hash !== ''
      ) {
        return yield* identityFailure('Canonical native fixture identity target was refused');
      }
      address.pathname = `/${capability.databaseName}`;
      urls[identity.urlKey] = address.href;
    }
    const issuerUrl = urls.SHELL_GATEWAY_ISSUER_DATABASE_URL;
    const requestUrl = urls.PARTY_REGISTRY_DATABASE_URL;
    if (issuerUrl === undefined || requestUrl === undefined) {
      return yield* identityFailure('Canonical native fixture identities were incomplete');
    }
    const child = yield* ChildProcess.make(
      process.execPath,
      [
        `${appRoot}/scripts/integration/support/privacy-native-database-identities.mts`,
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              creatorPid: Schema.Int,
              databaseName: Schema.String,
              databaseOid: Schema.String,
              systemIdentifier: Schema.String,
              type: Schema.Literal('prepare-privacy-native-identities'),
            }),
          ),
        )({ ...capability, creatorPid: process.pid, type: 'prepare-privacy-native-identities' }),
      ],
      {
        cwd: appRoot,
        env: {
          DATABASE_ADMIN_URL: connections.admin.connectionString,
          DATABASE_URL: connections.runtime.connectionString,
          ...urls,
        },
        extendEnv: false,
        stderr: 'pipe',
        stdout: 'pipe',
      },
    );
    const [lines, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: 3 },
    );
    if (code !== 0 || lines.length !== 1) {
      return yield* identityFailure('Fixed native fixture identity setup failed');
    }
    yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          databaseName: Schema.Literal(capability.databaseName),
          databaseOid: Schema.Literal(capability.databaseOid),
          systemIdentifier: Schema.Literal(capability.systemIdentifier),
          type: Schema.Literal('privacy-native-identities-prepared'),
        }),
      ),
    )(lines[0], { onExcessProperty: 'error' }).pipe(
      Effect.mapError(() => identityFailure('Fixed native fixture identity proof was refused')),
    );
    return { PARTY_REGISTRY_DATABASE_URL: requestUrl, SHELL_GATEWAY_ISSUER_DATABASE_URL: issuerUrl };
  },
);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerMarkerSchema = Schema.Struct({ appId: Schema.Literal('party-registry'), buildMarker: Schema.String });
const ownerReadySchema = Schema.Struct({ marker: ownerMarkerSchema, port: Schema.Number });
const publicProofServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const makeControllerOwner = Effect.fn('ControllerOwnerTest.makeFixture')(function* makeControllerOwner() {
  const crypto = yield* Crypto.Crypto;
  const nextId = () => crypto.randomUUIDv4();
  const suffix = yield* nextId();
  const fs = yield* FileSystem.FileSystem;
  const artifact = `${appRoot}verticals/party-registry/node_modules/.cache/ontos-1272/${suffix}.mjs`;
  yield* Effect.addFinalizer(() => fs.remove(artifact, { force: true }).pipe(Effect.orDie));
  const bundler = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      'exec',
      'esbuild',
      'verticals/party-registry/tests/support/tenant-party-http.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--packages=external',
      `--outfile=${artifact}`,
    ],
    { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  const [bundleExit] = yield* Effect.all(
    [bundler.exitCode, Stream.runDrain(bundler.stdout), Stream.runDrain(bundler.stderr)],
    { concurrency: 3 },
  );
  expect(bundleExit).toBe(0);
  const describe = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
    cwd: appRoot,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [markerLines, describeExit] = yield* Effect.all(
    [
      describe.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      describe.exitCode,
      Stream.runDrain(describe.stderr),
    ],
    { concurrency: 3 },
  );
  expect(describeExit).toBe(0);
  const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ownerMarkerSchema))(markerLines[0]);
  expect(marker.appId).toBe('party-registry');
  const base = yield* makeApplicationCompositionSnapshotFixture(
    [marker.appId, ultramodernApiMarker.appId],
    marker.buildMarker,
  );
  const modules = yield* Effect.forEach(
    base.composition.modules,
    Effect.fn('ControllerOwnerTest.moduleContract')(function* moduleContract(module) {
      const ownerId = module.deployment.appId === 'party-registry' ? 'party.registry' : 'privacy.core';
      const deployment =
        module.deployment.appId === 'party-registry'
          ? marker
          : { appId: ultramodernApiMarker.appId, buildMarker: ultramodernApiMarker.buildMarker };
      const old = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
        module.contractDocument,
      );
      const document = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))({
        ...old,
        deployment,
        manifest: { ...old.manifest, module: { ...old.manifest.module, id: ownerId } },
      });
      const hash = digest(document);
      return {
        ...module,
        backend: {
          baseUrl: `https://${module.deployment.appId}.fixture.example.test/`,
          transport: 'node-http' as const,
        },
        contract: { ...module.contract, sha256: hash },
        contractDocument: document,
        deployment,
        moduleId: ownerId,
        publicContract: { ...module.publicContract, id: ownerId, sha256: hash },
      };
    }),
    { concurrency: 2 },
  );
  const composition = { ...base.composition, modules };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: {
      ...composition,
      revision: digest(canonicalizeApplicationComposition({ ...composition, revision: '0'.repeat(64) })),
    },
  });
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1272-party-controller',
  });
  expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
  expect(isolated.connections.runtime.database.startsWith('ontos_test_party_gateway_')).toBe(true);
  const snapshotJson = yield* Schema.encodeEffect(Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema))(
    snapshot,
  );
  const source = yield* HttpServer.HttpServer;
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotJson, { contentType: 'application/json' })));
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
    return yield* Effect.die('The composition source requires a test TCP address');
  }
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        'party.registry.create-party',
        'party.registry.resolve-duplicate-candidate-create',
        createProcessingPurposeAction.descriptor.actionKey,
        assignPrivacyResponsibilityAction.descriptor.actionKey,
        recordApplicabilityPolicyAction.descriptor.actionKey,
        recordPrivacyApplicabilityAction.descriptor.actionKey,
        assignLegalBasisAction.descriptor.actionKey,
        upsertRetentionRuleAction.descriptor.actionKey,
        createProcessingActivityAction.descriptor.actionKey,
        transitionProcessingActivityAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['party-registry', 'privacy'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['party.registry', 'privacy.core'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const coreEvidenceServices = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceServices));
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    ...fixture.manager,
    legalEntityId: fixture.legalEntityId,
  });
  const permissions = yield* makeContextPermissionRelationshipMutationLive();
  for (const permission of [
    'privacy.responsibility.read',
    'privacy.legal_basis.read',
    'privacy.processing_catalog.read',
  ]) {
    const target = { moduleId: 'privacy.core', permission };
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
  const nativeIdentityUrls = yield* preparePartyNativeIdentities(isolated.connections);
  const issuerServices = yield* Layer.build(
    PgClient.layer({
      maxConnections: 1,
      url: Redacted.make(nativeIdentityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL),
    }).pipe(Layer.provideMerge(Reactivity.layer)),
  );
  const registrar = makeGatewayScopeGrantRegistrar(Context.get(issuerServices, PgClient.PgClient));
  const transport = yield* Config.all({
    PATH: Config.String('PATH'),
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const jwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
  const issuer = 'https://privacy-owner-fixture.example.test';
  const kid = `controller-owner-${suffix}`;
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_URL: isolated.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${source.address.port}/composition`,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...jwk, alg: 'EdDSA', kid, use: 'sig' }] }),
      PARTY_REGISTRY_DATABASE_URL: nativeIdentityUrls.PARTY_REGISTRY_DATABASE_URL,
      PATH: transport.PATH,
      SPICEDB_CA_CERT: transport.SPICEDB_CA_CERT,
      SPICEDB_ENDPOINT: transport.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(transport.SPICEDB_PRESHARED_KEY),
    },
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const firstLine = yield* Deferred.make<string>();
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Deferred.succeed(firstLine, line).pipe(Effect.asVoid)),
    Effect.forkScoped,
  );
  const first = yield* Deferred.await(firstLine);
  expect(first.length).toBeGreaterThan(0);
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ownerReadySchema))(first);
  expect(ready.marker).toEqual(marker);
  const baseUrl = `http://127.0.0.1:${ready.port}/party-registry-api`;
  const authorization = Effect.fn('ControllerOwnerTest.authorization')(function* freshAuthorization() {
    const id = yield* nextId();
    const token = yield* Effect.tryPromise(() =>
      new SignJWT({
        compositionRevision: snapshot.composition.revision,
        principal,
        targetBuildMarker: marker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('party-registry')
        .setSubject(principal.principalId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .setJti(id)
        .sign(pair.privateKey),
    );
    const claims = yield* Schema.decodeUnknownEffect(Schema.Struct({ exp: Schema.Int, jti: Schema.Literal(id) }))(
      decodeJwt(token),
    );
    yield* registrar.register({
      assertion: Redacted.make(token),
      audience: 'party-registry',
      expiresAtEpochSeconds: claims.exp,
      jti: claims.jti,
      legalEntityId: fixture.legalEntityId,
      principalId: principal.principalId,
      tenantId: principal.tenantId,
    });
    return `Bearer ${token}`;
  });
  const context = yield* Layer.build(fixture.layer);
  const runtime = yield* ReadRuntime.pipe(Effect.provideContext(context));
  return { authorization, baseUrl, context, coreEvidenceExecutor, fixture, nextId, principal, runtime, snapshot };
});

const produceCanonicalController = Effect.fn('ControllerOwnerTest.produceCanonicalParty')(
  function* produceCanonicalController(
    owner: Effect.Success<ReturnType<typeof makeControllerOwner>>,
    partyType: 'PERSON' | 'ORGANIZATION',
  ) {
    const result = yield* createPartyWithAuthorization(
      yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)({
        candidate: {
          displayName: `Controller ${partyType}`,
          evidenceRefs: ['review/controller-arrangement'],
          officialIdentifiers: [],
          partyType,
          provenance: { method: 'DOCUMENT', source: 'controller-native-test' },
          subjectEvidence: [
            {
              basis: 'DIRECT_INTERACTION',
              evidenceRef: 'review/controller-arrangement',
              kind: 'ACTOR_ATTESTATION',
              observedSubject: partyType,
              statement: 'Observed one concrete real-world subject of the declared type',
              subjectKey: yield* owner.nextId(),
            },
          ],
          validFrom: '2020-01-01T00:00:00Z',
        },
      }),
      yield* owner.authorization(),
      {
        baseUrl: owner.baseUrl,
        compositionRevision: owner.snapshot.composition.revision,
        correlationId: yield* owner.nextId(),
        idempotencyKey: yield* owner.nextId(),
      },
    );
    const partyRef = yield* Effect.gen(function* resolveCanonicalCreate() {
      if (result.outcome === 'CREATED') {
        return result.partyRef;
      }
      if (result.outcome !== 'AMBIGUOUS') {
        return yield* Effect.die('Expected a new canonical Controller Party');
      }
      const review = yield* executeDuplicateCandidateDetailWithAuthorization(
        { caseRef: result.caseRef },
        yield* owner.authorization(),
        yield* owner.nextId(),
        { baseUrl: owner.baseUrl, compositionRevision: owner.snapshot.composition.revision },
      );
      const resolved = yield* resolveDuplicateCandidateCreateWithAuthorization(
        {
          caseRef: result.caseRef,
          expectedRevision: review.revision,
          reason: 'Reviewed canonical concrete Controller subject evidence',
        },
        yield* owner.authorization(),
        {
          baseUrl: owner.baseUrl,
          compositionRevision: owner.snapshot.composition.revision,
          correlationId: yield* owner.nextId(),
          idempotencyKey: yield* owner.nextId(),
        },
      );
      if (resolved.partyRef === null) {
        return yield* Effect.die('The actual Party review must produce a Party');
      }
      return resolved.partyRef;
    });
    const detail = yield* executePartyDetailWithAuthorization(
      { partyRef },
      yield* owner.authorization(),
      yield* owner.nextId(),
      { baseUrl: owner.baseUrl, compositionRevision: owner.snapshot.composition.revision },
    );
    expect(detail.party.partyType).toBe(partyType);
    return { detail, partyRef };
  },
);

const proveControllerArrangement = Effect.fn('ControllerOwnerTest.proveArrangement')(
  function* proveControllerArrangement(kind: 'PERSON' | 'ORGANIZATION' | 'LEGAL_ENTITY' | 'MIXED') {
    const owner = yield* makeControllerOwner();
    const { context, coreEvidenceExecutor, fixture, nextId, principal, runtime } = owner;
    const canonical =
      kind === 'LEGAL_ENTITY'
        ? undefined
        : yield* produceCanonicalController(owner, kind === 'ORGANIZATION' ? 'ORGANIZATION' : 'PERSON');
    const legalEntityController = Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema.fields.controllerRef)({
      moduleId: 'core.identity',
      resourceId: fixture.legalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: fixture.tenantId,
    });
    const controllers =
      canonical === undefined
        ? [legalEntityController]
        : [Schema.decodeUnknownSync(PrivacyApplicabilityAuthoritySchema.fields.controllerRef)(canonical.partyRef)];
    if (kind === 'MIXED') {
      controllers.push(legalEntityController);
    }
    const businessNow = DateTime.toEpochMillis(yield* DateTime.now);
    expect(businessNow).toBeLessThan(DateTime.toEpochMillis(owner.snapshot.validUntil));
    yield* Effect.gen(function* controllerBusinessOperations() {
      yield* TestClock.setTime(businessNow);
      const from = DateTime.formatIso(yield* DateTime.now);
      const transport = () =>
        Effect.gen(function* freshTransport() {
          return { correlationId: yield* nextId(), idempotencyKey: yield* nextId(), targetModuleKey: 'privacy.core' };
        });
      const purpose = yield* runAction({
        payload: {
          businessCode: 'ACCOUNT_SECURITY',
          effectiveFrom: from,
          governanceOwnerId: principal.principalId,
          meaning: 'Approved Controller processing arrangement',
        },
        principal,
        registration: createProcessingPurposeAction,
        transport: yield* transport(),
      }).pipe(Effect.provideContext(context));
      const version = Option.getOrThrow(Option.fromUndefinedOr(purpose.versions[0]));
      const ref = (resourceType: string, resourceId: string) => ({
        moduleId: 'privacy.core',
        resourceId,
        resourceType,
        tenantId: fixture.tenantId,
      });
      const actor = { principalId: principal.principalId, tenantId: fixture.tenantId };
      const scopeRef = { scopeId: yield* nextId(), scopeType: 'privacy.processing-scope' as const };
      const commonScope = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityScopeSchema)({
        facts: [
          { dimension: 'PROCESSING_PURPOSE', value: purpose.purposeRef.resourceId },
          { dimension: 'PROCESSING_PURPOSE_VERSION', value: version.versionId },
        ],
        operation: 'controller-processing',
        processingScopeRef: scopeRef,
      });
      const responsibilityRefs = yield* Effect.all(
        controllers.map(() =>
          nextId().pipe(Effect.map((id) => ref('privacy.core.privacy-responsibility-assignment', id))),
        ),
      );
      const responsibilities = yield* Effect.all(
        controllers.map((controller, index) =>
          Effect.gen(function* publicResponsibility() {
            const assignment = yield* Schema.decodeUnknownEffect(PrivacyResponsibilityAssignmentSchema)({
              actor,
              assignmentRef: responsibilityRefs[index],
              effectiveFrom: from,
              effectiveTo: null,
              holder: {
                holder: controller,
                holderKind: controller.moduleId === 'party.registry' ? 'PARTY' : 'LEGAL_ENTITY',
              },
              provenance: {
                decisionEvidenceRefs: ['test:approved-controller-arrangement'],
                reason: 'Explicit approved Controller arrangement; existence alone grants no role',
                recordedAt: from,
              },
              role: 'CONTROLLER',
              scopeRef,
            });
            const payload = yield* Schema.encodeEffect(AssignPrivacyResponsibilityPayloadSchema)({ assignment });
            return yield* runAction({
              payload,
              principal,
              registration: assignPrivacyResponsibilityAction,
              transport: yield* transport(),
            }).pipe(Effect.provideContext(context));
          }),
        ),
      );
      const policy = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityPolicySchema)({
        composition: { precedence: 1, strategy: 'EXPLICIT_PRECEDENCE' },
        effectiveFrom: from,
        effectiveTo: null,
        factPredicates: [
          {
            dimension: 'CONTROLLER_SCOPE',
            operator: 'ONE_OF',
            values: controllers.map(({ resourceId }) => resourceId),
          },
          { dimension: 'PROCESSING_PURPOSE', operator: 'EQUALS', values: [purpose.purposeRef.resourceId] },
          { dimension: 'PROCESSING_PURPOSE_VERSION', operator: 'EQUALS', values: [version.versionId] },
        ],
        jurisdictionProfile: { profileKey: 'test:controller-governance', profileVersion: '1' },
        mandatoryDimensions: ['CONTROLLER_SCOPE', 'PROCESSING_PURPOSE', 'PROCESSING_PURPOSE_VERSION'],
        policyKey: 'test:controller-policy',
        policyVersion: '1',
        scopeKey: `${scopeRef.scopeType}:${scopeRef.scopeId}:${commonScope.operation}`,
        sourceEvidenceRefs: ['test:controller-policy-evidence'],
      });
      yield* runAction({
        payload: { policy },
        principal,
        registration: recordApplicabilityPolicyAction,
        transport: yield* transport(),
      }).pipe(Effect.provideContext(context));
      const decisions = [];
      const bases = [];
      const rules = [];
      // Each Basis is produced immediately at its own decision's exact effective time. A later Controller decision cannot replace its provenance.
      for (const controller of controllers) {
        yield* TestClock.setTime(businessNow + decisions.length + 1);
        const at = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* Schema.decodeUnknownEffect(PrivacyApplicabilityAuthoritySchema)({
          controllerRef: controller,
          legalEntityId: fixture.legalEntityId,
          purposeRef: purpose.purposeRef,
          purposeVersionRef: ref('privacy.core.processing-purpose-version', version.versionId),
          tenantId: fixture.tenantId,
        });
        const applicability = yield* runAction({
          payload: {
            decisionId: yield* nextId(),
            proposedActivity: true,
            responsibilityAssignmentRefs: responsibilityRefs,
            scope: { operation: commonScope.operation, processingScopeRef: scopeRef },
          },
          principal,
          registration: recordPrivacyApplicabilityAction,
          transport: yield* transport(),
        }).pipe(
          Effect.provideService(PrivacyApplicabilityBusinessFactAuthority, {
            ...privacyApplicabilityBusinessFactAuthorityUnavailable,
            // TEST DOUBLE: only this exact produced Controller/Purpose/Scope is admitted; default production bindings remain unavailable.
            resolve: (request) =>
              request.tenantId === fixture.tenantId &&
              request.legalEntityId === fixture.legalEntityId &&
              request.asOf === at &&
              request.scope.operation === commonScope.operation &&
              request.scope.processingScopeRef.scopeId === scopeRef.scopeId &&
              request.scope.processingScopeRef.scopeType === scopeRef.scopeType
                ? Effect.succeed({
                    asOf: at,
                    authority,
                    evidenceRefs: ['test:controller-arrangement'],
                    receiptRef: `test:receipt:${controller.resourceId}`,
                    scope: commonScope,
                    status: 'CURRENT' as const,
                  })
                : privacyApplicabilityBusinessFactAuthorityUnavailable.resolve(request),
          }),
          Effect.provideContext(context),
        );
        expect(applicability.outcome).toBe('APPLICABLE');
        expect(applicability.authority?.controllerRef).toEqual(controller);
        decisions.push(applicability);
        const assignment = yield* Schema.decodeUnknownEffect(PrivacyLegalBasisAssignmentInputSchema)({
          actor,
          assignmentRef: ref('privacy.core.legal-basis-assignment', yield* nextId()),
          basis: 'LEGAL_OBLIGATION',
          basisVersion: 'test:approved-v1',
          decision: 'APPROVED',
          effectiveFrom: at,
          effectiveTo: null,
          provenance: {
            decisionEvidenceRefs: ['test:controller-basis'],
            policyRef: policy.policyKey,
            policyVersion: policy.policyVersion,
            reason: 'Approved exact Controller basis',
            recordedAt: at,
          },
          scope: {
            controllerRef: controller.resourceId,
            operation: commonScope.operation,
            processingScopeRef: scopeRef,
            purposeRef: purpose.purposeRef,
            purposeVersionId: version.versionId,
          },
        });
        const basis = yield* runAction({
          payload: { assignment },
          principal,
          registration: assignLegalBasisAction,
          transport: yield* transport(),
        }).pipe(Effect.provideContext(context));
        expect(basis.applicabilityDecision).toEqual(applicability);
        bases.push(basis);
        const request = yield* Schema.decodeUnknownEffect(PrivacyRetentionRuleUpsertRequestSchema)({
          applicability: 'PROSPECTIVE_ONLY',
          businessStartRef: 'test:controller-start',
          contentScopeRef: 'controller-content',
          effectiveFrom: from,
          effectiveTo: null,
          retentionWindow: { durationDays: 365, kind: 'DURATION' },
          retroactiveApprovalRef: null,
          ruleRef: yield* nextId(),
          ruleVersion: 1,
        });
        const resolution = yield* Schema.decodeUnknownEffect(RetentionRuleAuthorityResolutionSchema)({
          asOf: at,
          legalEntityId: fixture.legalEntityId,
          rule: {
            ...Schema.encodeSync(PrivacyRetentionRuleUpsertRequestSchema)(request),
            authorityRef: 'test:controller-retention',
            businessStartAt: from,
            controllerRef: controller.resourceId,
            dispositionOutcome: 'DELETE',
            evidenceRefs: ['test:retention-evidence'],
            policyRef: 'test:retention-policy',
            policyVersion: 1,
            provenanceRef: 'test:retention-provenance',
            ruleVersionId: yield* nextId(),
          },
          status: 'CURRENT',
          tenantId: fixture.tenantId,
        });
        const rulePayload = yield* Schema.encodeEffect(UpsertRetentionRulePayloadSchema)({ request });
        const rule = yield* runAction({
          payload: rulePayload,
          principal,
          registration: upsertRetentionRuleAction,
          transport: yield* transport(),
        }).pipe(
          Effect.provideService(RetentionRuleGovernanceAuthority, {
            ...retentionRuleGovernanceAuthorityUnavailable,
            // TEST DOUBLE of the trusted governance service, never a replacement native repository.
            resolveRule: (current) =>
              current.tenantId === fixture.tenantId &&
              current.legalEntityId === fixture.legalEntityId &&
              current.principalId === principal.principalId &&
              current.asOf === at &&
              current.request.ruleRef === request.ruleRef &&
              current.request.ruleVersion === request.ruleVersion
                ? Effect.succeed(resolution)
                : Effect.fail(
                    new PrivacyActionRejected({
                      code: 'privacy_action_rejected',
                      reason: 'No exact test retention arrangement',
                    }),
                  ),
          }),
          Effect.provideContext(context),
        );
        rules.push(rule);
      }
      yield* TestClock.setTime(businessNow + 10);
      const at = DateTime.formatIso(yield* DateTime.now);
      const category = ref('privacy.core.data-category', yield* nextId());
      const system = ref('privacy.core.system-of-record', yield* nextId());
      const dataCoverage = [
        {
          dataCategoryRef: category,
          ownerCapability: 'test:controller-owner',
          ownerModuleId: 'privacy.core',
          recordContentScope: 'controller-content',
          systemOfRecordRef: system,
        },
      ];
      const processingScope = {
        applicabilityScope: commonScope,
        purposeRef: purpose.purposeRef,
        purposeVersionId: version.versionId,
        responsibilityAssignmentRefs: responsibilityRefs,
      };
      const retentionCoverage = rules.map((rule, index) => ({
        applicabilityDecisionRef: 'test:controller-policy-evidence',
        asOf: at,
        controllerRef: controllers[index],
        dataCategoryRefs: [category],
        legalEntityId: fixture.legalEntityId,
        purposeVersionId: version.versionId,
        recordContentScopes: ['controller-content'],
        ruleRef: ref('privacy.core.retention-rule', rule.ruleRef),
        ruleVersionId: rule.ruleVersionId,
        tenantId: fixture.tenantId,
      }));
      const activityInput = yield* Schema.decodeUnknownEffect(CreateProcessingActivityInputSchema)({
        applicabilityDecisions: decisions,
        dataCategoryRefs: [category],
        dataCoverage,
        legalBasisAssignmentRefs: bases.map(({ assignmentRef }) => assignmentRef),
        processingScope,
        recipientRefs: [],
        recipientTransfers: [],
        retentionCoverage,
        retentionRuleRefs: rules.map((rule) => ref('privacy.core.retention-rule', rule.ruleRef)),
        systemOfRecordRefs: [system],
      });
      const activity = yield* runAction({
        payload: activityInput,
        principal,
        registration: createProcessingActivityAction,
        transport: yield* transport(),
      }).pipe(Effect.provideContext(context));
      const coverage = yield* Schema.decodeUnknownEffect(ProcessingActivityAuthoritativeCoverageSchema)({
        activityRef: activity.activityRef,
        applicabilityDecisions: decisions,
        authorityRef: 'test:controller-coverage',
        controllerRefs: controllers,
        dataCategoryRefs: [category],
        dataCoverage,
        evidenceRefs: ['test:owner-coverage'],
        legalEntityId: fixture.legalEntityId,
        observedAt: at,
        ownerCapabilityBindings: dataCoverage.map(({ recordContentScope: _scope, ...binding }) => binding),
        processingScope,
        processingScopeRef: scopeRef,
        recipientRefs: [],
        recipientTransfers: [],
        retentionCoverage,
        revision: '1',
        systemOfRecordRefs: [system],
        tenantId: fixture.tenantId,
      });
      const coverageService = {
        resolve: (request: Parameters<typeof ProcessingActivityCoverageAuthority.Service.resolve>[0]) =>
          request.tenantId === fixture.tenantId &&
          request.legalEntityId === fixture.legalEntityId &&
          request.principalId === principal.principalId &&
          request.activityRef.resourceId === activity.activityRef.resourceId &&
          request.activityRef.moduleId === activity.activityRef.moduleId &&
          request.activityRef.resourceType === activity.activityRef.resourceType &&
          request.activityRef.tenantId === activity.activityRef.tenantId
            ? Effect.succeed(coverage)
            : Effect.fail(
                new ProcessingActivityRegistryError({
                  code: 'privacy_processing_activity_transition_rejected',
                  reason: 'No exact test coverage arrangement',
                }),
              ),
      };
      expect(
        yield* Effect.flip(
          runtime
            .runRead({
              input: { activityRefs: [activity.activityRef], includeEnded: false },
              principal,
              registration: processingActivitiesRead,
              transport: { correlationId: yield* nextId() },
            })
            .pipe(Effect.provideContext(context)),
        ),
      ).toMatchObject({ code: 'read_permission_denied' });
      yield* fixture.grantResourceAccess(activity.activityRef, principal.principalId, 'writer');
      const beforeResponsibilities = yield* runtime
        .runRead({
          input: { asOf: at, scopeRefs: [scopeRef.scopeId] },
          principal,
          registration: responsibilityAssignmentsRead,
          transport: { correlationId: yield* nextId() },
        })
        .pipe(Effect.provideContext(context));
      const beforeBases = yield* runtime
        .runRead({
          input: { asOf: at, processingScopeRefs: [scopeRef.scopeId] },
          principal,
          registration: legalBasisAssignmentsRead,
          transport: { correlationId: yield* nextId() },
        })
        .pipe(Effect.provideContext(context));
      expect(beforeResponsibilities.items).toEqual(responsibilities);
      expect(beforeBases.items).toEqual(bases);
      const transitionTransport = yield* transport();
      const transition = {
        payload: {
          activityRef: activity.activityRef,
          decisionEvidenceRefs: ['test:approved-controller-arrangement'],
          effectiveAt: at,
          to: 'EFFECTIVE' as const,
        },
        principal,
        registration: transitionProcessingActivityAction,
        transport: transitionTransport,
      };
      if (kind === 'MIXED') {
        const beforeRejections = yield* fixture.evidence(coreEvidenceExecutor);
        for (const invalidCoverage of [
          { ...coverage, retentionCoverage: [] },
          { ...coverage, controllerRefs: coverage.controllerRefs.slice(1) },
          {
            ...coverage,
            applicabilityDecisions: coverage.applicabilityDecisions.map((decision) => ({
              ...decision,
              outcome: 'UNRESOLVED' as const,
            })),
          },
        ]) {
          expect(
            yield* Effect.flip(
              runAction({ ...transition, transport: yield* transport() }).pipe(
                Effect.provideService(ProcessingActivityCoverageAuthority, {
                  resolve: () => Effect.succeed(invalidCoverage),
                }),
                Effect.provideContext(context),
              ),
            ),
          ).toMatchObject({ code: 'privacy_processing_activity_transition_rejected' });
        }
        const noExecutor = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          ...fixture.legalEntityOnly,
          legalEntityId: fixture.legalEntityId,
        });
        expect(
          yield* Effect.flip(
            runAction({ ...transition, principal: noExecutor, transport: yield* transport() }).pipe(
              Effect.provideService(ProcessingActivityCoverageAuthority, coverageService),
              Effect.provideContext(context),
            ),
          ),
        ).toMatchObject({ code: 'action_permission_denied' });
        const stillProposed = yield* runtime
          .runRead({
            input: { activityRefs: [activity.activityRef], includeEnded: false },
            principal,
            registration: processingActivitiesRead,
            transport: { correlationId: yield* nextId() },
          })
          .pipe(Effect.provideContext(context));
        expect(stillProposed.items).toEqual([activity]);
        const afterRejections = yield* fixture.evidence(coreEvidenceExecutor);
        expect(afterRejections.events).toHaveLength(beforeRejections.events.length);
        expect(afterRejections.outbox).toHaveLength(beforeRejections.outbox.length);
        expect(afterRejections.invocations.filter(({ status }) => status === 'succeeded')).toHaveLength(
          beforeRejections.invocations.filter(({ status }) => status === 'succeeded').length,
        );
      }
      const effective = yield* runAction(transition).pipe(
        Effect.provideService(ProcessingActivityCoverageAuthority, coverageService),
        Effect.provideContext(context),
      );
      expect(effective.currentLifecycle).toBe('EFFECTIVE');
      expect(effective.lifecycle).toHaveLength(2);
      expect(
        yield* Effect.flip(
          runAction(transition).pipe(
            Effect.provideService(ProcessingActivityCoverageAuthority, coverageService),
            Effect.provideContext(context),
          ),
        ),
      ).toMatchObject({ code: 'action_already_committed' });
      const reloaded = yield* runtime
        .runRead({
          input: { activityRefs: [activity.activityRef], includeEnded: false },
          principal,
          registration: processingActivitiesRead,
          transport: { correlationId: yield* nextId() },
        })
        .pipe(Effect.provideContext(context));
      expect(reloaded.items).toEqual([effective]);
      expect(
        (yield* runtime
          .runRead({
            input: { asOf: at, scopeRefs: [scopeRef.scopeId] },
            principal,
            registration: responsibilityAssignmentsRead,
            transport: { correlationId: yield* nextId() },
          })
          .pipe(Effect.provideContext(context))).items,
      ).toEqual(beforeResponsibilities.items);
      expect(
        (yield* runtime
          .runRead({
            input: { asOf: at, processingScopeRefs: [scopeRef.scopeId] },
            principal,
            registration: legalBasisAssignmentsRead,
            transport: { correlationId: yield* nextId() },
          })
          .pipe(Effect.provideContext(context))).items,
      ).toEqual(beforeBases.items);
    }).pipe(Effect.provide(TestClock.layer()));
    if (canonical !== undefined) {
      const after = yield* executePartyDetailWithAuthorization(
        { partyRef: canonical.partyRef },
        yield* owner.authorization(),
        yield* nextId(),
        { baseUrl: owner.baseUrl, compositionRevision: owner.snapshot.composition.revision },
      );
      expect(after.party).toEqual(canonical.detail.party);
    }
  },
);

for (const arrangement of ['PERSON', 'ORGANIZATION', 'LEGAL_ENTITY', 'MIXED'] as const) {
  it.live(
    `keeps ${arrangement} Controller identity across actual Party/Privacy producers, native transition, replay and governed reload`,
    () =>
      proveControllerArrangement(arrangement).pipe(
        Effect.provide(publicProofServices),
        Effect.provide(NodeHttpServer.layerTest),
      ),
  );
}
