import { Reactivity } from 'effect/reactivity';
import { PgClient } from '@effect/sql-pg';
import type { DatabaseConnectionPair } from '@app/core-runtime';
import { CreatePartyPayloadSchema } from '@app/party-registry/api';
import { createHash } from 'node:crypto';
import { makeLiveOperationFixture, makeGatewayScopeGrantRegistrar } from '@app/core-runtime/testing/actions';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
  PARTY_REGISTRY_REQUEST_IDENTITY,
} from '@app/party-registry-identity-contracts';
import {
  loadDatabaseConnectionPair,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  canonicalizeApplicationComposition,
  OntosModuleDeploymentContractSchema,
  validateActiveApplicationCompositionSnapshot,
  makeContextPermissionRelationshipMutationLive,
  ReadRuntime,
  runAction,
  TrustedPrincipalContextSchema,
} from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  createPartyWithAuthorization,
  archivePartyWithAuthorization,
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
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';

import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import {
  PrivacySubjectPartyCredentials,
  PrivacySubjectPartyOwner,
  PrivacySubjectPartyOwnerLive,
} from '../../src/persistence/privacy-subject-party-owner.ts';
import { createPrivacySubjectAction } from '../../src/actions/create-privacy-subject.action.ts';
import { privacySubjectsRead } from '../../src/api/privacy-subjects.read.ts';
import { privacySubjects } from '../../src/database/schema.ts';
import { eq } from 'drizzle-orm';

import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { expect, it } from 'effect-rstest';

import { privacyOperationRepositoryForScope } from '../../src/persistence/privacy-operation-postgres-repository.ts';

it.live('rejects resolved person admission without authoritative Party proof in the native owner factory', () =>
  Effect.gen(function* unprovenPersonNative() {
    const native = yield* makeNativeReadTestContext({
      contextPermissions: ['privacy.subjects.read'],
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    });
    const crypto = yield* Crypto.Crypto;
    const subjectId = yield* crypto.randomUUIDv4();
    const partyId = yield* crypto.randomUUIDv4();
    const result = yield* Effect.result(
      native
        .prepareOwner(
          Effect.fn('unprovenPersonOwner')(function* unprovenPersonOwner(transaction, scope) {
            const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
            return yield* owner.createSubject(
              {
                legalEntityId: Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)),
                tenantId: scope.tenantId,
              },
              {
                actionInvocationId: yield* crypto.randomUUIDv4(),
                subject: {
                  createdAt: '2026-01-01T00:00:00Z',
                  subject: {
                    kind: 'DATA_SUBJECT',
                    partyRef: Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
                      moduleId: 'party.registry',
                      resourceId: partyId,
                      resourceType: 'party.registry.party',
                      tenantId: scope.tenantId,
                    }),
                  },
                  subjectRef: {
                    moduleId: 'privacy.core',
                    resourceId: subjectId,
                    resourceType: 'privacy.core.privacy-subject',
                    tenantId: scope.tenantId,
                  },
                  updatedAt: '2026-01-01T00:00:00Z',
                },
              },
            );
          }),
        )
        .pipe(Effect.provide(native.layer)),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ code: 'privacy_operation_persistence_unavailable' });
    }
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.live('foreign-only Subject references cannot select all trusted-Tenant records', () =>
  Effect.gen(function* exactForeignSubjectSelection() {
    const native = yield* makeNativeReadTestContext({
      contextPermissions: ['privacy.subjects.read'],
      moduleId: 'privacy.core',
      ownerFixtureRetention: 'retain-complete-context',
    });
    const crypto = yield* Crypto.Crypto;
    const created = yield* native
      .prepareOwner(
        Effect.fn('anonymousSubjectSelectionOwner')(function* anonymousSubjectSelectionOwner(transaction, scope) {
          const owner = yield* privacyOperationRepositoryForScope(transaction, scope);
          const subject = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
            createdAt: '2026-01-01T00:00:00Z',
            subject: {
              anonymousContext: {
                addressability: 'SESSION',
                contextRef: yield* crypto.randomUUIDv4(),
                createdAt: '2026-01-01T00:00:00Z',
                expiresAt: '2027-01-01T00:00:00Z',
                kind: 'ANONYMOUS_PRIVACY_CONTEXT',
                provenance: { method: 'SESSION', source: 'native-selection-test' },
              },
              kind: 'ANONYMOUS',
            },
            subjectRef: {
              moduleId: 'privacy.core',
              resourceId: yield* crypto.randomUUIDv4(),
              resourceType: 'privacy.core.privacy-subject',
              tenantId: scope.tenantId,
            },
            updatedAt: '2026-01-01T00:00:00Z',
          });
          return yield* owner.createSubject(
            { legalEntityId: Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId)), tenantId: scope.tenantId },
            { actionInvocationId: yield* crypto.randomUUIDv4(), subject },
          );
        }),
      )
      .pipe(Effect.provide(native.layer));
    const all = yield* native.runtime
      .runRead({
        input: { subjectRefs: [] },
        principal: native.principal,
        registration: privacySubjectsRead,
        transport: { correlationId: yield* crypto.randomUUIDv4() },
      })
      .pipe(Effect.provide(native.layer));
    expect(all.items).toEqual([created]);
    const foreign = yield* native.runtime
      .runRead({
        input: { subjectRefs: [{ ...created.subjectRef, tenantId: yield* crypto.randomUUIDv4() }] },
        principal: native.principal,
        registration: privacySubjectsRead,
        transport: { correlationId: yield* crypto.randomUUIDv4() },
      })
      .pipe(Effect.provide(native.layer));
    expect(foreign.items).toEqual([]);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

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
      const canonical = yield* loadDatabaseConnectionPair({ envPath: '/dev/null', identity })
        .pipe(Effect.map(({ runtime }) => runtime))
        .pipe(Effect.mapError(() => identityFailure('Canonical fixture identity configuration was unavailable')));
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
const publicProofServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(publicProofServices, { excludeTestServices: true })('actual Party owner HTTP → Privacy identity', (suite) => {
  suite.effect('admits only owner-proven PERSON through the registered Action and governed native Subject Read', () =>
    Effect.gen(function* personOwnerHttpAcceptance() {
      const crypto = yield* Crypto.Crypto;
      const nextId = () => crypto.randomUUIDv4();
      const suffix = yield* nextId();
      const fs = yield* FileSystem.FileSystem;
      const artifact = `${appRoot}verticals/party-registry/node_modules/.cache/ontos-1280/${suffix}.mjs`;
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
        Effect.fn('PersonOwnerTest.moduleContract')(function* moduleContract(module) {
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
        purpose: 'stabilization-1280-person-owner',
      });
      yield* Effect.logInfo('1280 isolated schema clone ready; source DDL lease released');
      expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
      expect(isolated.connections.runtime.database.startsWith('ontos_test_party_gateway_')).toBe(true);
      const snapshotJson = yield* Schema.encodeEffect(
        Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
      )(snapshot);
      const source = yield* HttpServer.HttpServer;
      yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotJson, { contentType: 'application/json' })));
      if (!Schema.is(Schema.Struct({ port: Schema.Number }))(source.address)) {
        return yield* Effect.die('The composition source requires a test TCP address');
      }
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [
            'party.registry.create-party',
            'party.registry.archive-party',
            'party.registry.resolve-duplicate-candidate-create',
            createPrivacySubjectAction.descriptor.actionKey,
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
      const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        ...fixture.manager,
        legalEntityId: fixture.legalEntityId,
      });
      const permissions = yield* makeContextPermissionRelationshipMutationLive();
      for (const target of [{ moduleId: 'privacy.core', permission: 'privacy.subjects.read' }]) {
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
      const registrar = makeGatewayScopeGrantRegistrar(
        Context.get(issuerServices, PgClient.PgClient),
        PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      );
      const transport = yield* Config.all({
        PATH: Config.String('PATH'),
        SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
        SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
        SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      });
      const pair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
      const jwk = yield* Effect.tryPromise(() => exportJWK(pair.publicKey));
      const issuer = 'https://privacy-owner-fixture.example.test';
      const kid = `person-owner-${suffix}`;
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
      const authorization = Effect.fn('PersonOwnerTest.authorization')(function* freshAuthorization() {
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
      const owner = yield* PrivacySubjectPartyOwner.pipe(
        Effect.provide(
          PrivacySubjectPartyOwnerLive.pipe(
            Layer.provide(
              Layer.succeed(PrivacySubjectPartyCredentials, {
                acquire: () =>
                  authorization().pipe(
                    Effect.map((value) => ({
                      authorization: Redacted.make(value),
                      baseUrl,
                      compositionRevision: snapshot.composition.revision,
                    })),
                    Effect.orDie,
                  ),
              }),
            ),
          ),
        ),
      );
      const context = yield* Layer.build(fixture.layer);
      const runtime = yield* ReadRuntime.pipe(Effect.provideContext(context));
      const createSubject = Effect.fn('PersonOwnerTest.createSubject')(function* createResolvedSubject(
        partyRef: typeof PrivacyPartyRefSchema.Type,
        subjectId: string,
        idempotencyKey: string,
      ) {
        yield* fixture.grantResourceAccess(
          { moduleId: 'privacy.core', resourceId: subjectId, resourceType: 'privacy.core.privacy-subject' },
          principal.principalId,
          'writer',
        );
        return yield* runAction({
          payload: {
            subject: { kind: 'DATA_SUBJECT', partyRef },
            subjectRef: {
              moduleId: 'privacy.core',
              resourceId: subjectId,
              resourceType: 'privacy.core.privacy-subject',
              tenantId: fixture.tenantId,
            },
          },
          principal,
          registration: createPrivacySubjectAction,
          transport: { correlationId: yield* nextId(), idempotencyKey, targetModuleKey: 'privacy.core' },
        }).pipe(Effect.provideService(PrivacySubjectPartyOwner, owner), Effect.provideContext(context));
      });
      const admittedSubjects: (typeof PrivacySubjectRecordSchema.Type)[] = [];
      const createdParties: { partyRef: typeof PrivacyPartyRefSchema.Type; partyType: string; revision: number }[] = [];
      for (const partyType of ['PERSON', 'ORGANIZATION', 'UNRESOLVED'] as const) {
        const result = yield* createPartyWithAuthorization(
          yield* Schema.decodeUnknownEffect(CreatePartyPayloadSchema)({
            candidate: {
              displayName: `Privacy ${partyType}`,
              evidenceRefs: ['review/privacy-owner'],
              officialIdentifiers: [],
              partyType,
              provenance: { method: 'DOCUMENT', source: 'privacy-owner-native' },
              subjectEvidence: [
                {
                  basis: 'DIRECT_INTERACTION',
                  evidenceRef: 'review/privacy-owner',
                  kind: 'ACTOR_ATTESTATION',
                  observedSubject: partyType === 'UNRESOLVED' ? 'CONCRETE_SUBJECT' : partyType,
                  statement: 'Observed one concrete real-world subject of the declared type',
                  subjectKey: yield* nextId(),
                },
              ],
              validFrom: '2020-01-01T00:00:00Z',
            },
          }),
          yield* authorization(),
          {
            baseUrl,
            compositionRevision: snapshot.composition.revision,
            correlationId: yield* nextId(),
            idempotencyKey: yield* nextId(),
          },
        );
        const producedRef = yield* Effect.gen(function* resolveSupportedPartyReview() {
          if (result.outcome === 'CREATED') {
            return result.partyRef;
          }
          if (result.outcome !== 'AMBIGUOUS') {
            return yield* Effect.die('The new candidate unexpectedly matched an existing Party');
          }
          const review = yield* executeDuplicateCandidateDetailWithAuthorization(
            { caseRef: result.caseRef },
            yield* authorization(),
            yield* nextId(),
            { baseUrl, compositionRevision: snapshot.composition.revision },
          );
          expect(review.lifecycleState).toBe('OPEN');
          const resolved = yield* resolveDuplicateCandidateCreateWithAuthorization(
            {
              caseRef: result.caseRef,
              expectedRevision: review.revision,
              reason: 'Reviewed the owner-accepted concrete subject evidence; no strong identifier is available',
            },
            yield* authorization(),
            {
              baseUrl,
              compositionRevision: snapshot.composition.revision,
              correlationId: yield* nextId(),
              idempotencyKey: yield* nextId(),
            },
          );
          expect(resolved.outcome).toBe('CREATE_NEW');
          if (resolved.partyRef === null) {
            return yield* Effect.die('The reviewed owner decision did not produce a Party');
          }
          return resolved.partyRef;
        });
        const detail = yield* executePartyDetailWithAuthorization(
          { partyRef: producedRef },
          yield* authorization(),
          yield* nextId(),
          { baseUrl, compositionRevision: snapshot.composition.revision },
        );
        expect(detail.party.partyType).toBe(partyType);
        expect(detail.resolution.kind).toBe('DIRECT');
        const ref = yield* Schema.decodeUnknownEffect(PrivacyPartyRefSchema)(producedRef);
        createdParties.push({ partyRef: ref, partyType, revision: detail.party.revision });
        const subjectId = yield* nextId();
        const key = yield* nextId();
        if (partyType === 'PERSON') {
          const created = yield* createSubject(ref, subjectId, key);
          admittedSubjects.push(created);
          expect(created.subject).toEqual({ kind: 'DATA_SUBJECT', partyRef: ref });
          expect(created.ownerAdmission).toMatchObject({ ownerRevision: detail.party.revision, partyRef: ref });
          expect(created.ownerAdmission?.typeAssertions.length).toBeGreaterThan(0);
          const changedIdentity = yield* Effect.flip(
            createSubject(
              Schema.decodeUnknownSync(PrivacyPartyRefSchema)({ ...ref, resourceId: yield* nextId() }),
              subjectId,
              yield* nextId(),
            ),
          );
          expect(changedIdentity).toMatchObject({ code: 'privacy_operation_conflict' });
          expect(yield* Effect.flip(createSubject(ref, subjectId, key))).toMatchObject({
            code: 'action_already_committed',
          });
          const listed = yield* runtime
            .runRead({
              input: { subjectRefs: [created.subjectRef] },
              principal,
              registration: privacySubjectsRead,
              transport: { correlationId: yield* nextId() },
            })
            .pipe(Effect.provideService(PrivacySubjectPartyOwner, owner), Effect.provideContext(context));
          expect(listed.items).toEqual([created]);
        } else {
          const rejected = yield* Effect.flip(createSubject(ref, subjectId, key));
          expect(rejected).toMatchObject({ code: 'privacy_operation_persistence_unavailable' });
          const rows = yield* fixture
            .prepareOwner(
              (transaction) =>
                transaction.select().from(privacySubjects).where(eq(privacySubjects.privacySubjectId, subjectId)),
              'required',
            )
            .pipe(Effect.provideContext(context));
          expect(rows).toHaveLength(0);
        }
      }
      expect(createdParties.map((party) => party.partyType)).toEqual(['PERSON', 'ORGANIZATION', 'UNRESOLVED']);
      const rejectedRefs = [
        Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
          moduleId: 'party.registry',
          resourceId: yield* nextId(),
          resourceType: 'party.registry.party',
          tenantId: fixture.tenantId,
        }),
        Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
          moduleId: 'party.registry',
          resourceId: yield* nextId(),
          resourceType: 'party.registry.party',
          tenantId: yield* nextId(),
        }),
      ];
      for (const rejectedRef of rejectedRefs) {
        const rejectedSubjectId = yield* nextId();
        const rejectedAdmission = yield* Effect.flip(createSubject(rejectedRef, rejectedSubjectId, yield* nextId()));
        expect(rejectedAdmission).toMatchObject({ code: 'privacy_operation_persistence_unavailable' });
        const rejectedRows = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.select().from(privacySubjects).where(eq(privacySubjects.privacySubjectId, rejectedSubjectId)),
            'required',
          )
          .pipe(Effect.provideContext(context));
        expect(rejectedRows).toHaveLength(0);
      }
      const organization = createdParties.find((party) => party.partyType === 'ORGANIZATION');
      if (organization === undefined) {
        return yield* Effect.die('The actual owner producer did not yield the legacy ORGANIZATION fixture');
      }
      const compatibility = yield* fixture
        .prepareOwner(
          Effect.fn('PersonOwnerTest.legacyCompatibility')(function* prepareLegacyCompatibility(transaction, scope) {
            const legacy = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
              createdAt: '2026-01-01T00:00:00Z',
              subject: { kind: 'DATA_SUBJECT', partyRef: organization.partyRef },
              subjectRef: {
                moduleId: 'privacy.core',
                resourceId: yield* nextId(),
                resourceType: 'privacy.core.privacy-subject',
                tenantId: scope.tenantId,
              },
              updatedAt: '2026-01-01T00:00:00Z',
            });
            const anonymous = yield* Schema.decodeUnknownEffect(PrivacySubjectRecordSchema)({
              createdAt: '2026-01-01T00:00:00Z',
              subject: {
                anonymousContext: {
                  addressability: 'SESSION',
                  contextRef: yield* nextId(),
                  createdAt: '2026-01-01T00:00:00Z',
                  expiresAt: '2027-01-01T00:00:00Z',
                  kind: 'ANONYMOUS_PRIVACY_CONTEXT',
                  provenance: { method: 'SESSION', source: 'legacy-neighbor-control' },
                },
                kind: 'ANONYMOUS',
              },
              subjectRef: {
                moduleId: 'privacy.core',
                resourceId: yield* nextId(),
                resourceType: 'privacy.core.privacy-subject',
                tenantId: scope.tenantId,
              },
              updatedAt: '2026-01-01T00:00:00Z',
            });
            const legalEntityId = Option.getOrThrow(Option.fromUndefinedOr(scope.legalEntityId));
            const repository = yield* privacyOperationRepositoryForScope(transaction, scope);
            yield* repository.createSubject(
              { legalEntityId, tenantId: scope.tenantId },
              { actionInvocationId: yield* nextId(), subject: anonymous },
            );
            // Baseline0325cbf9 createSubject INSERT ABI, before PERSON admission existed.
            // Only the owned disposable database, normal runtime role/RLS; no fabricated receipt.
            yield* transaction.insert(privacySubjects).values({
              createdAt: new Date(legacy.createdAt),
              legalEntityId,
              privacySubjectId: legacy.subjectRef.resourceId,
              subjectKind: legacy.subject.kind,
              subjectRecord: Schema.encodeSync(PrivacySubjectRecordSchema)(legacy),
              tenantId: scope.tenantId,
              updatedAt: new Date(legacy.updatedAt),
            });
            return { anonymous, legacy };
          }),
          'required',
        )
        .pipe(Effect.provideContext(context));
      const exactAnonymous = yield* runtime
        .runRead({
          input: { subjectRefs: [compatibility.anonymous.subjectRef] },
          principal,
          registration: privacySubjectsRead,
          transport: { correlationId: yield* nextId() },
        })
        .pipe(Effect.provideContext(context));
      expect(exactAnonymous.items).toEqual([compatibility.anonymous]);
      const selectedLegacy = yield* Effect.flip(
        runtime
          .runRead({
            input: { subjectRefs: [compatibility.legacy.subjectRef] },
            principal,
            registration: privacySubjectsRead,
            transport: { correlationId: yield* nextId() },
          })
          .pipe(Effect.provideService(PrivacySubjectPartyOwner, owner), Effect.provideContext(context)),
      );
      expect(selectedLegacy).toMatchObject({ code: 'read_handler_unavailable' });
      const legacyRetained = yield* fixture
        .prepareOwner(
          (transaction) =>
            transaction
              .select({ record: privacySubjects.subjectRecord })
              .from(privacySubjects)
              .where(eq(privacySubjects.privacySubjectId, compatibility.legacy.subjectRef.resourceId)),
          'required',
        )
        .pipe(Effect.provideContext(context));
      expect(legacyRetained).toEqual([{ record: Schema.encodeSync(PrivacySubjectRecordSchema)(compatibility.legacy) }]);
      const admitted = admittedSubjects.at(0);
      const person = createdParties.find((party) => party.partyType === 'PERSON');
      if (admitted === undefined || person === undefined) {
        return yield* Effect.die('The actual owner producer did not yield the required PERSON admission');
      }
      yield* archivePartyWithAuthorization(
        {
          expectedRevision: person.revision,
          partyRef: person.partyRef,
          reason: 'The real owner lifecycle changes after admission',
        },
        yield* authorization(),
        {
          baseUrl,
          compositionRevision: snapshot.composition.revision,
          correlationId: yield* nextId(),
          idempotencyKey: yield* nextId(),
        },
      );
      const staleRead = yield* Effect.flip(
        runtime
          .runRead({
            input: { subjectRefs: [admitted.subjectRef] },
            principal,
            registration: privacySubjectsRead,
            transport: { correlationId: yield* nextId() },
          })
          .pipe(Effect.provideService(PrivacySubjectPartyOwner, owner), Effect.provideContext(context)),
      );
      expect(staleRead).toMatchObject({ code: 'read_handler_unavailable' });
      const staleCreate = yield* Effect.flip(createSubject(person.partyRef, yield* nextId(), yield* nextId()));
      expect(staleCreate).toMatchObject({ code: 'privacy_operation_persistence_unavailable' });
      const retained = yield* fixture
        .prepareOwner(
          (transaction) =>
            transaction
              .select({ record: privacySubjects.subjectRecord })
              .from(privacySubjects)
              .where(eq(privacySubjects.privacySubjectId, admitted.subjectRef.resourceId)),
          'required',
        )
        .pipe(Effect.provideContext(context));
      expect(retained).toEqual([{ record: Schema.encodeSync(PrivacySubjectRecordSchema)(admitted) }]);
      return yield* Effect.void;
    }),
  );
});
