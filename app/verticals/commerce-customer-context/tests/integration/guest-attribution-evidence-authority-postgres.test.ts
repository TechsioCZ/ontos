import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ActionRuntime,
  loadDatabaseConnectionPair,
  loadDatabaseConfig,
  PARTY_REGISTRY_REQUEST_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  ActiveApplicationCompositionSnapshotSchema,
  ContextAccessLive,
  OntosModuleDeploymentContractSchema,
  canonicalizeApplicationComposition,
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
  executeGuestPartyResolutionWithAuthorization,
  resolveDuplicateCandidateCreateWithAuthorization,
  resolveDuplicateCandidateMatchWithAuthorization,
  endContactPointWithAuthorization,
  archivePartyWithAuthorization,
  executePartyDetailWithAuthorization,
  executeDuplicateCandidateDetailWithAuthorization,
  executePartyMatchDecisionWithAuthorization,
} from '@app/party-registry/api/client';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import {
  Brand,
  Config,
  Context,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Fiber,
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
import { Reactivity } from 'effect/reactivity';
import { assert, expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import { AttributeGuestRetailCustomerRejected } from '../../shared/actions/attribute-guest-retail-customer.ts';
import { attributeGuestRetailCustomerAction } from '../../src/actions/attribute-guest-retail-customer.action.ts';
import {
  commerceCustomerContextRelations,
  customerProfiles,
  retailPortalProfileBindings,
} from '../../src/database/schema.ts';
import {
  makePartyRegistryGuestResolver,
  PartyRegistryGuestResolverFactory,
} from '../../src/integrations/party-registry-guest-resolver.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import { profileCounterpartyRoleEligibilityResolverFactoryLive } from '../../src/profile-counterparty-role-eligibility.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
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

const makeGuestAuthorityFixture = Effect.fn('GuestEvidenceTest.makeGuestAuthorityFixture')(
  function* makeGuestAuthorityFixture() {
    // An executable owner fixture is process infrastructure, never a private cross-owner import.
    const artifact = `${appRoot}verticals/party-registry/node_modules/.cache/ontos-1241/${randomUUID()}.mjs`;
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
      purpose: 'stabilization-1241-guest-evidence',
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
      assert.isOk(exactSourceAndOwnedTarget, 'GUEST_IDENTITY_TARGET_REFUSED');
      // Preserve the canonical login and credential; retarget only this creator-owned database.
      address.pathname = `/${identity.databaseName}`;
      identityUrls[databaseIdentity.urlKey] = address.href;
    }
    const issuerUrl = identityUrls.SHELL_GATEWAY_ISSUER_DATABASE_URL;
    const requestUrl = identityUrls.PARTY_REGISTRY_DATABASE_URL;
    assert.isOk(issuerUrl !== undefined && requestUrl !== undefined, 'GUEST_IDENTITIES_INCOMPLETE');
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
      [
        ownerVerification.exitCode,
        Stream.runDrain(ownerVerification.stdout),
        Stream.runDrain(ownerVerification.stderr),
      ],
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
          'party.registry.resolve-duplicate-candidate-create',
          'party.registry.resolve-duplicate-candidate-match',
          'party.registry.end-contact-point',
          'party.registry.archive-party',
          attributeGuestRetailCustomerAction.descriptor.actionKey,
        ],
        additionalLegalEntity: 'same-tenant',
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
    const issuer = 'https://disposable-guest-authority.ontos.test';
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
    const authorization = Effect.fn('GuestAuthorityTest.authorization')(function* authorization(actor = principal) {
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
    const legalEntityRef = {
      moduleId: 'core.identity' as const,
      resourceId: fixture.legalEntityId,
      resourceType: 'core.identity.legal-entity' as const,
      tenantId: fixture.tenantId,
    };
    const client = bootstrapAdmin;
    const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
      Effect.provideService(PgClient.PgClient, client),
    );
    const profiles = (actor = principal) =>
      admin
        .select()
        .from(customerProfiles)
        .where(
          and(eq(customerProfiles.tenantId, actor.tenantId), eq(customerProfiles.legalEntityId, actor.legalEntityId)),
        )
        .orderBy(customerProfiles.customerProfileId);
    const bindings = (actor = principal) =>
      admin
        .select()
        .from(retailPortalProfileBindings)
        .where(
          and(
            eq(retailPortalProfileBindings.tenantId, actor.tenantId),
            eq(retailPortalProfileBindings.legalEntityId, actor.legalEntityId),
          ),
        )
        .orderBy(retailPortalProfileBindings.retailPortalProfileBindingId);
    const secondary = fixture.secondaryLegalEntity;
    assert.isOk(secondary !== undefined);
    const actors = new Map<string, typeof principal>([
      [`${principal.tenantId}:${principal.legalEntityId}`, principal],
      [`${secondary.manager.tenantId}:${secondary.legalEntityId}`, secondary.manager],
    ]);
    const anotherTenant = Effect.fn('GuestAuthorityTest.anotherTenant')(function* anotherTenant() {
      const other = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionExecutor: 'manager-only',
          actionKeys: [
            'party.registry.create-party',
            'party.registry.add-contact-point',
            attributeGuestRetailCustomerAction.descriptor.actionKey,
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
      const actor = { ...other.manager, legalEntityId: other.legalEntityId };
      actors.set(`${actor.tenantId}:${actor.legalEntityId}`, actor);
      return { actor, fixture: other };
    });
    const authorizationContext = yield* Effect.context<Crypto.Crypto>();
    const guestFactory = Layer.succeed(PartyRegistryGuestResolverFactory, {
      make: (scope) =>
        makePartyRegistryGuestResolver(scope, (request, correlation) =>
          Effect.gen(function* actualPartyGuestRead() {
            const actor = actors.get(`${scope.tenantId}:${scope.legalEntityId}`);
            assert.isOk(actor !== undefined);
            return yield* executeGuestPartyResolutionWithAuthorization(
              request,
              yield* authorization(actor).pipe(Effect.provideContext(authorizationContext), Effect.orDie),
              correlation,
              {
                baseUrl,
                compositionRevision: snapshot.composition.revision,
              },
            );
          }),
        ),
    });
    const owners = Layer.mergeAll(
      guestFactory,
      profileCounterpartyRoleEligibilityResolverFactoryLive,
      partyRegistryRetailPartyResolverFactoryLive,
      profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive)),
      profileReactivationEligibilityEvaluatorFactoryLive.pipe(
        Layer.provide(profileReconfirmationPolicyUnavailableLive),
      ),
    );
    const ownerContext = yield* Layer.build(fixture.layer.pipe(Layer.provideMerge(owners)));
    const runtime = yield* ActionRuntime.pipe(Effect.provideContext(ownerContext));
    const attribute = (
      root: string,
      evidence: string,
      idempotencyKey: string,
      requestedAt: string,
      actor = principal,
      seller?: typeof legalEntityRef,
    ) =>
      Effect.gen(function* attributeGuest() {
        return yield* runtime
          .runAction({
            payload: {
              correlationRoot: root,
              guestEvidenceRef: evidence,
              requestedAt,
              sellingLegalEntityRef: seller ?? {
                ...legalEntityRef,
                resourceId: actor.legalEntityId,
                tenantId: actor.tenantId,
              },
            },
            principal: actor,
            registration: attributeGuestRetailCustomerAction,
            transport: { correlationId: yield* nextId, idempotencyKey, targetModuleKey: 'commerce.customer-context' },
          })
          .pipe(Effect.provideContext(ownerContext));
      });
    const attributions = Effect.fn('GuestAuthorityTest.attributionRows')(function* attributionRows(
      root: string,
      actor = principal,
    ) {
      const [row] = yield* admin.execute<{ rows: string }>(
        sql`
        select coalesce(jsonb_agg(to_jsonb(attribution) order by guest_retail_attribution_id), '[]')::text as rows
        from commerce_customer_context.guest_retail_attributions attribution
        where tenant_id = ${actor.tenantId} and legal_entity_id = ${actor.legalEntityId} and correlation_root = ${root}
      `,
        'objects',
      );
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(row?.rows);
    });
    const permissions = Effect.fn('GuestAuthorityTest.permissionCounts')(function* permissionCounts(actor = principal) {
      const [row] = yield* admin.execute<{ grantCount: number; mutationCount: number }>(
        sql`
        select (select count(*)::integer from commerce_customer_context.counterparty_commerce_access_grants
          where tenant_id = ${actor.tenantId} and legal_entity_id = ${actor.legalEntityId}) as "grantCount",
          (select count(*)::integer from commerce_customer_context.retail_portal_profile_binding_permission_mutations
          where tenant_id = ${actor.tenantId} and legal_entity_id = ${actor.legalEntityId}) as "mutationCount"
      `,
        'objects',
      );
      const counts = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ grantCount: Schema.Int, mutationCount: Schema.Int }),
      )(row);
      expect(counts).toEqual({ grantCount: 0, mutationCount: 0 });
      return counts;
    });
    const resolve = (
      root: string,
      evidence: string,
      at: DateTime.Utc,
      actor = principal,
      seller?: typeof legalEntityRef,
    ) =>
      Effect.gen(function* resolveGuestAtOwner() {
        return yield* executeGuestPartyResolutionWithAuthorization(
          {
            correlationRoot: root,
            guestEvidenceRef: evidence,
            legalEntityRef: seller ?? { ...legalEntityRef, resourceId: actor.legalEntityId, tenantId: actor.tenantId },
            requestedAt: at,
          },
          yield* authorization(actor),
          yield* nextId,
          { baseUrl, compositionRevision: snapshot.composition.revision },
        );
      });
    const createOrganization = Effect.fn('GuestAuthorityTest.createOrganization')(function* createOrganization(
      root: string,
      evidence: string,
      ico: string,
      binding: 'BOUND' | 'UNBOUND' = 'BOUND',
      actor = principal,
    ) {
      const subjectKey = Brand.nominal<
        NonNullable<
          Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
        >[number]['subjectKey']
      >()(yield* nextId);
      const observation: NonNullable<
        Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
      >[number] = {
        basis: 'REVIEWED_DOCUMENT',
        evidenceRef: evidence,
        kind: 'ACTOR_ATTESTATION',
        observedSubject: 'ORGANIZATION',
        statement: 'Reviewed this concrete external organization',
        subjectKey,
      };
      const subjectEvidence =
        binding === 'UNBOUND'
          ? observation
          : {
              ...observation,
              guestBinding: {
                correlationRoot: root,
                legalEntityRef: { ...legalEntityRef, resourceId: actor.legalEntityId, tenantId: actor.tenantId },
              },
            };
      const created = yield* createPartyWithAuthorization(
        {
          candidate: {
            displayName: `Guest organization ${ico}`,
            evidenceRefs: [evidence],
            officialIdentifiers: [{ identifierType: 'ICO', value: ico, verification: 'VERIFIED' }],
            partyType: 'ORGANIZATION',
            provenance: { method: 'REVIEWED_DOCUMENT', source: 'guest-authority-native' },
            subjectEvidence: [subjectEvidence],
            validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
          },
        },
        yield* authorization(actor),
        yield* options,
      );
      assert.isOk(created.outcome === 'CREATED' || created.outcome === 'MATCHED_EXISTING');
      return created.partyRef;
    });
    const addWeakContact = Effect.fn('GuestAuthorityTest.addWeakContact')(function* addWeakContact(
      partyRef: Parameters<typeof addContactPointWithAuthorization>[0]['partyRef'],
      evidence: string,
      verifiedAt?: DateTime.Utc,
    ) {
      let verification: Parameters<typeof addContactPointWithAuthorization>[0]['verification'] = {
        state: 'UNVERIFIED',
      };
      if (verifiedAt !== undefined) {
        verification = {
          method: 'MANUAL_CONFIRMATION',
          state: 'VERIFIED',
          verifiedAt,
          verifierReference: 'channel-only',
        };
      }
      return yield* addContactPointWithAuthorization(
        {
          contactPoint: { preferred: false, type: 'EMAIL', value: `${yield* nextId}@guest.test` },
          partyRef,
          privacyClassification: 'PERSONAL',
          provenance: {
            authoritative: verifiedAt !== undefined,
            evidenceReference: evidence,
            method: 'MANUAL_CONFIRMATION',
            source: 'USER_ASSERTION',
          },
          validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
          verification,
        },
        yield* authorization(),
        yield* options,
      );
    });
    return {
      addWeakContact,
      anotherTenant,
      attribute,
      attributions,
      authorization,
      baseUrl,
      bindings,
      child,
      coreEvidenceExecutor,
      createOrganization,
      fixture,
      legalEntityRef,
      options,
      permissions,
      principal,
      profiles,
      resolve,
      secondary,
      snapshot,
    };
  },
);

// Each unnamed single-case layer below owns fresh infrastructure and its cleanup.
// No business producer or business timestamp runs until the case consumes the fixture.
const GuestAuthorityFixture =
  Context.Service<Effect.Success<ReturnType<typeof makeGuestAuthorityFixture>>>('GuestEvidenceTest.fixture');
const guestAuthorityFixtureLayer = Layer.effect(GuestAuthorityFixture, makeGuestAuthorityFixture()).pipe(
  Layer.provideMerge(services),
);

const publicGuestAttributionAuthority = Effect.fn('GuestEvidenceTest.publicGuestAttributionAuthority')(
  function* publicGuestAttributionAuthority() {
    const test = yield* GuestAuthorityFixture;
    const {
      attribute,
      authorization,
      baseUrl,
      bindings,
      coreEvidenceExecutor,
      fixture,
      legalEntityRef,
      options,
      profiles,
      snapshot,
    } = test;
    const evidenceRef = `guest-${yield* nextId}`;
    const correlationRoot = `purchase-${yield* nextId}`;
    const subjectKey = Brand.nominal<
      NonNullable<
        Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
      >[number]['subjectKey']
    >()(yield* nextId);
    const candidate = {
      displayName: 'Evidence-bound external organization',
      evidenceRefs: ['original-owner-proof'],
      officialIdentifiers: [{ identifierType: 'ICO' as const, value: '27074358', verification: 'VERIFIED' as const }],
      partyType: 'ORGANIZATION' as const,
      provenance: { method: 'REVIEWED_DOCUMENT', source: 'guest-authority-native' },
      subjectEvidence: [
        {
          basis: 'REVIEWED_DOCUMENT' as const,
          evidenceRef: 'original-owner-proof',
          kind: 'ACTOR_ATTESTATION' as const,
          observedSubject: 'ORGANIZATION' as const,
          statement: 'Reviewed the concrete external organization',
          subjectKey,
        },
      ],
      validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
    };
    const created = yield* createPartyWithAuthorization({ candidate }, yield* authorization(), yield* options);
    assert.isOk(created.outcome === 'CREATED');
    yield* addContactPointWithAuthorization(
      {
        contactPoint: { preferred: false, type: 'EMAIL', value: 'guest-authority@example.test' },
        partyRef: created.partyRef,
        privacyClassification: 'PERSONAL',
        provenance: {
          authoritative: false,
          evidenceReference: evidenceRef,
          method: 'MANUAL_CONFIRMATION',
          source: 'USER_ASSERTION',
        },
        validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
        verification: { state: 'UNVERIFIED' },
      },
      yield* authorization(),
      yield* options,
    );
    const initialProfiles = yield* profiles();
    const initialBindings = yield* bindings();
    expect(
      yield* attribute(correlationRoot, evidenceRef, yield* nextId, DateTime.formatIso(yield* DateTime.now)),
    ).toEqual({ outcome: 'PARTY_INVALID' });
    expect(yield* profiles()).toEqual(initialProfiles);
    expect(yield* bindings()).toEqual(initialBindings);
    // A new original accepted owner decision explicitly binds this different purchase correlation.
    const provenRoot = `purchase-${yield* nextId}`;
    const boundCandidate = {
      ...candidate,
      evidenceRefs: [evidenceRef],
      subjectEvidence: candidate.subjectEvidence.map((item) => ({
        ...item,
        evidenceRef,
        guestBinding: { correlationRoot: provenRoot, legalEntityRef },
      })),
    };
    const proven = yield* createPartyWithAuthorization(
      { candidate: boundCandidate },
      yield* authorization(),
      yield* options,
    );
    expect(proven).toMatchObject({ outcome: 'MATCHED_EXISTING', partyRef: created.partyRef });
    const idempotencyKey = yield* nextId;
    const requestedAt = DateTime.formatIso(yield* DateTime.now);
    const attributed = yield* attribute(provenRoot, evidenceRef, idempotencyKey, requestedAt);
    expect(attributed).toMatchObject({ outcome: 'ATTRIBUTED', partyRef: created.partyRef });
    expect(yield* profiles()).toHaveLength(initialProfiles.length + 1);
    expect(yield* bindings()).toEqual(initialBindings);
    const afterCommit = yield* fixture.evidence(coreEvidenceExecutor);
    expect(
      afterCommit.events.filter(
        ({ eventType }) => eventType === 'commerce.customer-context.guest-retail-customer-attributed.v1',
      ),
    ).toHaveLength(1);
    // Core exact replay requires identical intent, including requestedAt; native correlation retry
    // under a fresh invocation must reuse the same profile, never grant Portal access.
    const exactReplay = yield* attribute(provenRoot, evidenceRef, idempotencyKey, requestedAt).pipe(Effect.flip);
    expect(Predicate.isTagged(exactReplay, 'ActionAlreadyCommitted')).toBe(true);
    expect((yield* fixture.evidence(coreEvidenceExecutor)).events).toEqual(afterCommit.events);
    const retry = yield* attribute(provenRoot, evidenceRef, yield* nextId, requestedAt);
    expect(retry).toEqual(attributed);
    expect(yield* profiles()).toHaveLength(initialProfiles.length + 1);
    expect(yield* bindings()).toEqual(initialBindings);
    expect((yield* attribute(`wrong-${provenRoot}`, evidenceRef, yield* nextId, requestedAt)).outcome).toBe(
      'PARTY_INVALID',
    );
    const denied = yield* executeGuestPartyResolutionWithAuthorization(
      {
        correlationRoot: provenRoot,
        guestEvidenceRef: evidenceRef,
        legalEntityRef,
        requestedAt: yield* DateTime.now,
      },
      yield* authorization({ ...fixture.legalEntityOnly, legalEntityId: fixture.legalEntityId }),
      yield* nextId,
      { baseUrl, compositionRevision: snapshot.composition.revision },
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(denied, 'GuestPartyResolutionForbiddenProblem')).toBe(true);
    expect(yield* profiles()).toHaveLength(initialProfiles.length + 1);
    const secondKey = Brand.nominal<
      NonNullable<
        Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
      >[number]['subjectKey']
    >()(yield* nextId);
    const competing = yield* createPartyWithAuthorization(
      {
        candidate: {
          ...candidate,
          displayName: 'Different external organization',
          officialIdentifiers: [{ identifierType: 'ICO', value: '26168685', verification: 'VERIFIED' }],
          subjectEvidence: candidate.subjectEvidence.map((item) => ({ ...item, subjectKey: secondKey })),
        },
      },
      yield* authorization(),
      yield* options,
    );
    assert.isOk(competing.outcome === 'CREATED');
    yield* addContactPointWithAuthorization(
      {
        contactPoint: { preferred: false, type: 'EMAIL', value: 'shared-guest@example.test' },
        partyRef: competing.partyRef,
        privacyClassification: 'PERSONAL',
        provenance: {
          authoritative: false,
          evidenceReference: evidenceRef,
          method: 'MANUAL_CONFIRMATION',
          source: 'USER_ASSERTION',
        },
        validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
        verification: { state: 'UNVERIFIED' },
      },
      yield* authorization(),
      yield* options,
    );
    const ambiguous = yield* executeGuestPartyResolutionWithAuthorization(
      { correlationRoot: provenRoot, guestEvidenceRef: evidenceRef, legalEntityRef, requestedAt: yield* DateTime.now },
      yield* authorization(),
      yield* nextId,
      { baseUrl, compositionRevision: snapshot.composition.revision },
    );
    expect(ambiguous.outcome).toBe('PARTY_OWNER_INDETERMINATE');
    const failedAttribution = yield* attribute(
      provenRoot,
      evidenceRef,
      yield* nextId,
      DateTime.formatIso(yield* DateTime.now),
    ).pipe(Effect.flip);
    assert.isOk(Schema.is(AttributeGuestRetailCustomerRejected)(failedAttribution));
    expect(failedAttribution.code).toBe('PARTY_REGISTRY_UNAVAILABLE');
    expect(yield* profiles()).toHaveLength(initialProfiles.length + 1);
    expect(yield* bindings()).toEqual(initialBindings);
    yield* test.permissions();
  },
);

const publicWeakContactEnd = Effect.fn('GuestEvidenceTest.publicWeakContactEnd')(function* publicWeakContactEnd() {
  const test = yield* GuestAuthorityFixture;
  const root = `weak-${yield* nextId}`;
  const evidence = `weak-${yield* nextId}`;
  const party = yield* test.createOrganization(root, `unbound-${yield* nextId}`, '27074358', 'UNBOUND');
  const contact = yield* test.addWeakContact(party, evidence);
  const initialProfiles = yield* test.profiles();
  const initialBindings = yield* test.bindings();
  const permissions = yield* test.permissions();
  expect((yield* test.resolve(`missing-${root}`, `missing-${evidence}`, yield* DateTime.now)).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  expect(
    yield* test.attribute(
      `missing-${root}`,
      `missing-${evidence}`,
      yield* nextId,
      DateTime.formatIso(yield* DateTime.now),
    ),
  ).toEqual({ outcome: 'PARTY_INVALID' });
  const beforeEnd = yield* DateTime.now;
  expect((yield* test.resolve(root, evidence, beforeEnd)).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
  yield* test.addWeakContact(party, `verified-${evidence}`, yield* DateTime.now);
  expect((yield* test.resolve(`verified-${root}`, `verified-${evidence}`, yield* DateTime.now)).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  expect(
    yield* test.attribute(
      `verified-${root}`,
      `verified-${evidence}`,
      yield* nextId,
      DateTime.formatIso(yield* DateTime.now),
    ),
  ).toEqual({ outcome: 'PARTY_INVALID' });
  const end = yield* DateTime.now;
  expect(DateTime.toEpochMillis(end)).toBeGreaterThanOrEqual(DateTime.toEpochMillis(beforeEnd));
  const ended = yield* endContactPointWithAuthorization(
    {
      contactPointRef: contact.contactPointRef,
      effectiveEnd: end,
      provenance: {
        authoritative: false,
        evidenceReference: evidence,
        method: 'MANUAL_CONFIRMATION',
        source: 'USER_ASSERTION',
      },
      reason: 'End weak contact only',
      target: { type: 'WHOLE_CONTACT_POINT' },
    },
    yield* test.authorization(),
    yield* test.options,
  );
  expect(ended.validTo).toEqual(end);
  for (const at of [DateTime.subtract(end, { milliseconds: 1 }), end, DateTime.add(end, { milliseconds: 1 })]) {
    expect((yield* test.resolve(root, evidence, at)).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
    expect(yield* test.attribute(root, evidence, yield* nextId, DateTime.formatIso(at))).toEqual({
      outcome: 'PARTY_INVALID',
    });
  }
  expect(yield* test.attributions(root)).toHaveLength(1);
  expect(yield* test.attributions(root)).toMatchObject([{ outcome: 'PARTY_INVALID' }]);
  expect(yield* test.profiles()).toEqual(initialProfiles);
  expect(yield* test.bindings()).toEqual(initialBindings);
  expect(yield* test.permissions()).toEqual(permissions);
  expect(
    (yield* test.fixture.evidence(test.coreEvidenceExecutor)).events.filter(
      ({ eventType }) => eventType === 'commerce.customer-context.guest-retail-customer-attributed.v1',
    ),
  ).toEqual([]);
});

const publicReviewedGuest = Effect.fn('GuestEvidenceTest.publicReviewedGuest')(function* publicReviewedGuest() {
  const test = yield* GuestAuthorityFixture;
  const root = `review-${yield* nextId}`;
  const evidence = `review-${yield* nextId}`;
  const subjectKey = Brand.nominal<
    NonNullable<
      Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
    >[number]['subjectKey']
  >()(yield* nextId);
  const originalEvidence = `original-person-${yield* nextId}`;
  const candidate = {
    displayName: 'Reviewed concrete Guest person',
    evidenceRefs: [originalEvidence],
    officialIdentifiers: [],
    partyType: 'PERSON' as const,
    provenance: { method: 'DIRECT_INTERACTION', source: 'guest-review-native' },
    subjectEvidence: [
      {
        basis: 'DIRECT_INTERACTION' as const,
        evidenceRef: originalEvidence,
        kind: 'ACTOR_ATTESTATION' as const,
        observedSubject: 'PERSON' as const,
        statement: 'Met this concrete person',
        subjectKey,
      },
    ],
    validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
  };
  const openedSeed = yield* createPartyWithAuthorization(
    { candidate },
    yield* test.authorization(),
    yield* test.options,
  );
  assert.isOk(openedSeed.outcome === 'AMBIGUOUS');
  const seed = yield* resolveDuplicateCandidateCreateWithAuthorization(
    { caseRef: openedSeed.caseRef, expectedRevision: 1, reason: 'Reviewed concrete person without strong identifier' },
    yield* test.authorization(),
    yield* test.options,
  );
  assert.isOk(seed.partyRef !== null);
  yield* test.addWeakContact(seed.partyRef, evidence);
  const bound = {
    ...candidate,
    evidenceRefs: [evidence],
    subjectEvidence: candidate.subjectEvidence.map((item) => ({
      ...item,
      evidenceRef: evidence,
      guestBinding: { correlationRoot: root, legalEntityRef: test.legalEntityRef },
    })),
  };
  const opened = yield* createPartyWithAuthorization(
    { candidate: bound },
    yield* test.authorization(),
    yield* test.options,
  );
  assert.isOk(opened.outcome === 'AMBIGUOUS');
  expect((yield* test.resolve(root, evidence, yield* DateTime.now)).outcome).toBe('AMBIGUOUS_MATCH');
  const reviewed = yield* resolveDuplicateCandidateMatchWithAuthorization(
    {
      caseRef: opened.caseRef,
      expectedRevision: 1,
      reason: 'Reviewed exact bound Guest evidence to actual canonical person',
      selectedPartyRef: seed.partyRef,
    },
    yield* test.authorization(),
    yield* test.options,
  );
  expect(reviewed.partyRef).toEqual(seed.partyRef);
  assert.isOk(reviewed.decisionRef !== null);
  const detail = yield* executeDuplicateCandidateDetailWithAuthorization(
    { caseRef: opened.caseRef },
    yield* test.authorization(),
    yield* nextId,
    { baseUrl: test.baseUrl, compositionRevision: test.snapshot.composition.revision },
  );
  expect(detail).toMatchObject({
    lifecycleState: 'RESOLVED',
    matchRuleVersion: 'party-exact-claims.v1',
    resolutionOutcome: 'MATCH_EXISTING',
  });
  const decision = yield* executePartyMatchDecisionWithAuthorization(
    { decisionRef: reviewed.decisionRef },
    yield* test.authorization(),
    yield* nextId,
    { baseUrl: test.baseUrl, compositionRevision: test.snapshot.composition.revision },
  );
  expect(decision).toMatchObject({
    evidenceEvaluation: { evidence: bound.subjectEvidence },
    matchRuleVersion: 'party-exact-claims.v1',
    operation: 'REVIEW_MATCH',
    partyRef: seed.partyRef,
  });
  expect(yield* test.resolve(root, evidence, yield* DateTime.now)).toEqual({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: seed.partyRef,
  });
  const attributed = yield* test.attribute(root, evidence, yield* nextId, DateTime.formatIso(yield* DateTime.now));
  expect(attributed).toMatchObject({ outcome: 'ATTRIBUTED', partyRef: seed.partyRef });
  expect(yield* test.attributions(root)).toHaveLength(1);
  expect(yield* test.bindings()).toEqual([]);
  yield* test.permissions();
});

const publicScopeAndArchive = Effect.fn('GuestEvidenceTest.publicScopeAndArchive')(function* publicScopeAndArchive() {
  const test = yield* GuestAuthorityFixture;
  const root = `scope-${yield* nextId}`;
  const evidence = `scope-${yield* nextId}`;
  const party = yield* test.createOrganization(root, evidence, '27074358');
  expect(yield* test.resolve(root, evidence, yield* DateTime.now)).toEqual({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: party,
  });
  const otherSeller = test.secondary.manager;
  expect((yield* test.resolve(root, evidence, yield* DateTime.now, otherSeller)).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  expect(
    yield* test.attribute(root, evidence, yield* nextId, DateTime.formatIso(yield* DateTime.now), otherSeller),
  ).toEqual({ outcome: 'PARTY_INVALID' });
  expect(yield* test.profiles(otherSeller)).toEqual([]);
  const mismatchedSeller = yield* test
    .resolve(root, evidence, yield* DateTime.now, otherSeller, test.legalEntityRef)
    .pipe(Effect.flip);
  expect(Predicate.isTagged(mismatchedSeller, 'GuestPartyResolutionNotFoundProblem')).toBe(true);
  const mismatchedAttribution = yield* test
    .attribute(
      `mismatch-${root}`,
      evidence,
      yield* nextId,
      DateTime.formatIso(yield* DateTime.now),
      otherSeller,
      test.legalEntityRef,
    )
    .pipe(Effect.flip);
  expect(Schema.is(AttributeGuestRetailCustomerRejected)(mismatchedAttribution)).toBe(true);
  expect(mismatchedAttribution).toMatchObject({ code: 'CURRENT_STATE_CONFLICT', retryable: false });
  const other = yield* test.anotherTenant();
  expect((yield* test.resolve(root, evidence, yield* DateTime.now, other.actor)).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  const foreignPayload = yield* test
    .resolve(root, evidence, yield* DateTime.now, other.actor, test.legalEntityRef)
    .pipe(Effect.flip);
  expect(Predicate.isTagged(foreignPayload, 'GuestPartyResolutionNotFoundProblem')).toBe(true);
  expect(
    yield* test.attribute(root, evidence, yield* nextId, DateTime.formatIso(yield* DateTime.now), other.actor),
  ).toEqual({ outcome: 'PARTY_INVALID' });
  const otherParty = yield* test.createOrganization(root, evidence, '27074358', 'BOUND', other.actor);
  expect(otherParty.tenantId).not.toBe(party.tenantId);
  expect(yield* test.resolve(root, evidence, yield* DateTime.now, other.actor)).toEqual({
    outcome: 'EXISTING_PARTY_RESOLVED',
    partyRef: otherParty,
  });
  expect(yield* test.profiles(other.actor)).toEqual([]);
  const caseEvidence = `foreign-case-${yield* nextId}`;
  const caseRoot = `foreign-case-root-${yield* nextId}`;
  const caseSubject = Brand.nominal<
    NonNullable<
      Parameters<typeof createPartyWithAuthorization>[0]['candidate']['subjectEvidence']
    >[number]['subjectKey']
  >()(yield* nextId);
  const foreignCase = yield* createPartyWithAuthorization(
    {
      candidate: {
        displayName: 'Foreign retained Guest candidate',
        evidenceRefs: [caseEvidence],
        officialIdentifiers: [],
        partyType: 'PERSON',
        provenance: { method: 'DIRECT_INTERACTION', source: 'guest-scope-native' },
        subjectEvidence: [
          {
            basis: 'DIRECT_INTERACTION',
            evidenceRef: caseEvidence,
            guestBinding: { correlationRoot: caseRoot, legalEntityRef: test.legalEntityRef },
            kind: 'ACTOR_ATTESTATION',
            observedSubject: 'PERSON',
            statement: 'Observed this concrete foreign candidate',
            subjectKey: caseSubject,
          },
        ],
        validFrom: DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'),
      },
    },
    yield* test.authorization(),
    yield* test.options,
  );
  assert.isOk(foreignCase.outcome === 'AMBIGUOUS');
  expect((yield* test.resolve(caseRoot, caseEvidence, yield* DateTime.now)).outcome).toBe('AMBIGUOUS_MATCH');
  expect(
    yield* test.attribute(caseRoot, caseEvidence, yield* nextId, DateTime.formatIso(yield* DateTime.now)),
  ).toMatchObject({ outcome: 'PARTY_AMBIGUOUS' });
  expect(yield* test.attributions(caseRoot)).toMatchObject([{ outcome: 'PARTY_AMBIGUOUS' }]);
  expect((yield* test.resolve(caseRoot, caseEvidence, yield* DateTime.now, other.actor)).outcome).toBe(
    'INVALID_OR_INSUFFICIENT_EVIDENCE',
  );
  const details = yield* executePartyDetailWithAuthorization(
    { partyRef: party },
    yield* test.authorization(),
    yield* nextId,
    { baseUrl: test.baseUrl, compositionRevision: test.snapshot.composition.revision },
  );
  yield* archivePartyWithAuthorization(
    { expectedRevision: details.party.revision, partyRef: party, reason: 'Archive canonical Guest identity' },
    yield* test.authorization(),
    yield* test.options,
  );
  expect((yield* test.resolve(root, evidence, yield* DateTime.now)).outcome).toBe('INVALID_OR_INSUFFICIENT_EVIDENCE');
  expect(yield* test.attribute(root, evidence, yield* nextId, DateTime.formatIso(yield* DateTime.now))).toEqual({
    outcome: 'PARTY_INVALID',
  });
  expect(yield* test.profiles()).toEqual([]);
  expect(yield* test.attributions(root)).toMatchObject([{ outcome: 'PARTY_INVALID' }]);
  expect(yield* test.bindings()).toEqual([]);
  expect(yield* test.bindings(otherSeller)).toEqual([]);
  expect(yield* test.bindings(other.actor)).toEqual([]);
  yield* test.permissions();
  yield* test.permissions(otherSeller);
  yield* test.permissions(other.actor);
});

const publicConcurrentRetry = Effect.fn('GuestEvidenceTest.publicConcurrentRetry')(function* publicConcurrentRetry() {
  const test = yield* GuestAuthorityFixture;
  const root = `concurrent-${yield* nextId}`;
  const evidence = `concurrent-${yield* nextId}`;
  const party = yield* test.createOrganization(root, evidence, '27074358');
  const at = DateTime.formatIso(yield* DateTime.now);
  const key = yield* nextId;
  const release = yield* Deferred.make<boolean>();
  const firstReady = yield* Deferred.make<boolean>();
  const secondReady = yield* Deferred.make<boolean>();
  const run = (ready: Deferred.Deferred<boolean>) =>
    Effect.gen(function* concurrentExact() {
      yield* Deferred.succeed(ready, true);
      yield* Deferred.await(release);
      return yield* test.attribute(root, evidence, key, at).pipe(Effect.result);
    });
  const first = yield* run(firstReady).pipe(Effect.forkScoped);
  const second = yield* run(secondReady).pipe(Effect.forkScoped);
  yield* Deferred.await(firstReady);
  yield* Deferred.await(secondReady);
  yield* Deferred.succeed(release, true);
  const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
  const successful = results.filter(Result.isSuccess);
  const failed = results.filter(Result.isFailure);
  expect(successful).toHaveLength(1);
  expect(failed).toHaveLength(1);
  const [success] = successful;
  const [failure] = failed;
  assert.isOk(success !== undefined && failure !== undefined);
  expect(success.success).toMatchObject({ outcome: 'ATTRIBUTED', partyRef: party });
  expect(Predicate.isTagged(failure.failure, 'ActionAlreadyCommitted')).toBe(true);
  const original = yield* test.attributions(root);
  expect(original).toHaveLength(1);
  expect(yield* test.profiles()).toHaveLength(1);
  const committed = yield* test.fixture.evidence(test.coreEvidenceExecutor);
  const events = committed.events.filter(
    ({ eventType }) => eventType === 'commerce.customer-context.guest-retail-customer-attributed.v1',
  );
  expect(events).toHaveLength(1);
  const [event] = events;
  assert.isOk(event !== undefined);
  expect(committed.outbox.filter(({ domainEventId }) => domainEventId === event.domainEventId)).toHaveLength(1);
  const retry = yield* test.attribute(root, evidence, yield* nextId, at);
  expect(retry).toEqual(success.success);
  expect(yield* test.attributions(root)).toEqual(original);
  const nextEvidence = `changed-${yield* nextId}`;
  yield* test.createOrganization(root, nextEvidence, '26168685');
  const beforeProfiles = yield* test.profiles();
  const beforeConflict = yield* test.fixture.evidence(test.coreEvidenceExecutor);
  const changed = yield* test
    .attribute(root, nextEvidence, yield* nextId, DateTime.formatIso(yield* DateTime.now))
    .pipe(Effect.flip);
  expect(changed).toMatchObject({ code: 'CURRENT_STATE_CONFLICT', retryable: false });
  expect(Schema.is(AttributeGuestRetailCustomerRejected)(changed)).toBe(true);
  expect(yield* test.profiles()).toEqual(beforeProfiles);
  expect(yield* test.attributions(root)).toEqual(original);
  expect((yield* test.fixture.evidence(test.coreEvidenceExecutor)).events).toEqual(beforeConflict.events);
  expect(
    (yield* test.fixture.evidence(test.coreEvidenceExecutor)).outbox.map(
      ({ matchedAt: _matchedAt, ...immutable }) => immutable,
    ),
  ).toEqual(beforeConflict.outbox.map(({ matchedAt: _matchedAt, ...immutable }) => immutable));
  expect(yield* test.bindings()).toEqual([]);
  yield* test.permissions();
});

const publicOwnerUnavailable = Effect.fn('GuestEvidenceTest.publicOwnerUnavailable')(
  function* publicOwnerUnavailable() {
    const test = yield* GuestAuthorityFixture;
    const root = `unavailable-${yield* nextId}`;
    const evidence = `unavailable-${yield* nextId}`;
    const party = yield* test.createOrganization(root, evidence, '27074358');
    expect(yield* test.resolve(root, evidence, yield* DateTime.now)).toEqual({
      outcome: 'EXISTING_PARTY_RESOLVED',
      partyRef: party,
    });
    yield* test.child.kill();
    yield* test.child.exitCode;
    expect(yield* test.child.isRunning).toBe(false);
    const profiles = yield* test.profiles();
    const before = yield* test.fixture.evidence(test.coreEvidenceExecutor);
    const unavailable = yield* test
      .attribute(root, evidence, yield* nextId, DateTime.formatIso(yield* DateTime.now))
      .pipe(Effect.flip);
    expect(Schema.is(AttributeGuestRetailCustomerRejected)(unavailable)).toBe(true);
    expect(unavailable).toMatchObject({ code: 'PARTY_REGISTRY_UNAVAILABLE', retryable: true });
    expect(yield* test.profiles()).toEqual(profiles);
    expect(yield* test.attributions(root)).toEqual([]);
    expect(yield* test.bindings()).toEqual([]);
    expect((yield* test.fixture.evidence(test.coreEvidenceExecutor)).events).toEqual(before.events);
    expect(
      (yield* test.fixture.evidence(test.coreEvidenceExecutor)).outbox.map(
        ({ matchedAt: _matchedAt, ...immutable }) => immutable,
      ),
    ).toEqual(before.outbox.map(({ matchedAt: _matchedAt, ...immutable }) => immutable));
    yield* test.permissions();
  },
);

// Each fixture builds an isolated native database and starts real Party processes; on a loaded CI runner
// that took about 28 s, so each hook gets 120 s. Test bodies keep their own 30 s bound.
it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'public Party evidence authority governs a real native CCC Guest attribution without granting Portal access',
    publicGuestAttributionAuthority,
    30_000,
  );
});

it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'weak and VERIFIED-only public contact evidence stays insufficient at the exact End boundary',
    publicWeakContactEnd,
    30_000,
  );
});

it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'public retained REVIEW_MATCH authority reaches the actual native CCC attribution',
    publicReviewedGuest,
    30_000,
  );
});

it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'actual foreign Tenant and selected LE cannot reuse proof and archived canonical identity stays invalid',
    publicScopeAndArchive,
    30_000,
  );
});

it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'concurrent exact attribution retry and changed native intent preserve the durable correlation',
    publicConcurrentRetry,
    30_000,
  );
});

it.layer(guestAuthorityFixtureLayer, { excludeTestServices: true, timeout: 120_000 })((testIt) => {
  testIt.effect(
    'actual Party receiver process outage fails native CCC attribution without writing identity',
    publicOwnerUnavailable,
    30_000,
  );
});
