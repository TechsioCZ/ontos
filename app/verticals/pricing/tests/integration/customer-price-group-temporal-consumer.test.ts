import {
  describePriceGroupTemporalOwner as describeOwner,
  openPriceGroupTemporalChannel,
  makePriceGroupTemporalComposition,
  preparePriceGroupTemporalRetailAccess,
  priceGroupTemporalSocketEnvironment,
  PriceGroupTemporalResponseSchema,
  PriceGroupTemporalBootstrapSchema,
  PriceGroupOwnedDatabaseCertificateSchema,
  guardPriceGroupOwnedDatabase,
  guardPriceGroupPreparedArtifact,
  priceGroupDedicatedUrlMatches,
} from '@app/commerce-customer-context/testing/price-group-temporal-protocol';

import {
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
} from '@app/core-runtime';
import type { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import {
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  decodeSupportedGatewayContextClaims,
  SupportedGatewayContextClaimsSchema,
} from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { fileURLToPath } from 'node:url';
import { Clock, Config, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  executeEnsureRetailCustomerProfileWithAuthorization,
  executeAssignCustomerPriceGroupWithAuthorization,
  executeRemoveCustomerPriceGroupWithAuthorization,
} from '@app/commerce-customer-context/api/client';
import {
  PriceGroupAssignmentResolutionSchema,
  PriceGroupInterpretationBasisSchema,
  NonePriceGroupInterpretationSchema,
} from '@app/pricing-contracts/domain/price-group-interpretation';
import { CommercePriceGroupResolutionGatewayCredentialService } from '../../shared/domain/commerce-price-group-resolution-gateway-credential.ts';
import { PriceGroupOwnerGatewayUnavailable } from '../../shared/domain/price-group-owner-gateway-unavailable.ts';
import { commercePriceGroupResolutionPortFromEnvironment } from '../../src/integrations/commerce-price-group-resolution.ts';
import { makePriceGroupInterpretationService } from '../../src/services/price-group-interpretation.service.ts';

class TemporalNativeFailure extends Schema.TaggedError<TemporalNativeFailure>()('TemporalNativeFailure', {
  stage: Schema.String,
}) {}
const fail = (stage: string) => new TemporalNativeFailure({ stage });
const requireCondition = (condition: boolean, stage: string) => (condition ? Effect.void : Effect.fail(fail(stage)));
const priceGroupTemporalProtocol = 'ontos.customer-price-group-temporal.fixture.v1' as const;
const priceGroupTemporalClosedEnvironment = (bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type) =>
  Object.freeze({
    APP_ENV_PATH: '/dev/null',
    DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
    ONTOS_GATEWAY_ISSUER: bootstrap.issuer,
    ONTOS_GATEWAY_PUBLIC_JWKS: bootstrap.jwks,
    SPICEDB_CA_CERT: bootstrap.spiceDb.caCertificate ?? '',
    SPICEDB_ENDPOINT: bootstrap.spiceDb.endpoint,
    SPICEDB_PRESHARED_KEY: Redacted.value(bootstrap.spiceDb.token),
  });

const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const services = NodeServices.layer.pipe(
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const MarkerSchema = Schema.Struct({
  appId: Schema.Literals(['commerce-customer-context', 'party-registry', 'price-group-catalog']),
  buildMarker: Schema.String,
});
const ActionKeySchema = Schema.String.pipe(Schema.brand('TemporalNativeActionKey'), Schema.decodeTo(Schema.String));
const DescriptionSchema = Schema.Struct({ ...MarkerSchema.fields, actionKeys: Schema.Array(ActionKeySchema) });
const PublicKeySchema = Schema.Struct({ crv: Schema.Literal('Ed25519'), kty: Schema.Literal('OKP'), x: Schema.String });
const PublicKeysSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      ...PublicKeySchema.fields,
      alg: Schema.Literal('EdDSA'),
      kid: Schema.String,
      use: Schema.Literal('sig'),
    }),
  ),
});

const captureOwnedCertificate = Effect.fn('TemporalNative.captureOwnedCertificate')(function* captureOwnedCertificate(
  isolated: Effect.Success<ReturnType<typeof makeIsolatedNativeDatabaseFixture>>,
) {
  const { admin, runtime } = isolated.connections;
  yield* requireCondition(
    /^ontos_test_party_gateway_[a-f0-9]{32}$/u.test(admin.database) &&
      admin.database === runtime.database &&
      admin.host === runtime.host &&
      admin.port === runtime.port &&
      ['localhost', '127.0.0.1'].includes(admin.host) &&
      admin.user !== runtime.user,
    'core-owned-address',
  );
  const context = yield* Layer.build(PgClient.layer({ maxConnections: 1, url: Redacted.make(admin.connectionString) }));
  const client = Context.get(context, PgClient.PgClient);
  const [actual] = yield* client<{
    database_name: string;
    database_oid: number;
    database_owner: string;
    effective_role: string;
    server_address: string;
    server_port: number;
    session_role: string;
    system_identifier: string;
  }>`select current_database() as database_name, d.oid::int as database_oid, pg_get_userbyid(d.datdba) as database_owner,
      inet_server_addr()::text as server_address, inet_server_port() as server_port,
      session_user::text as session_role, current_user::text as effective_role,
      (pg_control_system()).system_identifier::text as system_identifier from pg_database d where d.datname=current_database()`;
  yield* requireCondition(
    actual !== undefined &&
      actual.database_name === admin.database &&
      actual.database_owner === admin.user &&
      actual.session_role === admin.user &&
      actual.effective_role === admin.user,
    'core-owned-identity',
  );
  if (actual === undefined) {
    return yield* fail('core-owned-identity');
  }
  const certificate = yield* Schema.decodeUnknownEffect(PriceGroupOwnedDatabaseCertificateSchema)({
    adminRole: admin.user,
    adminUrl: admin.connectionString,
    creatorPid: process.pid,
    name: admin.database,
    oid: actual.database_oid,
    owner: actual.database_owner,
    runtimeRole: runtime.user,
    runtimeUrl: runtime.connectionString,
    serverAddress: actual.server_address,
    serverPort: actual.server_port,
    systemIdentifier: actual.system_identifier,
  });
  // Recheck both actual credentials, roles, server identity, OID and runtime RLS attributes before any receiving child.
  yield* guardPriceGroupOwnedDatabase(certificate);
  return { certificate, client };
});

const makeAuthority = Effect.fn('TemporalNative.makeAuthority')(function* makeAuthority(
  actor: typeof TrustedPrincipalContextSchema.Type,
  compositionRevision: string,
  buildMarker: string,
  nativeClock: Clock.Clock,
) {
  const crypto = yield* Crypto.Crypto;
  const generated = yield* Effect.tryPromise({
    catch: () => fail('issuer-key'),
    try: () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']),
  }).pipe(Effect.flatMap((keys) => ('privateKey' in keys ? Effect.succeed(keys) : Effect.fail(fail('issuer-key')))));
  const kid = yield* nextId;
  const exported = yield* Effect.tryPromise({
    catch: () => fail('issuer-public-key'),
    try: () => globalThis.crypto.subtle.exportKey('jwk', generated.publicKey),
  });
  const publicKey = yield* Schema.decodeUnknownEffect(PublicKeySchema)(exported);
  const issuer = 'https://temporal-price-group-parent.test';
  const jwks = yield* Schema.encodeEffect(Schema.fromJsonString(PublicKeysSchema))({
    keys: [{ ...publicKey, alg: 'EdDSA', kid, use: 'sig' }],
  });
  const issue = (subject = actor) =>
    Effect.gen(function* issueAssertion() {
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const header = Buffer.from(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ alg: Schema.Literal('EdDSA'), kid: Schema.String, typ: Schema.Literal('JWT') }),
          ),
        )({ alg: 'EdDSA', kid, typ: 'JWT' }),
      ).toString('base64url');
      const claims = yield* decodeSupportedGatewayContextClaims({
        aud: 'commerce-customer-context',
        compositionRevision,
        exp: now + GATEWAY_ASSERTION_TTL_SECONDS,
        iat: now,
        iss: issuer,
        jti: yield* crypto.randomUUIDv4(),
        principal: subject,
        sub: subject.principalId,
        targetBuildMarker: buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      });
      const payload = Buffer.from(
        yield* Schema.encodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claims),
      ).toString('base64url');
      const content = `${header}.${payload}`;
      const signature = yield* Effect.tryPromise({
        catch: () => fail('issuer-signature'),
        try: () => globalThis.crypto.subtle.sign('Ed25519', generated.privateKey, new TextEncoder().encode(content)),
      });
      return `Bearer ${content}.${Buffer.from(signature).toString('base64url')}`;
    }).pipe(Effect.provideService(Clock.Clock, nativeClock));
  return { issue, issuer, jwks };
});
// Only the creator may reapply canonical grants after the receiving owner rebuilds schemas.
const prepareDedicatedIdentities = Effect.fn('PricingTemporal.prepareDedicatedIdentities')(
  function* prepareDedicatedIdentities(bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type) {
    yield* requireCondition(bootstrap.database.creatorPid === process.pid, 'identity-setup-creator');
    const pair = yield* guardPriceGroupOwnedDatabase(bootstrap.database);
    yield* requireCondition(
      priceGroupDedicatedUrlMatches(
        Redacted.value(bootstrap.identities.partyUrl),
        bootstrap.database,
        'party_registry_runtime',
      ) &&
        priceGroupDedicatedUrlMatches(
          Redacted.value(bootstrap.identities.issuerUrl),
          bootstrap.database,
          'shell_gateway_issuer',
        ),
      'identity-setup-address',
    );
    const admin = Context.get(
      yield* Layer.build(PgClient.layer({ maxConnections: 1, url: Redacted.make(pair.admin.connectionString) })),
      PgClient.PgClient,
    );
    const [physical] = yield* admin<{ ready: boolean; system_identifier: string }>`select
      (pg_control_system()).system_identifier::text as system_identifier,
      has_schema_privilege('party_registry_runtime','party','USAGE') and
      has_function_privilege('shell_gateway_issuer','trust.register_gateway_scope_grant(text,text,uuid,uuid,uuid,uuid,timestamptz)','EXECUTE') as ready`;
    yield* requireCondition(
      physical?.system_identifier === bootstrap.database.systemIdentifier,
      'identity-setup-system',
    );
    const request = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          creatorPid: Schema.Int,
          databaseName: Schema.String,
          databaseOid: Schema.String,
          systemIdentifier: Schema.String,
          type: Schema.Literal('prepare-privacy-native-identities'),
        }),
      ),
    )({
      creatorPid: process.pid,
      databaseName: bootstrap.database.name,
      databaseOid: String(bootstrap.database.oid),
      systemIdentifier: bootstrap.database.systemIdentifier,
      type: 'prepare-privacy-native-identities',
    });
    // Repeat the unchanged creator CLI to establish idempotent manifest privilege application.
    for (const _pass of [0, 1]) {
      const setup = yield* ChildProcess.make(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../../../scripts/integration/support/privacy-native-database-identities.mts', import.meta.url),
          ),
          request,
        ],
        {
          cwd: process.cwd(),
          env: {
            APP_ENV_PATH: '/dev/null',
            DATABASE_ADMIN_URL: Redacted.value(bootstrap.database.adminUrl),
            DATABASE_URL: Redacted.value(bootstrap.database.runtimeUrl),
            PARTY_REGISTRY_DATABASE_URL: Redacted.value(bootstrap.identities.partyUrl),
            SHELL_GATEWAY_ISSUER_DATABASE_URL: Redacted.value(bootstrap.identities.issuerUrl),
          },
          extendEnv: false,
          stderr: 'pipe',
          stdin: 'ignore',
          stdout: 'pipe',
        },
      );
      const [exit, chunks] = yield* Effect.all(
        [setup.exitCode, Stream.runCollect(Stream.decodeText(setup.stdout)), Stream.runDrain(setup.stderr)],
        { concurrency: 3 },
      );
      yield* requireCondition(exit === 0, 'dedicated-identity-setup');
      const status = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            databaseName: Schema.String,
            databaseOid: Schema.String,
            systemIdentifier: Schema.String,
            type: Schema.Literal('privacy-native-identities-prepared'),
          }),
        ),
      )(chunks.join('').trim(), { onExcessProperty: 'error' });
      yield* requireCondition(
        status.databaseName === bootstrap.database.name &&
          status.databaseOid === String(bootstrap.database.oid) &&
          status.systemIdentifier === bootstrap.database.systemIdentifier,
        'dedicated-identity-receipt',
      );
    }
    return physical?.ready === true ? ('existing' as const) : ('fresh' as const);
  },
);
const startReceiver = Effect.fn('TemporalNative.startReceiver')(function* startReceiver(
  bundle: Effect.Success<ReturnType<typeof describeOwner>>,
  bootstrap: typeof PriceGroupTemporalBootstrapSchema.Type,
) {
  // The certificate comes directly from the still-live Core-created handle. This is trusted test
  // composition provenance, not a claim that a serialized handle is cryptographically unforgeable.
  // Repeat both credential/OID/role/server checks immediately before every receiving launch.
  yield* guardPriceGroupOwnedDatabase(bootstrap.database);
  yield* guardPriceGroupPreparedArtifact(bundle.prepared, 'commerce-customer-context');
  yield* guardPriceGroupPreparedArtifact(bootstrap.artifacts.catalog, 'price-group-catalog');
  yield* guardPriceGroupPreparedArtifact(bootstrap.artifacts.party, 'party-registry');
  const channel = yield* openPriceGroupTemporalChannel(PriceGroupTemporalResponseSchema);
  const child = yield* ChildProcess.make(process.execPath, [bundle.artifact, '--serve-price-group-current'], {
    cwd: bundle.directory,
    env: {
      ...priceGroupTemporalClosedEnvironment(bootstrap),
      [priceGroupTemporalSocketEnvironment]: channel.socketPath,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdin: 'ignore',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  yield* Stream.runDrain(child.stdout).pipe(Effect.forkScoped);
  const receiverExited = child.exitCode.pipe(Effect.flatMap((code) => Effect.fail(fail(`receiver-exited:${code}`))));
  const receive = Effect.raceFirst(channel.next, receiverExited).pipe(
    Effect.flatMap((response) =>
      response.type === 'FAILED'
        ? Effect.fail(fail(response.code === undefined ? response.stage : `${response.stage}:${response.code}`))
        : Effect.succeed(response),
    ),
  );

  const send = (command: Schema.Json) =>
    Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(command).pipe(
      Effect.flatMap((line) =>
        (Schema.is(Schema.Struct({ type: Schema.Literal('stop') }))(command) ? channel.beginClose : Effect.void).pipe(
          Effect.andThen(Effect.raceFirst(channel.send(line), receiverExited)),
        ),
      ),
    );
  yield* send(yield* Schema.encodeEffect(PriceGroupTemporalBootstrapSchema)(bootstrap));
  const schemasReady = yield* receive;
  yield* requireCondition(schemasReady.type === 'SCHEMAS_READY', 'owner-schemas-ready');
  const partyRuntimeBootstrap = yield* prepareDedicatedIdentities(bootstrap);
  yield* send({ type: 'IDENTITIES_READY', version: priceGroupTemporalProtocol });
  const ready = yield* receive;
  if (ready.type !== 'BOOTED') {
    return yield* fail('receiver-ready-order');
  }
  yield* requireCondition(
    ready.buildMarker === bundle.marker.buildMarker &&
      ready.compositionRevision === bootstrap.composition.composition.revision,
    'receiver-ready-identity',
  );
  const invoke = Effect.fn('TemporalNative.fixedCommand')(function* fixedCommand(
    type: 'CREATE_RETAIL_PARTY' | 'CREATE_G1' | 'CREATE_G2' | 'stop',
  ) {
    yield* send({ requestId: yield* nextId, type, version: priceGroupTemporalProtocol });
    return yield* receive;
  });
  // ChildProcess scope owns termination even when a public assertion fails. The explicit stop
  // acknowledgement permits successful tests to prove graceful close before database disposal.
  return {
    baseUrl: `http://127.0.0.1:${ready.port}`,
    child,
    invoke,
    partyRuntimeBootstrap,
  };
});

// Immutable artifacts outlive the case receiver; no database, credentials or process is shared here.
const prepareTemporalArtifacts = Effect.fn('PricingTemporal.prepareArtifacts')(function* prepareArtifacts() {
  yield* requireCondition((yield* Config.String('APP_ENV_PATH')) === '/dev/null', 'closed-artifact-environment');
  const commerce = yield* describeOwner('commerce-customer-context');
  const party = yield* describeOwner('party-registry');
  const catalog = yield* describeOwner('price-group-catalog');
  return Object.freeze({ catalog, commerce, party });
});
interface PreparedTemporalArtifactsId {
  readonly identifier: unique symbol;
}
const PreparedTemporalArtifacts: Context.Service<
  PreparedTemporalArtifactsId,
  Effect.Success<ReturnType<typeof prepareTemporalArtifacts>>
> = Context.Service('PricingTemporal.preparedArtifacts');
const temporalArtifactsLayer = Layer.effect(PreparedTemporalArtifacts, prepareTemporalArtifacts()).pipe(
  Layer.provideMerge(services),
);

const makeTemporalNative = Effect.fn('TemporalNative.make')(function* makeTemporalNative(
  mode: 'before' | 'current',
  nativeClock: Clock.Clock,
) {
  // Public Core fixture infrastructure reads its documented Config seam. Refuse source env-file
  // discovery before creating any owned database or permission relationship.
  yield* requireCondition((yield* Config.String('APP_ENV_PATH')) === '/dev/null', 'closed-parent-environment');
  const { catalog, commerce, party } = yield* PreparedTemporalArtifacts;
  const description = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DescriptionSchema))(commerce.description);
  const snapshot = yield* makePriceGroupTemporalComposition([commerce, party, catalog]);
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    mode: 'empty',
    purpose: 'stabilization-1248-price-group-effective-period',
  });
  yield* isolated.migrateCoreSchema();
  yield* isolated.publishInitialComposition(snapshot);
  const owned = yield* captureOwnedCertificate(isolated);
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: description.actionKeys,
      additionalLegalEntity: 'same-tenant',
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context', 'party-registry', 'price-group-catalog'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context', 'party.registry', 'pricing.price-group-catalog'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => Effect.orDie(resource.close()),
  );
  const actor = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const authority = yield* makeAuthority(
    actor,
    snapshot.composition.revision,
    commerce.marker.buildMarker,
    nativeClock,
  );
  const caCertificate = yield* Config.String('SPICEDB_CA_CERT').pipe(Config.option);
  const fixedSpice = {
    endpoint: yield* Config.String('SPICEDB_ENDPOINT'),
    token: yield* Config.Redacted('SPICEDB_PRESHARED_KEY'),
  };
  const spiceDb = Option.match(caCertificate.pipe(Option.filter((value) => value.length > 0)), {
    onNone: () => fixedSpice,
    onSome: (certificate) => ({ ...fixedSpice, caCertificate: certificate }),
  });
  const sourceConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const dedicatedUrl = Effect.fn('PricingTemporal.retargetDedicatedUrl')(function* retargetDedicatedUrl(
    identity: typeof PARTY_REGISTRY_REQUEST_IDENTITY,
  ) {
    const configured = yield* loadDatabaseConfig({ envPath: '/dev/null', identity });
    const role = identity.id === PARTY_REGISTRY_REQUEST_IDENTITY.id ? 'party_registry_runtime' : 'shell_gateway_issuer';
    yield* requireCondition(
      configured.user === identity.role &&
        configured.user === role &&
        configured.database === sourceConnections.admin.database &&
        configured.database === sourceConnections.runtime.database &&
        configured.host === sourceConnections.admin.host &&
        configured.host === sourceConnections.runtime.host &&
        configured.port === sourceConnections.admin.port &&
        configured.port === sourceConnections.runtime.port,
      'dedicated-source-url',
    );
    const address = new URL(configured.connectionString);
    address.pathname = `/${owned.certificate.name}`;
    yield* requireCondition(
      priceGroupDedicatedUrlMatches(address.href, owned.certificate, role),
      'dedicated-clone-url',
    );
    return Redacted.make(address.href);
  });
  const identities = {
    issuerUrl: yield* dedicatedUrl(SHELL_GATEWAY_ISSUER_IDENTITY),
    partyUrl: yield* dedicatedUrl(PARTY_REGISTRY_REQUEST_IDENTITY),
  };
  const bootstrap = yield* Schema.decodeUnknownEffect(Schema.toType(PriceGroupTemporalBootstrapSchema))({
    actor,
    artifacts: { catalog: catalog.prepared, party: party.prepared },
    composition: snapshot,
    database: owned.certificate,
    identities,
    issuer: authority.issuer,
    jwks: authority.jwks,
    mode,
    spiceDb,
    type: 'bootstrap',
    version: priceGroupTemporalProtocol,
  });
  const receiver = yield* startReceiver(commerce, bootstrap);
  const options = Effect.fn('TemporalNative.clientOptions')(function* clientOptions() {
    return {
      baseUrl: receiver.baseUrl,
      compositionRevision: snapshot.composition.revision,
      idempotencyKey: yield* nextId,
    };
  });
  const credential = authority.issue;
  return { actor, authority, bootstrap, credential, fixture, isolated, options, owned, receiver, snapshot };
});
interface TemporalCaseInfrastructureId {
  readonly identifier: unique symbol;
}
const TemporalCaseInfrastructure: Context.Service<
  TemporalCaseInfrastructureId,
  Effect.Success<ReturnType<typeof makeTemporalNative>>
> = Context.Service('PricingTemporal.caseInfrastructure');
const temporalCaseLayer = Layer.effect(
  TemporalCaseInfrastructure,
  Effect.gen(function* prepareCaseInfrastructure() {
    const nativeClock = yield* Clock.Clock;
    return yield* makeTemporalNative('current', nativeClock);
  }),
);

const temporalConsumer = Effect.fn('PricingTemporal.actualConsumer')(function* actualConsumer() {
  const native = yield* TemporalCaseInfrastructure;
  const context = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
  const business = Context.get(context, BusinessPermissionRelationshipMutation);
  const principal = { principalId: native.actor.principalId, tenantId: native.actor.tenantId };
  const grant = Effect.fn('PricingTemporal.grantOwnedPermission')(function* grantOwnedPermission(
    permission: Parameters<typeof business.mutate>[0]['permission'],
    target: Parameters<typeof business.mutate>[0]['target'],
  ) {
    const input = { permission, principal, target };
    yield* business.mutate({ ...input, operation: 'grant' });
    yield* Effect.addFinalizer(() => Effect.orDie(business.mutate({ ...input, operation: 'revoke' })));
  });
  const resource = Effect.fn('PricingTemporal.grantOwnedResource')(function* grantOwnedResource(reference: {
    readonly moduleId: string;
    readonly resourceId: string;
    readonly resourceType: string;
  }) {
    for (const permission of ['reader', 'writer'] as const) {
      yield* native.fixture.grantResourceAccess(reference, principal.principalId, permission);
      yield* Effect.addFinalizer(() =>
        Effect.orDie(native.fixture.revokeResourceAccess(reference, principal.principalId, permission)),
      );
    }
  });
  yield* grant('pricing.price_group.create', {
    kind: 'pricing_catalog',
    pricingCatalogId: principal.tenantId,
    tenantId: principal.tenantId,
  });
  const create = Effect.fn('PricingTemporal.createPublishedCatalogGroup')(function* createPublishedCatalogGroup(
    type: 'CREATE_G1' | 'CREATE_G2',
  ) {
    const response = yield* native.receiver.invoke(type);
    if (response.type !== 'CREATED_G1' && response.type !== 'CREATED_G2') {
      return yield* fail('catalog-create-order');
    }
    const { result } = response;
    yield* grant('pricing.price_group.read', {
      kind: 'price_group',
      priceGroupId: result.identity.priceGroupRef.resourceId,
      pricingCatalogId: principal.tenantId,
      tenantId: principal.tenantId,
    });
    return result;
  });
  const first = yield* create('CREATE_G1');
  const second = yield* create('CREATE_G2');
  const party = yield* native.receiver.invoke('CREATE_RETAIL_PARTY');
  if (party.type !== 'RETAIL_PARTY_CREATED') {
    return yield* fail('party-create-order');
  }
  yield* resource(party.partyRef);
  const profile = yield* executeEnsureRetailCustomerProfileWithAuthorization(
    {
      effectiveAt: DateTime.formatIso(yield* DateTime.now),
      subject: {
        kind: 'RETAIL',
        partyRef: party.partyRef,
        sellingLegalEntityRef: {
          moduleId: 'core.identity',
          resourceId: native.fixture.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: principal.tenantId,
        },
      },
      trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  yield* resource(profile.profileRef);
  yield* grant('retail.profile.read', {
    kind: 'retail_profile',
    legalEntityId: native.fixture.legalEntityId,
    profileId: profile.profileRef.resourceId,
    tenantId: principal.tenantId,
  });
  yield* preparePriceGroupTemporalRetailAccess({
    certificate: native.owned.certificate,
    effectiveAt: DateTime.formatIso(yield* DateTime.now),
    fixture: native.fixture,
    profileRef: profile.profileRef,
  });
  const latestStart = Math.max(
    ...[first, second].map((group) =>
      DateTime.toEpochMillis(DateTime.makeUnsafe(group.initialDefinition.effectivePeriod.effectiveFrom)),
    ),
  );
  const wait = latestStart - DateTime.toEpochMillis(yield* DateTime.now);
  if (wait > 0) {
    yield* Effect.sleep(wait + 1);
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const start = DateTime.formatIso(DateTime.makeUnsafe(now + 5000));
  const transition = DateTime.formatIso(DateTime.makeUnsafe(now + 8000));
  const end = DateTime.formatIso(DateTime.makeUnsafe(now + 60_000));
  const target = { ...profile.profileRef, kind: 'RETAIL' as const };
  const assign = Effect.fn('PricingTemporal.assignPublishedGroup')(function* assignPublishedGroup(
    priceGroupRef: typeof first.identity.priceGroupRef,
    effectiveFrom: string,
  ) {
    return yield* executeAssignCustomerPriceGroupWithAuthorization(
      {
        effectiveFrom,
        effectiveTo: end,
        expectedProfileRevision: profile.revision,
        priceGroupRef,
        profile: target,
        reason: 'Actual Pricing temporal consumer proof',
      },
      yield* native.credential(),
      yield* nextId,
      yield* native.options(),
    );
  });
  const initial = yield* assign(first.identity.priceGroupRef, start);
  const replacement = yield* assign(second.identity.priceGroupRef, transition);
  const issuer = CommercePriceGroupResolutionGatewayCredentialService.of({
    issue: (input) =>
      Effect.gen(function* issueExactCommerceCredential() {
        if (
          input.audience !== 'commerce-customer-context' ||
          input.compositionRevision !== native.snapshot.composition.revision ||
          input.legalEntityId !== native.fixture.legalEntityId
        ) {
          return yield* new PriceGroupOwnerGatewayUnavailable({
            owner: 'COMMERCE_ASSIGNMENT',
            reason: 'Outside the captured temporal test receiver',
          });
        }
        return {
          baseUrl: new URL(native.receiver.baseUrl),
          credential: Redacted.make(yield* Effect.orDie(native.credential())),
        };
      }),
  });
  const port = yield* commercePriceGroupResolutionPortFromEnvironment({
    compositionRevision: native.snapshot.composition.revision,
    legalEntityId: native.fixture.legalEntityId,
    requestCorrelation: yield* nextId,
    tenantId: principal.tenantId,
  }).pipe(Effect.provideService(CommercePriceGroupResolutionGatewayCredentialService, issuer));
  const resolve = (effectiveAt: string) =>
    port.resolve({
      request: { authorizationSubject: { kind: 'RETAIL' }, effectiveAt, profile: target },
      sellingLegalEntityId: native.fixture.legalEntityId,
    });
  let remaining = DateTime.toEpochMillis(DateTime.makeUnsafe(transition)) - DateTime.toEpochMillis(yield* DateTime.now);
  if (remaining > 0) {
    yield* Effect.sleep(remaining + 1);
  }
  const before = yield* Schema.decodeUnknownEffect(PriceGroupAssignmentResolutionSchema.members[0])(
    (yield* resolve(start)).resolution,
  );
  const at = yield* Schema.decodeUnknownEffect(PriceGroupAssignmentResolutionSchema.members[0])(
    (yield* resolve(transition)).resolution,
  );
  expect(before.assignmentRef).toEqual(initial.assignment.assignmentRef);
  expect(before.priceGroupRef).toEqual(first.identity.priceGroupRef);
  expect(at.assignmentRef).toEqual(replacement.assignment.assignmentRef);
  expect(at.priceGroupRef).toEqual(second.identity.priceGroupRef);
  const removalAt = DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) + 3000));
  yield* executeRemoveCustomerPriceGroupWithAuthorization(
    {
      assignmentRef: replacement.assignment.assignmentRef,
      effectiveAt: removalAt,
      expectedRevision: replacement.assignment.revision,
      profile: target,
      reason: 'Actual consumer removal boundary',
    },
    yield* native.credential(),
    yield* nextId,
    yield* native.options(),
  );
  remaining = DateTime.toEpochMillis(DateTime.makeUnsafe(removalAt)) - DateTime.toEpochMillis(yield* DateTime.now);
  if (remaining > 0) {
    yield* Effect.sleep(remaining + 1);
  }
  expect(Schema.is(PriceGroupAssignmentResolutionSchema.members[1])((yield* resolve(removalAt)).resolution)).toBe(true);
  // These inert basis references exercise only no-group interpretation, never a Catalog lookup,
  // Price write or complete pricing decision. All temporal owner evidence above is genuine.
  const basis = yield* Schema.decodeUnknownEffect(PriceGroupInterpretationBasisSchema)({
    catalogSelection: {
      productRef: {
        moduleId: 'commerce.catalog',
        resourceId: yield* nextId,
        resourceType: 'commerce.catalog.product',
        tenantId: principal.tenantId,
      },
      variantRef: {
        moduleId: 'commerce.catalog',
        resourceId: yield* nextId,
        resourceType: 'commerce.catalog.variant',
        tenantId: principal.tenantId,
      },
    },
    commercialScope: { channelId: 'B2B', marketId: 'CZ', sellingLegalEntityId: native.fixture.legalEntityId },
    currencyCode: 'CZK',
    unitBasis: {
      quantity: '1',
      unitRef: {
        moduleId: 'commerce.catalog',
        resourceId: yield* nextId,
        resourceType: 'commerce.catalog.product-unit',
        tenantId: principal.tenantId,
      },
    },
  });
  const interpretation = yield* makePriceGroupInterpretationService({
    commerce: port,
    compatibility: { validate: () => Effect.die(fail('no-group-must-not-call-catalog')) },
  }).interpret({
    assignmentRequest: { authorizationSubject: { kind: 'RETAIL' }, effectiveAt: removalAt, profile: target },
    basis,
  });
  expect(yield* Schema.decodeUnknownEffect(NonePriceGroupInterpretationSchema)(interpretation)).toMatchObject({
    discountAudience: { kind: 'NONE' },
    priceSelector: { kind: 'NO_GROUP' },
  });
  expect((yield* native.receiver.invoke('stop')).type).toBe('STOPPED');
  return yield* Effect.void;
});
const temporalArtifactMemoMap = Layer.makeMemoMapUnsafe();
it.layer(temporalArtifactsLayer, {
  excludeTestServices: true,
  memoMap: temporalArtifactMemoMap,
  timeout: 120_000,
})(() => {
  it.layer(temporalCaseLayer.pipe(Layer.provideMerge(temporalArtifactsLayer)), {
    excludeTestServices: true,
    memoMap: temporalArtifactMemoMap,
    timeout: 120_000,
  })((pricingIt) => {
    pricingIt.effect(
      'uses the original authorized Commerce client for G1 before T, G2 at T, and real no-group interpretation at removal',
      temporalConsumer,
      120_000,
    );
  });
});
