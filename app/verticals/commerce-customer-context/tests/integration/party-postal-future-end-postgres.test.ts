import { PgClient } from '@effect/sql-pg';
import { Reactivity } from 'effect/reactivity';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ActionPayloadValidationError,
  ActionRuntime,
  loadDatabaseConnectionPair,
  loadDatabaseConfig,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  OntosModuleDeploymentContractSchema,
  canonicalizeApplicationComposition,
  defineScopedRoutine,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeGatewayScopeGrantRegistrar, makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeModuleContractFixture } from '@app/core-runtime/testing/module-contract';
import {
  createPartyWithAuthorization,
  addContactPointWithAuthorization,
  endContactPointWithAuthorization,
  executePartyContactPointDetailWithAuthorization,
  executePartyDetailWithAuthorization,
} from '@app/party-registry/api/client';
import type { executePartyContactPointDetail } from '@app/party-registry/api/client';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import {
  Brand,
  Config,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
  Stream,
} from 'effect';
import { ChildProcess } from 'effect/process';
import { HttpServer, HttpServerResponse } from 'effect/http';
import { assert, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { RetailPortalBindingResultSchema } from '../../shared/actions/bind-retail-portal-profile.ts';
import {
  RETAIL_PORTAL_SELF_SERVICE_BASELINE,
  RetailPortalPermissionCodeSchema,
} from '../../shared/domain/profile-contracts.ts';
import { AddSavedAddressPayloadSchema, UpdateSavedAddressPayloadSchema } from '../../shared/domain/address-actions.ts';
import {
  AddressBookDomainErrorSchema,
  AddressBookUnavailable,
  SavedAddressInvalidSchema,
} from '../../shared/domain/address-errors.ts';
import { AddressBookProfileSchema } from '../../shared/domain/address-book.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { updateSavedAddressAction } from '../../src/actions/update-saved-address.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import {
  PartyAddressSourceExecutor,
  partyBackedPostalAddressResolver,
} from '../../src/integrations/party-address-source.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import {
  makePartyRegistryRetailPartyResolver,
  PartyRegistryRetailPartyResolverFactory,
} from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { addressReadServicesForTransaction } from '../../src/persistence/address-persistence.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const nextId = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const MarkerSchema = Schema.Struct({ appId: Schema.Literal('party-registry'), buildMarker: Schema.String });
const ReadySchema = Schema.Struct({ marker: MarkerSchema, port: Schema.Number, type: Schema.Literal('ready') });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const bindProfile = defineScopedRoutine({
  name: 'mutate_retail_portal_binding',
  ownerModuleKey: 'commerce.customer-context',
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
  routineKey: 'test.native-binding',
  schema: 'commerce_customer_context',
});
const NativeIdentitySchema = Schema.String.pipe(Schema.brand('NativeIdentity'));
const readBindingIntent = defineScopedRoutine({
  name: 'read_retail_portal_profile_binding_permission_mutation',
  ownerModuleKey: 'commerce.customer-context',
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
  ownerModuleKey: 'commerce.customer-context',
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
  ownerModuleKey: 'commerce.customer-context',
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
  ownerModuleKey: 'commerce.customer-context',
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

const preparePostalFutureEnd = Effect.fn('PostalFutureEnd.prepare')(function* preparePostalFutureEnd() {
  // An executable owner fixture is process infrastructure, never a private cross-owner import.
  const artifact = `${appRoot}verticals/party-registry/node_modules/.cache/ontos-1251/${randomUUID()}.mjs`;
  yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
  const bundle = yield* ChildProcess.make(
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
    { cwd: appRoot, extendEnv: true, stderr: 'pipe', stdout: 'pipe' },
  );
  const [bundleExit] = yield* Effect.all(
    [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
    { concurrency: 3 },
  );
  expect(bundleExit).toBe(0);
  const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
    cwd: appRoot,
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [lines, descriptionExit] = yield* Effect.all(
    [
      description.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      description.exitCode,
      Stream.runDrain(description.stderr),
    ],
    { concurrency: 3 },
  );
  expect(descriptionExit).toBe(0);
  const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MarkerSchema))(lines[0]);
  const base = yield* makeEnrollmentApplicationCompositionSnapshot(marker.buildMarker, ['party-registry']);
  const contract = yield* Schema.decodeUnknownEffect(OntosModuleDeploymentContractSchema)(
    makeModuleContractFixture({
      appId: 'party-registry',
      buildMarker: marker.buildMarker,
      moduleId: 'party.registry',
    }),
  );
  const contractDocument = yield* Schema.encodeEffect(Schema.fromJsonString(OntosModuleDeploymentContractSchema))(
    contract,
  );
  const composition = {
    ...base.composition,
    modules: base.composition.modules.map((module) =>
      module.deployment.appId === 'party-registry'
        ? {
            ...module,
            contract: { ...module.contract, sha256: hash(contractDocument) },
            contractDocument,
            moduleId: 'party.registry',
            publicContract: {
              id: 'party.registry',
              sha256: hash(contractDocument),
              version: contract.schemaVersion,
            },
          }
        : module,
    ),
    revision: '0'.repeat(64),
  };
  const snapshot = yield* validateActiveApplicationCompositionSnapshot({
    ...base,
    composition: { ...composition, revision: hash(canonicalizeApplicationComposition(composition)) },
  });
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'stabilization-1251-postal-future-end',
  });
  yield* isolated.assertClonedSchema();
  const sourceConnections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const ownerSchema = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/party-registry',
      'exec',
      'node',
      'tests/support/current-owner-schema.fixture.ts',
      'rebuild',
    ],
    {
      cwd: appRoot,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        DATABASE_URL: isolated.connections.runtime.connectionString,
        ONTOS_FIXTURE_OWNED_DATABASE: isolated.connections.admin.database,
        ONTOS_FIXTURE_SOURCE_DATABASE: sourceConnections.admin.database,
      },
      extendEnv: true,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [ownerSchemaExit] = yield* Effect.all(
    [ownerSchema.exitCode, Stream.runDrain(ownerSchema.stdout), Stream.runDrain(ownerSchema.stderr)],
    { concurrency: 3 },
  );
  expect(ownerSchemaExit).toBe(0);
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));
  const transportConfiguration = yield* Config.all({
    PATH: Config.String('PATH'),
    SPICEDB_CA_CERT: Config.String('SPICEDB_CA_CERT'),
    SPICEDB_ENDPOINT: Config.String('SPICEDB_ENDPOINT'),
    SPICEDB_PRESHARED_KEY: Config.Redacted('SPICEDB_PRESHARED_KEY'),
  });
  const bootstrapAdmin = Context.get(coreEvidenceContext, PgClient.PgClient);
  const [physicalIdentity] = yield* bootstrapAdmin<{
    readonly databaseName: string;
    readonly databaseOid: string;
    readonly owned: boolean;
    readonly systemIdentifier: string;
  }>`select current_database() as "databaseName", d.oid::text as "databaseOid",
    (pg_control_system()).system_identifier::text as "systemIdentifier",
    pg_get_userbyid(d.datdba)=current_user and current_user=session_user as owned
    from pg_database d where d.datname=current_database()`;
  const identity = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      databaseName: Schema.String.check(Schema.isPattern(/^ontos_test_party_gateway_[a-f0-9]{32}$/u)),
      databaseOid: Schema.String.check(Schema.isPattern(/^\d+$/u)),
      owned: Schema.Literal(true),
      systemIdentifier: Schema.String.check(Schema.isPattern(/^\d+$/u)),
    }),
  )(physicalIdentity);
  const identityUrls: Record<string, string> = {};
  for (const databaseIdentity of [SHELL_GATEWAY_ISSUER_IDENTITY, PARTY_REGISTRY_REQUEST_IDENTITY]) {
    const canonical = yield* loadDatabaseConfig({ envPath: '/dev/null', identity: databaseIdentity });
    const address = new URL(canonical.connectionString);
    const exactSourceAndOwnedTarget = [
      canonical.database === sourceConnections.runtime.database,
      canonical.database === sourceConnections.admin.database,
      canonical.host === sourceConnections.runtime.host,
      canonical.port === sourceConnections.runtime.port,
      canonical.host === sourceConnections.admin.host,
      canonical.port === sourceConnections.admin.port,
      canonical.user === databaseIdentity.role,
      canonical.host === isolated.connections.admin.host,
      canonical.port === isolated.connections.admin.port,
      isolated.connections.runtime.host === isolated.connections.admin.host,
      isolated.connections.runtime.port === isolated.connections.admin.port,
      isolated.connections.admin.database === identity.databaseName,
      isolated.connections.runtime.database === identity.databaseName,
      identity.databaseName !== sourceConnections.admin.database,
      identity.databaseName !== sourceConnections.runtime.database,
      ['localhost', '127.0.0.1'].includes(canonical.host),
      address.search === '',
      address.hash === '',
    ].every(Boolean);
    assert.isOk(exactSourceAndOwnedTarget, 'POSTAL_IDENTITY_TARGET_REFUSED');
    // Preserve the canonical login and credential; retarget only this creator-owned database.
    address.pathname = `/${identity.databaseName}`;
    identityUrls[databaseIdentity.urlKey] = address.href;
  }
  const issuerUrl = identityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL;
  const requestUrl = identityUrls.PARTY_REGISTRY_DATABASE_URL;
  assert.isOk(issuerUrl !== undefined && requestUrl !== undefined, 'POSTAL_IDENTITIES_INCOMPLETE');
  const identitySetupRequest = yield* Schema.encodeEffect(
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
    databaseName: identity.databaseName,
    databaseOid: identity.databaseOid,
    systemIdentifier: identity.systemIdentifier,
    type: 'prepare-privacy-native-identities',
  });
  // Reapply the canonical restricted manifests after the owner rebuilt its empty cloned schemata.
  const identitySetup = yield* ChildProcess.make(
    process.execPath,
    [`${appRoot}scripts/integration/support/privacy-native-database-identities.mts`, identitySetupRequest],
    {
      cwd: appRoot,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        DATABASE_URL: isolated.connections.runtime.connectionString,
        PATH: transportConfiguration.PATH,
        ...identityUrls,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [identityLines, identitySetupExit] = yield* Effect.all(
    [
      identitySetup.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
      identitySetup.exitCode,
      Stream.runDrain(identitySetup.stderr),
    ],
    { concurrency: 3 },
  );
  expect(identitySetupExit).toBe(0);
  expect(identityLines).toHaveLength(1);
  yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(
      Schema.Struct({
        databaseName: Schema.Literal(identity.databaseName),
        databaseOid: Schema.Literal(identity.databaseOid),
        systemIdentifier: Schema.Literal(identity.systemIdentifier),
        type: Schema.Literal('privacy-native-identities-prepared'),
      }),
    ),
  )(identityLines[0], { onExcessProperty: 'error' });
  const ownerVerification = yield* ChildProcess.make(
    'mise',
    [
      'exec',
      '--',
      'pnpm',
      '--filter',
      '@app/party-registry',
      'exec',
      'node',
      'tests/support/current-owner-schema.fixture.ts',
      'verify',
    ],
    {
      cwd: appRoot,
      env: {
        APP_ENV_PATH: '/dev/null',
        DATABASE_ADMIN_URL: isolated.connections.admin.connectionString,
        DATABASE_URL: isolated.connections.runtime.connectionString,
        ONTOS_FIXTURE_OWNED_DATABASE: isolated.connections.admin.database,
        ONTOS_FIXTURE_SOURCE_DATABASE: sourceConnections.admin.database,
        PARTY_REGISTRY_DATABASE_URL: requestUrl,
        PATH: transportConfiguration.PATH,
      },
      extendEnv: false,
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  const [ownerVerificationExit] = yield* Effect.all(
    [ownerVerification.exitCode, Stream.runDrain(ownerVerification.stdout), Stream.runDrain(ownerVerification.stderr)],
    { concurrency: 3 },
  );
  expect(ownerVerificationExit).toBe(0);
  const issuerContext = yield* Layer.build(
    PgClient.layer({ maxConnections: 2, url: Redacted.make(issuerUrl) }).pipe(Layer.provide(Reactivity.layer)),
  );
  const scopeGrantRegistrar = makeGatewayScopeGrantRegistrar(Context.get(issuerContext, PgClient.PgClient));
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        'party.registry.create-party',
        'party.registry.add-contact-point',
        'party.registry.end-contact-point',
        addSavedAddressAction.descriptor.actionKey,
        updateSavedAddressAction.descriptor.actionKey,
        ensureRetailCustomerProfileAction.descriptor.actionKey,
      ],
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['party-registry', 'commerce-customer-context'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['party.registry', 'commerce.customer-context'],
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const { privateKey, publicKey } = yield* Effect.promise(() => generateKeyPair('Ed25519'));
  const publicJwk = yield* Effect.promise(() => exportJWK(publicKey));
  const issuer = 'https://disposable-postal-authority.ontos.test';
  const kid = yield* nextId;
  const snapshotDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(snapshot);
  // This source server has a per-case scope; its shutdown cannot invalidate another test case.
  const sourceContext = yield* Layer.build(NodeHttpServer.layerTest);
  const source = Context.get(sourceContext, HttpServer.HttpServer);
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotDocument, { contentType: 'application/json' })));
  assert.isOk(Schema.is(Schema.Struct({ port: Schema.Number }))(source.address));
  const child = yield* ChildProcess.make(process.execPath, [artifact], {
    cwd: appRoot,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_URL: isolated.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${source.address.port}/active-composition`,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
      PARTY_REGISTRY_DATABASE_URL: requestUrl,
      PATH: transportConfiguration.PATH,
      SPICEDB_CA_CERT: transportConfiguration.SPICEDB_CA_CERT,
      SPICEDB_ENDPOINT: transportConfiguration.SPICEDB_ENDPOINT,
      SPICEDB_PRESHARED_KEY: Redacted.value(transportConfiguration.SPICEDB_PRESHARED_KEY),
    },
    extendEnv: false,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const first = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  assert.isOk(Option.isSome(first));
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ReadySchema))(first.value);
  expect(ready.marker).toEqual(marker);
  const baseUrl = `http://127.0.0.1:${ready.port}/party-registry-api`;
  const authorization = Effect.fn('PostalAuthorityTest.authorization')(function* authorization(actor = principal) {
    const id = yield* nextId;
    // Registration checks this same owned PostgreSQL clock; sample it once for both exact claims.
    const [issuanceClock] = yield* bootstrapAdmin<{ readonly epochSeconds: number }>`select
      floor(extract(epoch from clock_timestamp()))::integer as "epochSeconds"`;
    const { epochSeconds: issuedAtEpochSeconds } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ epochSeconds: Schema.Int }),
    )(issuanceClock);
    const expiresAtEpochSeconds = issuedAtEpochSeconds + 300;
    const token = yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: snapshot.composition.revision,
        principal: actor,
        targetBuildMarker: marker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
        .setIssuer(issuer)
        .setAudience('party-registry')
        .setSubject(actor.principalId)
        .setIssuedAt(issuedAtEpochSeconds)
        .setExpirationTime(expiresAtEpochSeconds)
        .setJti(id)
        .sign(privateKey),
    );
    yield* scopeGrantRegistrar.register({
      assertion: Redacted.make(token),
      audience: 'party-registry',
      expiresAtEpochSeconds,
      jti: id,
      legalEntityId: actor.legalEntityId,
      principalId: actor.principalId,
      tenantId: actor.tenantId,
    });
    return `Bearer ${token}`;
  });
  const options = Effect.gen(function* options() {
    return {
      baseUrl,
      compositionRevision: snapshot.composition.revision,
      correlationId: yield* nextId,
      idempotencyKey: yield* nextId,
    };
  });

  // TEST issuer and transport only: each request crosses the real owner HTTP verifier,
  // native redemption, Core permission checks, registered producer and PostgreSQL commit.
  const authorizationContext = yield* Effect.context<Crypto.Crypto>();
  const client: typeof executePartyContactPointDetail = (request, correlation) =>
    authorization().pipe(
      Effect.provideContext(authorizationContext),
      Effect.orDie,
      Effect.flatMap((credential) =>
        executePartyContactPointDetailWithAuthorization(request, credential, correlation, {
          baseUrl,
          compositionRevision: snapshot.composition.revision,
        }),
      ),
    );
  const retailFactory = Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
    make: (scope) =>
      makePartyRegistryRetailPartyResolver(scope, (request, correlation) =>
        authorization().pipe(
          Effect.provideContext(authorizationContext),
          Effect.orDie,
          Effect.flatMap((credential) =>
            executePartyDetailWithAuthorization(request, credential, correlation, {
              baseUrl,
              compositionRevision: snapshot.composition.revision,
            }),
          ),
        ),
      ),
  });
  const owners = Layer.mergeAll(
    retailFactory,
    partyRegistryGuestResolverFactoryLive,
    profileCounterpartyRoleEligibilityResolverFactoryLive,
    profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive)),
    profileReactivationEligibilityEvaluatorFactoryLive.pipe(Layer.provide(profileReconfirmationPolicyUnavailableLive)),
    commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
      Layer.provide(profileRetailPermissionReaderFactoryLive),
      Layer.provide(ContextAccessLive),
    ),
  );
  const context = yield* Layer.build(fixture.layer.pipe(Layer.provideMerge(owners)));
  const runtime = Context.get(context, ActionRuntime);
  // The layer owns infrastructure; no business producer runs until the case consumes this fixture.
  return { authorization, child, client, context, coreEvidenceExecutor, fixture, options, principal, runtime };
});

const PostalFixture =
  Context.Service<Effect.Success<ReturnType<typeof preparePostalFutureEnd>>>('PostalFutureEnd.fixture');
const postalFixtureLayer = Layer.effect(PostalFixture, preparePostalFutureEnd()).pipe(Layer.provideMerge(services));

const postalFutureEnd = Effect.fn('PostalFutureEnd.native')(function* postalFutureEnd() {
  const { authorization, child, client, context, coreEvidenceExecutor, fixture, options, principal, runtime } =
    yield* PostalFixture;
  const subjectKey = Brand.nominal<
    NonNullable<
      Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
    >[number]['subjectKey']
  >()(yield* nextId);
  const created = yield* createPartyWithAuthorization(
    {
      candidate: {
        displayName: 'Postal future End owner',
        evidenceRefs: ['native-postal-owner-proof'],
        officialIdentifiers: [{ identifierType: 'ICO', value: '27074358', verification: 'VERIFIED' }],
        partyType: 'ORGANIZATION',
        provenance: { method: 'REVIEWED_DOCUMENT', source: 'postal-future-end-native' },
        subjectEvidence: [
          {
            basis: 'REVIEWED_DOCUMENT',
            evidenceRef: 'native-postal-owner-proof',
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'ORGANIZATION',
            statement: 'Reviewed the postal source owner',
            subjectKey,
          },
        ],
        validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      },
    },
    yield* authorization(),
    yield* options,
  );
  assert.isOk(created.outcome === 'CREATED');
  const legalEntityRef = {
    moduleId: 'core.identity' as const,
    resourceId: fixture.legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId: fixture.tenantId,
  };
  const profileResult = yield* runtime
    .runAction({
      payload: {
        effectiveAt: DateTime.formatIso(yield* DateTime.now),
        subject: { kind: 'RETAIL', partyRef: created.partyRef, sellingLegalEntityRef: legalEntityRef },
        trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
      },
      principal,
      registration: ensureRetailCustomerProfileAction,
      transport: {
        correlationId: randomUUID(),
        idempotencyKey: randomUUID(),
        targetModuleKey: 'commerce.customer-context',
      },
    })
    .pipe(Effect.provideContext(context));
  expect(profileResult.outcome).toBe('PROFILE_CREATED');
  const profile = yield* Schema.decodeUnknownEffect(AddressBookProfileSchema)({
    kind: 'RETAIL',
    profileRef: profileResult.profileRef,
  });
  // Actual initial binding effective input, captured before beginning its governed operation.
  const bindingEffectiveAt = DateTime.formatIso(yield* DateTime.now);
  const prepared = yield* fixture
    .prepareOwner(
      (transaction) =>
        Effect.gen(function* bindExactRetailProfile() {
          const at = bindingEffectiveAt;
          // Initial TEST authority attribution, not represented as a Core Action invocation.
          const bindingInvocationId = randomUUID();
          const [binding] = yield* transaction.invoke(bindProfile, [
            profile.profileRef.resourceId,
            fixture.manager.principalId,
            fixture.manager.authBindingId,
            'native-postal-authority',
            null,
            null,
            'BIND',
            at,
            'Native postal source permission proof',
            bindingInvocationId,
            fixture.manager.principalId,
          ]);
          assert.isOk(binding !== undefined);
          return { at, binding: binding.payload, bindingInvocationId };
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));
  const profileId = profile.profileRef.resourceId;
  const mutationContext = yield* Layer.build(BusinessPermissionRelationshipMutationLive);
  const business = Context.get(mutationContext, BusinessPermissionRelationshipMutation);
  const intents = prepared.binding.permissionMutations;
  assert.isOk(intents !== undefined);
  expect(intents).toHaveLength(RETAIL_PORTAL_SELF_SERVICE_BASELINE.length);
  expect(new Set(intents.map(({ permission }) => permission))).toEqual(new Set(RETAIL_PORTAL_SELF_SERVICE_BASELINE));
  for (const intent of intents) {
    const grant = {
      permission: intent.permission,
      principal: { principalId: fixture.manager.principalId, tenantId: fixture.tenantId },
      target: {
        kind: 'retail_profile' as const,
        legalEntityId: fixture.legalEntityId,
        profileId,
        tenantId: fixture.tenantId,
      },
    };
    yield* fixture
      .prepareOwner(
        (transaction) =>
          Effect.gen(function* reconcileExactBindingIntent() {
            const [current] = yield* transaction.invoke(readBindingIntent, [intent.mutationId]);
            expect(current?.payload).toMatchObject({
              actionInvocationId: prepared.bindingInvocationId,
              bindingId: prepared.binding.bindingRef.resourceId,
              mutationId: intent.mutationId,
              operation: 'grant',
              permission: intent.permission,
              principalId: fixture.manager.principalId,
              profileId,
              state: 'PENDING_GRANT',
            });
            yield* business.mutate({ ...grant, operation: 'grant' });
            yield* transaction.invoke(finalizeBindingIntent, [intent.mutationId, 'grant', 'ACTIVE']);
          }),
        'required',
      )
      .pipe(Effect.provideContext(context));
    yield* Effect.addFinalizer(() => business.mutate({ ...grant, operation: 'revoke' }).pipe(Effect.orDie));
  }
  yield* fixture
    .prepareOwner(
      (transaction) =>
        Effect.gen(function* finalizeExactBindingAuthority() {
          yield* transaction.invoke(finalizeBinding, [
            prepared.binding.bindingRef.resourceId,
            'grant',
            prepared.binding.revision,
            prepared.bindingInvocationId,
            prepared.at,
            'Native purchase permission proof',
            fixture.manager.principalId,
          ]);
          const [authority] = yield* transaction.invoke(readBindingAuthority, [
            prepared.binding.bindingRef.resourceId,
            'grant',
          ]);
          expect(authority?.payload).toMatchObject({
            authorizationState: 'ACTIVE',
            pendingCount: 0,
            terminalCount: RETAIL_PORTAL_SELF_SERVICE_BASELINE.length,
          });
        }),
      'required',
    )
    .pipe(Effect.provideContext(context));

  yield* fixture.grantResourceAccess(profile.profileRef, principal.principalId);
  const add = (value: typeof AddSavedAddressPayloadSchema.Type) =>
    Schema.encodeEffect(AddSavedAddressPayloadSchema)(value).pipe(
      Effect.flatMap((payload) =>
        runtime.runAction({
          payload,
          principal,
          registration: addSavedAddressAction,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
            targetModuleKey: 'commerce.customer-context',
          },
        }),
      ),
      Effect.provideContext(Context.add(context, PartyAddressSourceExecutor, client)),
    );
  const update = (value: typeof UpdateSavedAddressPayloadSchema.Type) =>
    Schema.encodeEffect(UpdateSavedAddressPayloadSchema)(value).pipe(
      Effect.flatMap((payload) =>
        runtime.runAction({
          payload,
          principal,
          registration: updateSavedAddressAction,
          transport: {
            correlationId: randomUUID(),
            idempotencyKey: randomUUID(),
            targetModuleKey: 'commerce.customer-context',
          },
        }),
      ),
      Effect.provideContext(Context.add(context, PartyAddressSourceExecutor, client)),
    );
  const provenance = {
    authoritative: true,
    method: 'MANUAL_CONFIRMATION' as const,
    source: 'PARTY_DECLARATION' as const,
  };
  const address = yield* addContactPointWithAuthorization(
    {
      contactPoint: {
        address: { addressLine1: '1 Native Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
        purposes: [
          { preferred: false, purpose: 'BILLING' },
          { preferred: false, purpose: 'DELIVERY' },
        ],
        type: 'ADDRESS',
      },
      partyRef: created.partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance,
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      verification: {
        method: 'MANUAL_CONFIRMATION',
        state: 'VERIFIED',
        verifiedAt: yield* DateTime.now,
        verifierReference: 'native-postal-source-verifier',
      },
    },
    yield* authorization(),
    yield* options,
  );
  const original = yield* client({ contactPointRef: address.contactPointRef }, randomUUID());
  expect(original.current).toBe(true);
  const openOrigin = {
    contactPointRef: address.contactPointRef,
    kind: 'PARTY_BACKED' as const,
    partyRef: created.partyRef,
    sourceRevision: original.revision,
  };
  // Keep the open-ended Saved Address control separate from the main finite source.
  const openControlContact = yield* addContactPointWithAuthorization(
    {
      contactPoint: {
        address: {
          addressLine1: '3 Independent Control Street',
          city: 'Prague',
          countryCode: 'CZ',
          postalCode: '11000',
        },
        purposes: [
          { preferred: false, purpose: 'BILLING' },
          { preferred: false, purpose: 'DELIVERY' },
        ],
        type: 'ADDRESS',
      },
      partyRef: created.partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance,
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      verification: {
        method: 'MANUAL_CONFIRMATION',
        state: 'VERIFIED',
        verifiedAt: yield* DateTime.now,
        verifierReference: 'native-postal-source-verifier',
      },
    },
    yield* authorization(),
    yield* options,
  );
  expect(openControlContact.contactPointRef).not.toEqual(address.contactPointRef);
  const openControlDetail = yield* client({ contactPointRef: openControlContact.contactPointRef }, randomUUID());
  expect(openControlDetail.current).toBe(true);
  expect(openControlDetail.validTo).toBe(null);
  const openControlOrigin = {
    ...openOrigin,
    contactPointRef: openControlContact.contactPointRef,
    sourceRevision: openControlDetail.revision,
  };
  const open = yield* add({
    origin: openControlOrigin,
    profile,
    purposes: ['BILLING', 'DELIVERY'],
    reason: 'Open-ended control',
  });
  expect(open.outcome).toBe('ADDED');
  const changedOpenLabel = yield* Effect.result(
    add({
      label: 'A changed label needs explicit reconciliation',
      origin: openControlOrigin,
      profile,
      purposes: ['BILLING', 'DELIVERY'],
      reason: 'Retain the existing Add reconciliation guard',
    }),
  );
  assert.isOk(Result.isFailure(changedOpenLabel));
  const reconciliation = yield* Schema.decodeUnknownEffect(AddressBookDomainErrorSchema)(changedOpenLabel.failure);
  assert.isOk(Predicate.isTagged(reconciliation, 'SavedAddressReconciliationRequired'));
  expect(reconciliation.code).toBe('saved_address_reconciliation_required');
  expect(reconciliation.reason).toBe('An equivalent Saved Address requires explicit reconciliation');
  // Actual owner-produced negative sources: no invented finite DTOs.
  const email = yield* addContactPointWithAuthorization(
    {
      contactPoint: { preferred: false, type: 'EMAIL', value: 'postal-control@example.test' },
      partyRef: created.partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance,
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      verification: {
        method: 'MANUAL_CONFIRMATION',
        state: 'VERIFIED',
        verifiedAt: yield* DateTime.now,
        verifierReference: 'native-postal-source-verifier',
      },
    },
    yield* authorization(),
    yield* options,
  );
  const emailDetail = yield* client({ contactPointRef: email.contactPointRef }, randomUUID());
  const wrongType = yield* Effect.result(
    add({
      origin: { ...openOrigin, contactPointRef: email.contactPointRef, sourceRevision: emailDetail.revision },
      profile,
      purposes: ['BILLING'],
      reason: 'Reject non-postal owner source',
    }),
  );
  assert.isOk(Result.isFailure(wrongType));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(wrongType.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'The Party-backed address source is not a Current postal address',
  });
  const wrongParty = yield* Effect.result(
    add({
      origin: {
        ...openOrigin,
        partyRef: {
          ...created.partyRef,
          resourceId: randomUUID(),
        },
      },
      profile,
      purposes: ['BILLING'],
      reason: 'Reject mismatched Party owner',
    }),
  );
  assert.isOk(Result.isFailure(wrongParty));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(wrongParty.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'Party Registry returned a different postal Contact Point source',
  });
  const purposeOnly = yield* addContactPointWithAuthorization(
    {
      contactPoint: {
        address: { addressLine1: '2 Native Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
        purposes: [
          { preferred: false, purpose: 'BILLING' },
          { preferred: false, purpose: 'DELIVERY' },
        ],
        type: 'ADDRESS',
      },
      partyRef: created.partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance,
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      verification: {
        method: 'MANUAL_CONFIRMATION',
        state: 'VERIFIED',
        verifiedAt: yield* DateTime.now,
        verifierReference: 'native-postal-source-verifier',
      },
    },
    yield* authorization(),
    yield* options,
  );
  yield* endContactPointWithAuthorization(
    {
      contactPointRef: purposeOnly.contactPointRef,
      effectiveEnd: yield* DateTime.now,
      provenance,
      reason: 'End BILLING purpose only',
      target: { target: { purpose: 'BILLING' }, type: 'ADDRESS_PURPOSE' },
    },
    yield* authorization(),
    yield* options,
  );
  const deliveryOnly = yield* client({ contactPointRef: purposeOnly.contactPointRef }, randomUUID());
  expect(deliveryOnly.current).toBe(true);
  const deliveryOrigin = {
    ...openOrigin,
    contactPointRef: purposeOnly.contactPointRef,
    sourceRevision: deliveryOnly.revision,
  };
  expect(
    (yield* add({
      origin: deliveryOrigin,
      profile,
      purposes: ['DELIVERY'],
      reason: 'Remaining Current purpose is independent',
    })).outcome,
  ).toBe('ADDED');
  // Party labels are reusable owner defaults; CCC owns this contextual use purpose.
  // A purpose-only End does not end the address while another owner purpose is Current.
  const contextualBilling = yield* add({
    origin: deliveryOrigin,
    profile,
    purposes: ['BILLING'],
    reason: 'Commerce-specific use remains separate from Party default labels',
  });
  expect(['ADDED', 'REUSED']).toContain(contextualBilling.outcome);
  yield* endContactPointWithAuthorization(
    {
      contactPointRef: purposeOnly.contactPointRef,
      effectiveEnd: yield* DateTime.now,
      provenance,
      reason: 'End final owner address purpose',
      target: { target: { purpose: 'DELIVERY' }, type: 'ADDRESS_PURPOSE' },
    },
    yield* authorization(),
    yield* options,
  );
  const noCurrentPurpose = yield* client({ contactPointRef: purposeOnly.contactPointRef }, randomUUID());
  expect(noCurrentPurpose.current).toBe(false);
  const missingPurpose = yield* Effect.result(
    add({
      origin: { ...deliveryOrigin, sourceRevision: noCurrentPurpose.revision },
      profile,
      purposes: ['DELIVERY'],
      reason: 'No Current owner postal purpose remains',
    }),
  );
  assert.isOk(Result.isFailure(missingPurpose));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(missingPurpose.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'The Party-backed address source is not a Current postal address',
  });
  const incomplete = yield* addContactPointWithAuthorization(
    {
      contactPoint: {
        address: { addressLine1: 'Incomplete owner assertion', city: 'Prague', countryCode: 'CZ' },
        purposes: [{ preferred: false, purpose: 'BILLING' }],
        type: 'ADDRESS',
      },
      partyRef: created.partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance,
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      verification: {
        method: 'MANUAL_CONFIRMATION',
        state: 'VERIFIED',
        verifiedAt: yield* DateTime.now,
        verifierReference: 'native-postal-source-verifier',
      },
    },
    yield* authorization(),
    yield* options,
  );
  const incompleteDetail = yield* client({ contactPointRef: incomplete.contactPointRef }, randomUUID());
  const incompleteUse = yield* Effect.result(
    add({
      origin: {
        ...openOrigin,
        contactPointRef: incomplete.contactPointRef,
        sourceRevision: incompleteDetail.revision,
      },
      profile,
      purposes: ['BILLING'],
      reason: 'Missing postal fields',
    }),
  );
  assert.isOk(Result.isFailure(incompleteUse));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(incompleteUse.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'The Party-backed address source is not a Current postal address',
  });
  const endAt = DateTime.add(yield* DateTime.now, { seconds: 12 });
  const wholeEnd = yield* endContactPointWithAuthorization(
    {
      contactPointRef: address.contactPointRef,
      effectiveEnd: endAt,
      provenance,
      reason: 'Scheduled whole postal end',
      target: { type: 'WHOLE_CONTACT_POINT' },
    },
    yield* authorization(),
    yield* options,
  );
  assert.isOk(wholeEnd.end);
  expect(DateTime.toEpochMillis(wholeEnd.end.effectiveEnd)).toBe(DateTime.toEpochMillis(endAt));
  const finite = yield* client({ contactPointRef: address.contactPointRef }, randomUUID());
  expect(finite.current).toBe(true);
  expect(finite.state).toBe('ACTIVE');
  assert.isOk(finite.validTo);
  expect(DateTime.toEpochMillis(finite.validTo)).toBe(DateTime.toEpochMillis(endAt));
  assert.isOk(finite.end);
  expect(DateTime.toEpochMillis(finite.end.effectiveEnd)).toBe(DateTime.toEpochMillis(endAt));
  expect(finite.revision).toBeGreaterThan(original.revision);
  const origin = { ...openOrigin, sourceRevision: finite.revision };
  const saved = yield* add({
    origin,
    profile,
    purposes: ['BILLING', 'DELIVERY'],
    reason: 'Accept the owner Current finite source',
  });
  expect(saved.outcome).toBe('ADDED');
  expect(saved.address.origin).toEqual(origin);
  const updated = yield* update({
    expectedRevision: saved.address.revision,
    label: 'Finite source',
    origin,
    profile,
    reason: 'Explicit fresh Party origin',
    savedAddressRef: saved.address.savedAddressRef,
  });
  expect(updated.address.origin).toEqual(origin);
  const retained = yield* fixture
    .prepareOwner(
      (transaction, scope) =>
        addressReadServicesForTransaction(transaction, scope).detail(
          { profile, savedAddressRef: updated.address.savedAddressRef },
          fixture.tenantId,
        ),
      'required',
    )
    .pipe(Effect.provideContext(context));
  expect(retained.address.origin).toEqual(origin);
  const stale = yield* Effect.result(
    add({ origin: openOrigin, profile, purposes: ['BILLING'], reason: 'Stale pre-End revision' }),
  );
  assert.isOk(Result.isFailure(stale));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(stale.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'The Party-backed address source revision is stale',
  });
  const commerceOnly = yield* add({
    origin: {
      kind: 'COMMERCE_ONLY',
      postalAddress: { addressLine1: 'Independent address', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
    },
    profile,
    purposes: ['BILLING'],
    reason: 'Commerce-only control',
  });
  expect(commerceOnly.outcome).toBe('ADDED');
  // Wait for actual time; this never backdates a client clock or changes owner Current.
  while (true) {
    const remaining = DateTime.toEpochMillis(endAt) - DateTime.toEpochMillis(yield* DateTime.now);
    if (remaining <= 0) {
      break;
    }
    yield* Effect.sleep(remaining);
  }
  expect(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(endAt)).toBeGreaterThanOrEqual(0);
  const ended = yield* client({ contactPointRef: address.contactPointRef }, randomUUID());
  expect(DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(endAt)).toBeGreaterThanOrEqual(0);
  assert.isOk(ended.validTo);
  expect(DateTime.toEpochMillis(ended.validTo)).toBe(DateTime.toEpochMillis(endAt));
  assert.isOk(ended.end);
  expect(DateTime.toEpochMillis(ended.end.effectiveEnd)).toBe(DateTime.toEpochMillis(endAt));
  expect(ended.revision).toBe(finite.revision);
  expect(ended.current).toBe(false);
  const after = yield* Effect.result(
    add({
      origin: { ...origin, sourceRevision: ended.revision },
      profile,
      purposes: ['BILLING'],
      reason: 'After exclusive whole End',
    }),
  );
  assert.isOk(Result.isFailure(after));
  expect(yield* Schema.decodeUnknownEffect(SavedAddressInvalidSchema)(after.failure)).toMatchObject({
    code: 'saved_address_invalid',
    reason: 'The Party-backed address source is not a Current postal address',
  });
  expect(yield* partyBackedPostalAddressResolver('ended-source', client)(updated.address)).toEqual({
    kind: 'NOT_FOUND',
  });
  const labelOnly = yield* update({
    expectedRevision: updated.address.revision,
    label: 'Retained metadata after source End',
    profile,
    reason: 'Label-only control',
    savedAddressRef: updated.address.savedAddressRef,
  });
  expect(labelOnly.outcome).toBe('UPDATED');
  // Bypass the caller-side encoder only to submit invalid raw input to actual Core decoding.
  const foreign = yield* Effect.result(
    runtime
      .runAction({
        payload: {
          origin: { ...origin, contactPointRef: { ...origin.contactPointRef, tenantId: randomUUID() } },
          profile,
          purposes: ['BILLING'],
          reason: 'Foreign Tenant must not cross source boundary',
        },
        principal,
        registration: addSavedAddressAction,
        transport: {
          correlationId: randomUUID(),
          idempotencyKey: randomUUID(),
          targetModuleKey: 'commerce.customer-context',
        },
      })
      .pipe(Effect.provideContext(Context.add(context, PartyAddressSourceExecutor, client))),
  );
  assert.isOk(Result.isFailure(foreign));
  const invalidScope = yield* Schema.decodeUnknownEffect(ActionPayloadValidationError)(foreign.failure);
  expect(invalidScope.code).toBe('action_payload_invalid');
  expect(invalidScope.reason).toBe('The Action payload does not match its declared schema');
  yield* child.kill();
  const unavailable = yield* Effect.result(
    add({ origin, profile, purposes: ['BILLING'], reason: 'Owner unavailable is not absence' }),
  );
  assert.isOk(Result.isFailure(unavailable));
  const dependencyFailure = yield* Schema.decodeUnknownEffect(AddressBookUnavailable)(unavailable.failure);
  expect(dependencyFailure.code).toBe('address_book_unavailable');
  expect(dependencyFailure.dependency).toBe('party-registry');
  expect(dependencyFailure.retryable).toBe(true);
  const independent = yield* add({
    origin: commerceOnly.address.origin,
    profile,
    purposes: ['BILLING'],
    reason: 'Commerce-only does not depend on unavailable Party',
  });
  expect(independent.address.savedAddressRef).toEqual(commerceOnly.address.savedAddressRef);
  // The saved relation survives; Party remains authoritative for new Current use.
  expect(labelOnly.address.origin).toEqual(origin);
  const evidence = yield* fixture.evidence(coreEvidenceExecutor);
  expect(evidence.invocations.some(({ status }) => status === 'succeeded')).toBe(true);
});

it.layer(postalFixtureLayer, { excludeTestServices: true, timeout: 30_000 })((testIt) => {
  testIt.effect(
    'real Party whole future End remains usable through registered native CCC Add and Update until its exclusive end',
    postalFutureEnd,
  );
});
