import type { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { RetailPortalBindingResultSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  RetailPortalPermissionCodeSchema,
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
} from '../../shared/domain/profile-contracts.ts';
import type { RetailCustomerProfileRefSchema } from '../../shared/resources/retail-customer-profile.ts';
import { createRequire } from 'node:module';
import { NodeHttpServer, NodeServices, NodeSocketServer } from '@effect/platform-node';
import { ChildProcess } from 'effect/process';
import {
  TrustedPrincipalContextSchema,
  defineScopedRoutine,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  parseDatabaseConnectionPair,
  OntosModuleDeploymentContractSchema,
  canonicalizeApplicationComposition,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { HttpServer, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ActiveApplicationCompositionSnapshotSchema } from '@app/core-runtime/modules/active-application-composition';
import {
  PriceGroupCreatedResultSchema,
  PriceGroupDefinitionRevisionSchema,
  PriceGroupRetirementAcceptanceSchema,
} from '@app/price-group-catalog-contracts/price-group';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PgClient } from '@effect/sql-pg';
import {
  Config,
  Context,
  Crypto,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  Queue,
  Redacted,
  Ref,
  Schema,
  Stream,
} from 'effect';
import { Socket } from 'effect/socket';

const commerceAppId = 'commerce-customer-context';
const commerceModuleId = 'commerce.customer-context';
export const priceGroupTemporalProtocol = 'ontos.customer-price-group-temporal.fixture.v1' as const;
const CreatedCatalogResponseTypeSchema = Schema.Literals(['CREATED_G1', 'CREATED_G2', 'CREATED_INCOMPATIBLE']);
const bounded = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const secret = Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)));
const strict = { parseOptions: { onExcessProperty: 'error' as const } };
export const PriceGroupOwnedDatabaseCertificateSchema = Schema.Struct({
  adminRole: bounded,
  adminUrl: secret,
  creatorPid: positive,
  name: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u)),
  oid: positive,
  owner: bounded,
  runtimeRole: bounded,
  runtimeUrl: secret,
  serverAddress: bounded,
  serverPort: positive,
  systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
}).annotate(strict);
export const PriceGroupPreparedArtifactSchema = Schema.Struct({
  appId: Schema.Literals(['commerce-customer-context', 'party-registry', 'price-group-catalog']),
  artifact: bounded,
  buildMarker: bounded,
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  directory: bounded,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
}).annotate(strict);

/** Pure equality over independently observed artifact identity; no caller-selected fallback. */
export const priceGroupPreparedArtifactMatches = (
  artifact: typeof PriceGroupPreparedArtifactSchema.Type,
  observed: Omit<typeof PriceGroupPreparedArtifactSchema.Type, 'description'>,
) =>
  artifact.appId === observed.appId &&
  artifact.artifact === observed.artifact &&
  artifact.buildMarker === observed.buildMarker &&
  artifact.directory === observed.directory &&
  artifact.sha256 === observed.sha256;

const ownerSpecifiers = {
  'commerce-customer-context': '@app/commerce-customer-context/testing/price-group-current-receiver',
  'party-registry': '@app/party-registry/testing/tenant-party-http',
  'price-group-catalog': '@app/price-group-catalog/testing/price-group-current-receiver',
} as const;

export const PriceGroupTemporalBootstrapSchema = Schema.Struct({
  actor: TrustedPrincipalContextSchema,
  artifacts: Schema.Struct({
    catalog: PriceGroupPreparedArtifactSchema,
    party: PriceGroupPreparedArtifactSchema,
  }).annotate(strict),
  composition: ActiveApplicationCompositionSnapshotSchema,
  database: PriceGroupOwnedDatabaseCertificateSchema,
  identities: Schema.Struct({ issuerUrl: secret, partyUrl: secret }).annotate(strict),
  issuer: bounded,
  jwks: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_384)),
  mode: Schema.Literals(['before', 'current']),
  spiceDb: Schema.Struct({
    caCertificate: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
    endpoint: bounded,
    token: secret,
  }).annotate(strict),
  type: Schema.Literal('bootstrap'),
  version: Schema.Literal(priceGroupTemporalProtocol),
}).annotate(strict);
export const PriceGroupTemporalResponseSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('SCHEMAS_READY'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }).annotate(strict),
  Schema.Struct({
    code: Schema.optionalKey(
      Schema.Literals([
        'action_invocation_persistence_failed',
        'action_permission_check_failed',
        'action_policy_evaluation_failed',
        'action_transaction_failed',
        'price_group_persistence_unavailable',
        'module_state_check_unavailable',
        'operation_context_unavailable',
        'action_policy_denied',
        'party_evidence_insufficient',
        'party_official_identifier_invalid',
        'party_contact_point_invalid',
        'counterparty_evidence_insufficient',
        'party_relationship_endpoint_type_mismatch',
        'party_relationship_type_unsupported',
        'party_relationship_invalid_interval',
      ]),
    ),
    stage: Schema.Literals([
      'CREATE_INVALID',
      'CREATE_AUTHENTICATION',
      'CREATE_FORBIDDEN',
      'CREATE_CONFLICT',
      'CREATE_UNAVAILABLE',
      'CREATE_INTERNAL',
      'CREATE_DECODE',
      'PARTY_CREATE_INVALID',
      'PARTY_CREATE_AUTHENTICATION',
      'PARTY_CREATE_FORBIDDEN',
      'PARTY_CREATE_CONFLICT',
      'PARTY_CREATE_UNAVAILABLE',
      'PARTY_CREATE_INTERNAL',
      'PARTY_CREATE_DECODE',
      'PARTY_COUNTERPARTY_AUTHENTICATION',
      'PARTY_COUNTERPARTY_CONFLICT',
      'PARTY_COUNTERPARTY_FORBIDDEN',
      'PARTY_COUNTERPARTY_INTERNAL',
      'PARTY_COUNTERPARTY_INVALID',
      'PARTY_COUNTERPARTY_UNAVAILABLE',
      'PARTY_COUNTERPARTY_INELIGIBLE',
      'PARTY_COUNTERPARTY_DECODE',
    ]),
    type: Schema.Literal('FAILED'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    buildMarker: bounded,
    compositionRevision: bounded,
    port: positive,
    type: Schema.Literal('BOOTED'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    partyRef: PartyRefSchema,
    type: Schema.Literal('RETAIL_PARTY_CREATED'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    counterpartyRef: CounterpartyRefSchema,
    partyRef: PartyRefSchema,
    type: Schema.Literal('COUNTERPARTY_CREATED'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    result: PriceGroupCreatedResultSchema,
    type: CreatedCatalogResponseTypeSchema,
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    result: PriceGroupDefinitionRevisionSchema,
    type: Schema.Literal('REVISED_G2'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    result: PriceGroupRetirementAcceptanceSchema,
    type: Schema.Literal('RETIRED_G2'),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
  Schema.Struct({
    type: Schema.Literals(['UPGRADED', 'CATALOG_STOPPED', 'STOPPED']),
    version: Schema.Literal(priceGroupTemporalProtocol),
  }),
]);
class TemporalFixtureUnavailable extends Schema.TaggedError<TemporalFixtureUnavailable>()(
  'TemporalFixtureUnavailable',
  { stage: Schema.String },
) {}
const failure = (stage: string) => new TemporalFixtureUnavailable({ stage });
const requireCondition = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(failure(stage)));
export const guardPriceGroupPreparedArtifact = Effect.fn('PriceGroupTemporal.guardPreparedArtifact')(
  function* guardPreparedArtifact(
    artifact: typeof PriceGroupPreparedArtifactSchema.Type,
    owner: (typeof PriceGroupPreparedArtifactSchema.Type)['appId'],
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const entry = createRequire(new URL('../../package.json', import.meta.url)).resolve(ownerSpecifiers[owner]);
    const directory = yield* fs.realPath(path.dirname(path.dirname(path.dirname(entry))));
    const cache = yield* fs.realPath(path.join(directory, '.cache/ontos-1248'));
    const actualPath = yield* fs.realPath(artifact.artifact);
    yield* requireCondition(
      path.dirname(actualPath) === cache && /^[a-f0-9-]{36}\.mjs$/u.test(path.basename(actualPath)),
      'prepared-artifact-path',
    );
    const marker = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          appId: PriceGroupPreparedArtifactSchema.fields.appId,
          buildMarker: bounded,
        }),
      ),
    )(artifact.description);
    const bytes = yield* fs.readFile(actualPath);
    const crypto = yield* Crypto.Crypto;
    const sha256 = Buffer.from(yield* crypto.digest('SHA-256', bytes)).toString('hex');
    yield* requireCondition(
      priceGroupPreparedArtifactMatches(artifact, {
        appId: owner,
        artifact: actualPath,
        buildMarker: marker.buildMarker,
        directory,
        sha256,
      }) && marker.appId === owner,
      'prepared-artifact-identity',
    );
    return artifact;
  },
);

const addressMatchesCertificate = (
  pair: Effect.Success<ReturnType<typeof parseDatabaseConnectionPair>>,
  certificate: typeof PriceGroupOwnedDatabaseCertificateSchema.Type,
): boolean =>
  pair.admin.database === certificate.name &&
  pair.runtime.database === certificate.name &&
  pair.admin.host === pair.runtime.host &&
  pair.admin.port === pair.runtime.port &&
  ['localhost', '127.0.0.1'].includes(pair.admin.host) &&
  pair.admin.user === certificate.adminRole &&
  pair.runtime.user === certificate.runtimeRole &&
  certificate.owner === certificate.adminRole &&
  certificate.adminRole !== certificate.runtimeRole;

/** Validate only the fixed dedicated identities on the exact clone; never accept an ambient fallback. */
export const priceGroupDedicatedUrlMatches = (
  value: string,
  certificate: typeof PriceGroupOwnedDatabaseCertificateSchema.Type,
  role: 'party_registry_runtime' | 'shell_gateway_issuer',
): boolean => {
  const parsed = URL.parse(value);
  const admin = URL.parse(Redacted.value(certificate.adminUrl));
  return (
    parsed !== null &&
    admin !== null &&
    ['postgres:', 'postgresql:'].includes(parsed.protocol) &&
    ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
    parsed.hostname === admin.hostname &&
    Number(parsed.port || '5432') === Number(admin.port || '5432') &&
    parsed.pathname === `/${certificate.name}` &&
    parsed.username === role &&
    parsed.search === '' &&
    parsed.hash === ''
  );
};

/** Repeat the parent certificate against the actual Core-created database; a name prefix alone is insufficient. */
export const guardPriceGroupOwnedDatabase = Effect.fn('PriceGroupTemporal.guardOwnedDatabase')(
  function* guardOwnedDatabase(certificate: typeof PriceGroupOwnedDatabaseCertificateSchema.Type) {
    const pair = yield* parseDatabaseConnectionPair({
      DATABASE_ADMIN_URL: Redacted.value(certificate.adminUrl),
      DATABASE_URL: Redacted.value(certificate.runtimeUrl),
    }).pipe(Effect.mapError(() => failure('owned-configuration')));
    yield* requireCondition(addressMatchesCertificate(pair, certificate), 'owned-address');
    for (const [kind, connection] of [
      ['admin', pair.admin],
      ['runtime', pair.runtime],
    ] as const) {
      const ctx = yield* Layer.build(
        PgClient.layer({ maxConnections: 1, url: Redacted.make(connection.connectionString) }),
      );
      const client = Context.get(ctx, PgClient.PgClient);
      const rows = yield* client<{
        bypass_rls: boolean;
        database_name: string;
        database_oid: number;
        database_owner: string;
        effective_role: string;
        server_address: string;
        server_port: number;
        session_role: string;
        superuser: boolean;
      }>`select current_database() as database_name, d.oid::int as database_oid, pg_get_userbyid(d.datdba) as database_owner,
      session_user::text as session_role, current_user::text as effective_role, inet_server_addr()::text as server_address,
      inet_server_port() as server_port, r.rolsuper as superuser, r.rolbypassrls as bypass_rls
      from pg_database d join pg_roles r on r.rolname=current_user where d.datname=current_database()`.pipe(
        Effect.mapError(() => failure('owned-identity-read')),
      );
      const [actual] = rows;
      const role = kind === 'admin' ? certificate.adminRole : certificate.runtimeRole;
      yield* requireCondition(
        rows.length === 1 &&
          actual !== undefined &&
          actual.database_name === certificate.name &&
          actual.database_oid === certificate.oid &&
          actual.database_owner === certificate.owner &&
          actual.session_role === role &&
          actual.effective_role === role &&
          actual.server_address === certificate.serverAddress &&
          actual.server_port === certificate.serverPort &&
          (kind === 'admin' || (!actual.superuser && !actual.bypass_rls)),
        'owned-identity',
      );
      if (kind === 'runtime') {
        yield* requireCondition(actual !== undefined && !actual.superuser && !actual.bypass_rls, 'owned-runtime-rls');
      }
    }
    return pair;
  },
  Effect.scoped,
);

export const priceGroupTemporalClosedEnvironment = (bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type) =>
  Object.freeze({
    APP_ENV_PATH: '/dev/null',
    DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
    ONTOS_GATEWAY_ISSUER: bootstrap.issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: bootstrap.jwks,
    SPICEDB_CA_CERT: bootstrap.spiceDb.caCertificate ?? '',
    SPICEDB_ENDPOINT: bootstrap.spiceDb.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(bootstrap.spiceDb.token),
  });
export {
  CreatedCatalogResponseTypeSchema,
  TemporalFixtureUnavailable,
  bounded,
  positive,
  strict,
  failure,
  requireCondition,
};

export const priceGroupTemporalSocketEnvironment = 'ONTOS_PRICE_GROUP_TEMPORAL_SOCKET';
export const guardPriceGroupTemporalSocketPath = (socketPath: string) =>
  Effect.gen(function* guardPrivateTemporalSocketPath() {
    const fs = yield* FileSystem.FileSystem;
    const temporaryRoot = yield* fs.realPath('/tmp');
    yield* requireCondition(
      socketPath.startsWith(`${temporaryRoot}/`) &&
        /^\/pg1248-[a-zA-Z0-9_-]+\/owner\.sock$/u.test(socketPath.slice(temporaryRoot.length)),
      'private-socket-path',
    );
  });
export const priceGroupTemporalLines = (pull: Effect.Success<ReturnType<typeof Socket.readerBytes>>) => {
  let pending = 0;
  return Stream.fromPull(Effect.succeed(pull)).pipe(
    Stream.mapEffect((bytes) =>
      Effect.suspend(() => {
        for (const byte of bytes) {
          pending = byte === 10 ? 0 : pending + 1;
          if (pending > 262_144) {
            return Effect.fail(failure('private-frame-limit'));
          }
        }
        return Effect.succeed(bytes);
      }),
    ),
    Stream.decodeText(),
    Stream.splitLines,
  );
};

const normalClose = (error: Socket.SocketError | Schema.SchemaError | TemporalFixtureUnavailable) =>
  Socket.isSocketError(error) && Schema.is(Socket.SocketCloseError)(error.reason) && error.reason.code === 1000;

/** Owner-local TEST transport; callers retain their own closed command/response schemas. */
export const openPriceGroupTemporalChannel = <Response, Encoded>(responseSchema: Schema.Codec<Response, Encoded>) =>
  Effect.gen(function* openPrivateTemporalChannel() {
    const fs = yield* FileSystem.FileSystem;
    const temporary = yield* fs.makeTempDirectoryScoped({ directory: '/tmp', prefix: 'pg1248-' });
    yield* fs.chmod(temporary, 0o700);
    const directory = yield* fs.realPath(temporary);
    const socketPath = `${directory}/owner.sock`;
    const server = yield* NodeSocketServer.make({ path: socketPath });
    const writer = yield* Deferred.make<Socket.Writer>();
    const responses = yield* Queue.unbounded<Response>();
    const failed = yield* Deferred.make<never, TemporalFixtureUnavailable>();
    const connected = yield* Ref.make(false);
    const closing = yield* Ref.make(false);
    const stopped = yield* Ref.make(false);
    const recordResponse = (response: Response) =>
      Queue.offer(responses, response).pipe(
        Effect.andThen(
          Schema.is(Schema.Struct({ type: Schema.Literal('STOPPED') }))(response)
            ? Ref.set(stopped, true)
            : Effect.void,
        ),
      );
    const settleClose = (error: Socket.SocketError | Schema.SchemaError | TemporalFixtureUnavailable) =>
      Effect.all([Ref.get(closing), Ref.get(stopped)]).pipe(
        Effect.flatMap(([expected, acknowledged]) => (expected && acknowledged ? Effect.void : Effect.fail(error))),
      );
    const decodeLine = (line: string) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(responseSchema), { onExcessProperty: 'error' })(line);
    const receivePeer = (socket: Socket.Socket) =>
      Effect.scoped(
        Effect.gen(function* receivePrivatePeer() {
          if (yield* Ref.getAndSet(connected, true)) {
            return yield* failure('duplicate-private-peer');
          }
          const pull = yield* Socket.readerBytes(socket);
          yield* Deferred.succeed(writer, yield* socket.writer);
          return yield* priceGroupTemporalLines(pull).pipe(
            Stream.mapEffect(decodeLine),
            Stream.runForEach(recordResponse),
          );
        }),
      ).pipe(
        Effect.catchIf(normalClose, settleClose),
        Effect.matchEffect({
          onFailure: () => Deferred.fail(failed, failure('private-channel-ended')).pipe(Effect.asVoid),
          onSuccess: () => Effect.void,
        }),
      );
    yield* server.run(receivePeer).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Deferred.fail(failed, failure('private-channel-closed')));
    return Object.freeze({
      beginClose: Ref.set(closing, true),
      next: Effect.raceFirst(Queue.take(responses), Deferred.await(failed)),
      send: (encodedFrame: string) =>
        Effect.gen(function* sendPrivateFrame() {
          yield* requireCondition(
            !encodedFrame.includes('\n') && new TextEncoder().encode(encodedFrame).byteLength <= 262_144,
            'private-frame-invalid',
          );
          const output = yield* Effect.raceFirst(Deferred.await(writer), Deferred.await(failed));
          yield* output.write(`${encodedFrame}\n`);
        }),
      socketPath,
    });
  });

const temporalContract = Effect.fn('TemporalNative.actualOwnerContract')(function* actualOwnerContract(
  directory: string,
  owner: typeof commerceAppId | 'party-registry' | 'price-group-catalog',
) {
  const path = yield* Path.Path;
  const program = `import { Effect, FileSystem, ManagedRuntime, Schema } from 'effect';
    import { NodeServices } from '@effect/platform-node';
    import { resolveUltramodernReleaseIdentity } from '@modern-js/app-tools-extensions/release-identity';
    import { deriveOntosModuleDeploymentContract } from './scripts/generate-ontos-module-contract.mts';
    import { OntosModuleDeploymentContractSchema } from '@app/core-runtime';
    const runtime = ManagedRuntime.make(NodeServices.layer);
    try { const text = await runtime.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ownerSchema = Schema.Struct({id: Schema.String,
        deliveryUnit: Schema.Struct({buildMarker: Schema.String, unitId: Schema.String})});
      const topology = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
        verticals: Schema.Array(ownerSchema)
      })))(yield* fs.readFileString('./topology/reference-topology.json'));
      const owner = yield* Schema.decodeUnknownEffect(ownerSchema)(
        topology.verticals.find(owner => owner.id === ${JSON.stringify(owner)}));
      // Resolve before contract extraction or bundling writes any test artifacts.
      const buildIdentity = yield* Effect.try(() => resolveUltramodernReleaseIdentity({
        generationBuildMarker: owner.deliveryUnit.buildMarker,
        unitId: owner.deliveryUnit.unitId, workspaceRoot: process.cwd()
      }));
      const contract = yield* deriveOntosModuleDeploymentContract({vertical:owner.id});
      return yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Struct({
        buildIdentity: Schema.Struct({buildMarker: Schema.String, sourceRevision: Schema.String}),
        contract: OntosModuleDeploymentContractSchema
      })))({buildIdentity, contract});
    })); process.stdout.write(text); } finally { await runtime.dispose(); }`;
  const child = yield* ChildProcess.make(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', program],
    {
      cwd: path.resolve(directory, '../..'),
      env: {
        APP_ENV_PATH: '/dev/null',
        HOME: yield* Config.String('HOME'),
        PATH: yield* Config.String('PATH'),
        TMPDIR: yield* Config.String('TMPDIR').pipe(Config.withDefault('/tmp')),
      },
      extendEnv: false,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    },
  ).pipe(Effect.provide(NodeServices.layer, { local: true }));
  const [output, code] = yield* Effect.all(
    [child.stdout.pipe(Stream.decodeText(), Stream.runCollect), child.exitCode, Stream.runDrain(child.stderr)],
    { concurrency: 3 },
  );
  yield* requireCondition(code === 0, 'actual-owner-contract');
  const description = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        buildIdentity: Schema.Struct({ buildMarker: Schema.String, sourceRevision: Schema.String }),
        contract: OntosModuleDeploymentContractSchema,
      }),
    ),
  )(output.join(''));
  yield* requireCondition(
    description.contract.deployment.appId === owner &&
      description.contract.deployment.buildMarker === description.buildIdentity.buildMarker,
    'actual-owner-contract-identity',
  );
  return description;
});

const temporalDigest = Effect.fn('TemporalNative.metadataDigest')(function* metadataDigest(document: string) {
  const crypto = yield* Crypto.Crypto;
  return Buffer.from(yield* crypto.digest('SHA-256', new TextEncoder().encode(document))).toString('hex');
});

/** Actual published owner declarations; served metadata is TEST-only and makes no browser-build claim. */
export const makePriceGroupTemporalComposition = Effect.fn('TemporalNative.actualOwnerComposition')(
  function* actualOwnerComposition(
    owners: readonly {
      readonly contract: typeof OntosModuleDeploymentContractSchema.Type;
      readonly marker: { readonly appId: string; readonly buildMarker: string };
    }[],
  ) {
    const documents = yield* Effect.forEach(
      owners,
      ({ contract, marker }) =>
        Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              exposes: Schema.Array(Schema.String),
              name: Schema.String,
              shared: Schema.Array(Schema.Never),
            }),
          ),
        )({
          exposes: contract.manifest.publicSurface.components.map(({ expose }) => expose),
          name: contract.manifest.publicSurface.components[0]?.mfBoundaryId ?? marker.appId,
          shared: [],
        }).pipe(Effect.map((document) => ({ appId: marker.appId, document }))),
      { concurrency: 1 },
    );
    const server = Context.get(yield* Layer.build(NodeHttpServer.layerTest), HttpServer.HttpServer);
    yield* server.serve(
      Effect.gen(function* serveExactTestMetadata() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const document = documents.find(({ appId }) => request.url === `/${appId}/mf-manifest.json`);
        return document === undefined
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.text(document.document, { contentType: 'application/json' });
      }),
    );
    const address = yield* Schema.decodeUnknownEffect(Schema.Struct({ port: positive }))(server.address);
    const modules = yield* Effect.forEach(
      owners,
      Effect.fn('TemporalNative.actualOwnerModule')(function* actualOwnerModule({ contract, marker }) {
        yield* requireCondition(
          contract.deployment.appId === marker.appId && contract.deployment.buildMarker === marker.buildMarker,
          'actual-owner-build',
        );
        const initial = yield* makeApplicationCompositionSnapshotFixture([marker.appId], marker.buildMarker);
        const [module] = initial.composition.modules;
        const document = documents.find(({ appId }) => appId === marker.appId);
        if (module === undefined || document === undefined) {
          return yield* failure('actual-owner-module');
        }
        const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
          contract,
        );
        const sha256 = yield* temporalDigest(contractDocument);
        const { components } = contract.manifest.publicSurface;
        const [component] = components;
        const federation =
          component === undefined
            ? { execution: 'server' as const }
            : {
                execution: 'browser' as const,
                exposes: components.map(({ expose }) => expose),
                manifest: {
                  sha256: yield* temporalDigest(document.document),
                  url: `http://127.0.0.1:${address.port}/${marker.appId}/mf-manifest.json`,
                },
                remoteName: component.mfBoundaryId,
              };
        return {
          ...module,
          allowedContributions: Object.values(contract.manifest.publicSurface.shellContributions).flatMap((items) =>
            items.map(({ contributionKey }) => contributionKey),
          ),
          contract: { ...module.contract, sha256 },
          contractDocument,
          deployment: contract.deployment,
          federation,
          moduleId: contract.manifest.module.id,
          publicContract: { id: contract.manifest.module.id, sha256, version: contract.schemaVersion },
        };
      }),
      { concurrency: 1 },
    );
    const initial = yield* makeApplicationCompositionSnapshotFixture([]);
    const composition = { ...initial.composition, modules, revision: '0'.repeat(64) };
    return yield* validateActiveApplicationCompositionSnapshot({
      ...initial,
      composition: { ...composition, revision: yield* temporalDigest(canonicalizeApplicationComposition(composition)) },
    });
  },
);

const MarkerSchema = Schema.Struct({
  appId: Schema.Literals([commerceAppId, 'party-registry', 'price-group-catalog']),
  buildMarker: Schema.String,
});
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
export const describePriceGroupTemporalOwner = Effect.fn('TemporalNative.describeOwner')(
  function* describePriceGroupTemporalOwner(owner: typeof commerceAppId | 'party-registry' | 'price-group-catalog') {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const specifiers = {
      [commerceAppId]: '@app/commerce-customer-context/testing/price-group-current-receiver',
      'party-registry': '@app/party-registry/testing/tenant-party-http',
      'price-group-catalog': '@app/price-group-catalog/testing/price-group-current-receiver',
    };
    const specifier = specifiers[owner];
    const entryPath = createRequire(new URL('../../package.json', import.meta.url)).resolve(specifier);
    const directory = path.dirname(path.dirname(path.dirname(entryPath)));
    const { buildIdentity, contract } = yield* temporalContract(directory, owner);
    const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
    const cache = path.join(directory, '.cache/ontos-1248');
    yield* fs.makeDirectory(cache, { recursive: true });
    const artifact = path.join(cache, `${yield* nextId}.mjs`);
    yield* Effect.addFinalizer(() => Effect.orDie(fs.remove(artifact, { force: true })));
    const bundle = yield* ChildProcess.make(
      '../../node_modules/esbuild/bin/esbuild',
      [
        entryPath,
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--define:ULTRAMODERN_BUILD_MARKER=${yield* encode(buildIdentity.buildMarker)}`,
        `--define:ULTRAMODERN_SOURCE_REVISION=${yield* encode(buildIdentity.sourceRevision)}`,
        `--outfile=${artifact}`,
      ],
      {
        cwd: directory,
        env: { APP_ENV_PATH: '/dev/null' },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ).pipe(Effect.provide(NodeServices.layer, { local: true }));
    const [bundleCode] = yield* Effect.all(
      [bundle.exitCode, Stream.runDrain(bundle.stderr), Stream.runDrain(bundle.stdout)],
      { concurrency: 3 },
    );
    yield* requireCondition(bundleCode === 0, 'bundle');
    const child = yield* ChildProcess.make(
      process.execPath,
      [artifact, owner === commerceAppId ? '--describe-price-group-current' : '--describe'],
      {
        cwd: directory,
        env: { APP_ENV_PATH: '/dev/null' },
        extendEnv: false,
        stderr: 'pipe',
        stdin: 'ignore',
        stdout: 'pipe',
      },
    ).pipe(Effect.provide(NodeServices.layer, { local: true }));
    const [lines, code] = yield* Effect.all(
      [
        child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        child.exitCode,
        Stream.runDrain(child.stderr),
      ],
      { concurrency: 3 },
    );
    yield* requireCondition(code === 0 && lines.length === 1, 'describe');
    const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarkerSchema))(lines[0]);
    yield* requireCondition(marker.appId === owner, 'describe-identity');
    const artifactBytes = yield* fs.readFile(artifact);
    const crypto = yield* Crypto.Crypto;
    const prepared = yield* Schema.decodeUnknownEffect(PriceGroupPreparedArtifactSchema)({
      appId: owner,
      artifact: yield* fs.realPath(artifact),
      buildMarker: marker.buildMarker,
      description: lines[0],
      directory: yield* fs.realPath(directory),
      sha256: Buffer.from(yield* crypto.digest('SHA-256', artifactBytes)).toString('hex'),
    });
    yield* guardPriceGroupPreparedArtifact(prepared, owner);
    return Object.freeze({
      artifact,
      contract,
      description: lines[0],
      directory,
      marker,
      prepared: Object.freeze(prepared),
    });
  },
);

const bindProfile = defineScopedRoutine({
  name: 'mutate_retail_portal_binding',
  ownerModuleKey: commerceModuleId,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'integer' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('BINDING_ACTIVATED'),
    payload: RetailPortalBindingResultSchema,
  }),
  routineKey: 'test.price-group-period.native-binding',
  schema: 'commerce_customer_context',
});
const NativeIdentitySchema = Schema.String.pipe(Schema.brand('NativeIdentity'));
const readBindingIntent = defineScopedRoutine({
  name: 'read_retail_portal_profile_binding_permission_mutation',
  ownerModuleKey: commerceModuleId,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('AUTHORIZATION_AVAILABLE'),
    payload: Schema.Struct({
      actionInvocationId: NativeIdentitySchema,
      bindingId: NativeIdentitySchema,
      mutationId: NativeIdentitySchema,
      operation: Schema.Literal('grant'),
      permission: RetailPortalPermissionCodeSchema,
      principalId: NativeIdentitySchema,
      profileId: NativeIdentitySchema,
      state: Schema.Literal('PENDING_GRANT'),
    }),
  }),
  routineKey: 'profile.binding-authorization-intent-read',
  schema: 'commerce_customer_context',
});
const BindingFinalizedOutcomeSchema = Schema.Literals(['AUTHORIZATION_FINALIZED', 'AUTHORIZATION_ALREADY_FINAL']);
const finalizeBindingIntent = defineScopedRoutine({
  name: 'finalize_retail_portal_profile_binding_permission_mutation',
  ownerModuleKey: commerceModuleId,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: BindingFinalizedOutcomeSchema,
    payload: Schema.Struct({ state: Schema.Literal('ACTIVE') }),
  }),
  routineKey: 'profile.binding-authorization-intent-finalize',
  schema: 'commerce_customer_context',
});
const finalizeBinding = defineScopedRoutine({
  name: 'finalize_retail_portal_binding_authorization',
  ownerModuleKey: commerceModuleId,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'integer' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'timestamptz' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: BindingFinalizedOutcomeSchema,
    payload: Schema.Struct({ authorizationState: Schema.Literal('ACTIVE') }),
  }),
  routineKey: 'profile.binding-authorization-finalize',
  schema: 'commerce_customer_context',
});
const readBindingAuthority = defineScopedRoutine({
  name: 'read_retail_portal_binding_authorization',
  ownerModuleKey: commerceModuleId,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
  ] as const,
  resultSchema: Schema.Struct({
    outcome: Schema.Literal('AUTHORIZATION_AVAILABLE'),
    payload: Schema.Struct({
      authorizationState: Schema.Literal('ACTIVE'),
      pendingCount: Schema.Int,
      terminalCount: Schema.Int,
    }),
  }),
  routineKey: 'profile.binding-authorization-read',
  schema: 'commerce_customer_context',
});

/** Native authorization precondition for the genuine public PriceGroup readers, not an enrollment workflow proof. */
export const preparePriceGroupTemporalRetailAccess = Effect.fn('PriceGroupTemporal.prepareRetailAccess')(
  function* prepareRetailAccess(input: {
    readonly certificate: typeof PriceGroupOwnedDatabaseCertificateSchema.Type;
    readonly effectiveAt: string;
    readonly fixture: Effect.Success<ReturnType<typeof makeLiveOperationFixture>>;
    readonly profileRef: typeof RetailCustomerProfileRefSchema.Type;
  }) {
    const { effectiveAt, fixture, profileRef } = input;
    yield* guardPriceGroupOwnedDatabase(input.certificate);
    yield* requireCondition(profileRef.tenantId === fixture.tenantId, 'retail-binding-tenant');
    const { authBindingId } = fixture.manager;
    if (authBindingId === undefined) {
      return yield* failure('retail-binding-auth-binding');
    }
    const crypto = yield* Crypto.Crypto;
    const invocationId = yield* crypto.randomUUIDv4();
    const namespace = staffAuthenticationNamespaceRegistryLayer([commerceAppId]);
    const [created] = yield* fixture
      .prepareOwner(
        (transaction) =>
          transaction.invoke(bindProfile, [
            profileRef.resourceId,
            fixture.manager.principalId,
            authBindingId,
            'native-price-group-read-authority',
            null,
            null,
            'BIND',
            effectiveAt,
            'Native PriceGroup read authorization precondition',
            invocationId,
            fixture.manager.principalId,
          ]),
        'required',
      )
      .pipe(Effect.provide(namespace));
    if (created === undefined || created.payload.authorizationState !== 'PENDING_GRANT') {
      return yield* failure('retail-binding-not-staged');
    }
    const binding = created.payload;
    const intents = binding.permissionMutations;
    if (intents === undefined) {
      return yield* failure('retail-binding-intents-missing');
    }
    yield* requireCondition(
      intents.length === RETAIL_PORTAL_SELF_SERVICE_BASELINE.length &&
        new Set(intents.map((intent) => intent.permission)).size === intents.length &&
        RETAIL_PORTAL_SELF_SERVICE_BASELINE.every((permission) =>
          intents.some((intent) => intent.permission === permission),
        ) &&
        intents.every((intent) => intent.operation === 'grant' && intent.staged),
      'retail-binding-exact-baseline',
    );
    const business = Context.get(
      yield* Layer.build(BusinessPermissionRelationshipMutationLive),
      BusinessPermissionRelationshipMutation,
    );
    for (const intent of intents) {
      const grant = {
        permission: intent.permission,
        principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
        target: {
          kind: 'retail_profile' as const,
          legalEntityId: fixture.legalEntityId,
          profileId: profileRef.resourceId,
          tenantId: fixture.tenantId,
        },
      };
      yield* fixture
        .prepareOwner(
          (transaction) =>
            Effect.gen(function* reconcileExactRetailPermission() {
              const [current] = yield* transaction.invoke(readBindingIntent, [intent.mutationId]);
              yield* requireCondition(
                current !== undefined &&
                  current.payload.actionInvocationId === invocationId &&
                  current.payload.bindingId === binding.bindingRef.resourceId &&
                  current.payload.mutationId === intent.mutationId &&
                  current.payload.operation === 'grant' &&
                  current.payload.permission === intent.permission &&
                  current.payload.principalId === fixture.manager.principalId &&
                  current.payload.profileId === profileRef.resourceId &&
                  current.payload.state === 'PENDING_GRANT',
                'retail-binding-intent-identity',
              );
              yield* business.mutate({ ...grant, operation: 'grant' });
              yield* transaction.invoke(finalizeBindingIntent, [intent.mutationId, 'grant', 'ACTIVE']);
            }),
          'required',
        )
        .pipe(Effect.provide(namespace));
      yield* Effect.addFinalizer(() => business.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
    }
    const authority = yield* fixture
      .prepareOwner(
        (transaction) =>
          Effect.gen(function* finalizeExactRetailBinding() {
            yield* transaction.invoke(finalizeBinding, [
              binding.bindingRef.resourceId,
              'grant',
              binding.revision,
              invocationId,
              effectiveAt,
              'Native PriceGroup read authorization precondition',
              fixture.manager.principalId,
            ]);
            const [current] = yield* transaction.invoke(readBindingAuthority, [binding.bindingRef.resourceId, 'grant']);
            return current;
          }),
        'required',
      )
      .pipe(Effect.provide(namespace));
    yield* requireCondition(
      authority !== undefined &&
        authority.payload.authorizationState === 'ACTIVE' &&
        authority.payload.pendingCount === 0 &&
        authority.payload.terminalCount === RETAIL_PORTAL_SELF_SERVICE_BASELINE.length,
      'retail-binding-authority-active',
    );
    return binding;
  },
);
