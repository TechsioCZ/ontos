/**
 * VAT through the REAL Shell, as stage runs it: the packaged Shell (its gateway issuer and private signing key only, no
 * public key set), and Tax, Finance Billing and Merchandise each served by the owners process from a built export
 * (`scripts/zerops/serve-units.mts`), their module keys from the platform's own provisioning, handed over on each
 * process's private channel (fd 3) only. Every context comes from the Shell's own issuance: a person's from a signed-in
 * session, the storefront client's from its key, a module's from the delegated endpoint.
 *
 * Whose right reads the rates Merchandise and Finance price with: Tax's three rate reads admit `merchandise` and
 * `finance-billing` as callers with `subject: 'identity'` (verticals/tax/src/api/applicable-tax-rule-set.read.ts), and
 * Core admits such a module call for a verified person of the company without any capability of that person
 * (packages/core-runtime/src/access/enforcement/service.ts, `allow.actor_identity`). So a Skladník or an e-shop
 * administrator, who hold no Tax read, still get rates Tax confirmed; the same person asking Tax directly (the DPH page)
 * is decided on their own rights.
 *
 * Runs only inside the VAT deploy rehearsal (part 3 of `vat-deploy-rehearsal.sh`): `ONTOS_VAT_BUILT_APP` names the app folder of the built export, and the
 * integration environment names a fresh, migrated clone of the deployed database. `ONTOS_VAT_REAL_SHELL_REPORT`, when
 * set, receives the per-persona table.
 */
import { writeFileSync } from 'node:fs';

import {
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  loadDatabaseConfig,
  loadDatabaseConnectionPair,
  lockApplicationCompositionPublication,
  makeDatabaseIdentityEnrollmentLive,
  makePrincipalResolver,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  PrincipalResolver,
  SHELL_GATEWAY_ISSUER_IDENTITY,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { AccessCatalogModulesSchema, buildAccessCatalogRelease } from '@app/core-runtime/access/catalog';
import { makeAccessChangesDrizzleStore } from '@app/core-runtime/access/changes/persistence/drizzle-store';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { CoreDatabase } from '@app/core-runtime/db/client';
import { SHARED_RUNTIME_IDENTITY } from '@app/core-runtime/db/database-identity-manifest';
import {
  makeLiveOperationFixture,
  publishTestApplicationCompositionAuthority,
  testCoreDatabase,
} from '@app/core-runtime/testing/owner-evidence';
import { grantTestTenantOwnerAccess, liveFixtureSpiceDb } from '@app/core-runtime/testing/tenant-access';
import { GatewayContextResponseSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { NodeHttpClient, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import {
  Config,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Result,
  Schema,
  Scope,
} from 'effect';
import { Cookies, HttpBody, HttpClient } from 'effect/http';
import type { ChildProcessHandle } from 'effect/process/ChildProcessSpawner';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { exportJWK, generateKeyPair } from 'jose';

import {
  accessWorkloadBindings,
  accessWorkloadCompanyBindings,
  principals,
} from '../../packages/core-runtime/src/db/schema.ts';
import { makeTestTenantRoleAccess } from '../../packages/core-runtime/src/testing/tenant-access-roles.ts';
import {
  deriveActiveApplicationCompositionSnapshot,
  encodeActiveApplicationCompositionSnapshot,
} from '../active-application-composition.mts';
import { policyRoleKeys } from '../demo/access-policy.mts';
import { demoRoles, eshopDemoRoles } from '../demo/permissions.mts';
import { runTaxBaseline, toDeclareAnswer, toRegimeObservation, toRuleObservation } from '../demo/seed-tax-baseline.mts';
import type { TaxBaselineCompanyPort, TaxBaselineTenantPort } from '../demo/seed-tax-baseline.mts';
import { taxModuleKey } from '../demo/stage-tenant-modules.mts';
import { encodeModuleCredentialHandover } from '../zerops/module-credentials.mts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { lineVatOf } from '../../verticals/finance-billing/shared/domain/line-vat.ts';
import { PlaceStorefrontOrderPayloadSchema } from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { ApplyCommandPayloadSchema } from '../../verticals/finance-billing/shared/actions/apply-command.ts';
import { executeApplyCommandWithAuthorization } from '../../verticals/finance-billing/src/api/apply-command-action-client.ts';
import { executeVatChoicesWithAuthorization } from '../../verticals/finance-billing/src/api/vat-choices-client.ts';
import { executePlaceStorefrontOrderWithAuthorization } from '../../verticals/merchandise/src/api/place-storefront-order-action-client.ts';
import { executeRecordsWithAuthorization } from '../../verticals/merchandise/src/api/records-client.ts';
import { executeApplicableTaxRuleSetWithAuthorization } from '../../verticals/tax/src/api/applicable-tax-rule-set-client.ts';
import { executeCreateTaxRuleWithAuthorization } from '../../verticals/tax/src/api/create-tax-rule-action-client.ts';
import { executeDeclareSellerVatRegimeWithAuthorization } from '../../verticals/tax/src/api/declare-seller-vat-regime-action-client.ts';
import { executeSellerVatRegimeAtInstantWithAuthorization } from '../../verticals/tax/src/api/seller-vat-regime-at-instant-client.ts';
import { executeSellerVatRegimeHistoryWithAuthorization } from '../../verticals/tax/src/api/seller-vat-regime-history-client.ts';
import { ApiKeyService, makeApiKeyService } from '../../apps/shell-super-app/api/auth/api-key-service.ts';
import { AuthConfig, parseAuthConfig } from '../../apps/shell-super-app/api/auth/config.ts';
import { AuthDatabase, makeAuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { account, user } from '../../apps/shell-super-app/api/auth/db/schema.ts';
import { moduleCredentialReleaseOf } from '../../apps/shell-super-app/api/auth/module-credential-attestation.ts';
import { provisionModuleCredentials } from '../../apps/shell-super-app/api/auth/module-credential-provisioning.service.ts';
import { SHELL_DATABASE_IDENTITY_ENROLLMENT } from '../../apps/shell-super-app/api/database-identity-enrollment.ts';
import { startNativeHttpServer } from '../../apps/shell-super-app/tests/support/native-http-server.ts';
import {
  allocateLoopbackPort,
  PackagedOwnerStartupError,
  startHostedOwnerWithHandover,
  startPackagedApplication,
} from '../../apps/shell-super-app/tests/support/server-owner-relay-native-fixture.ts';
import { makeShellTestAuthentication } from '../../apps/shell-super-app/tests/support/shell-authentication.ts';

const SHELL_API = '/shell-super-app-api';
const MERCHANDISE_API = '/merchandise-api';
const TAX_API = '/tax-api';
const FINANCE_API = '/finance-billing-api';
/** The registered storefront client that may stand as the subject of Merchandise's Tax reads. */
const STOREFRONT_WORKLOAD = 'demo.storefront-client';
/** Merchandise's topology app id. */
const MERCHANDISE_APP = 'merchandise';
const FINANCE_APP = 'finance-billing';
const TAX_APP = 'tax';
const STANDARD = 'cz.vat.standard';
const MERCHANDISE_MODULE = 'demo.merchandise';
const FINANCE_MODULE = 'finance.billing';
/** Tax's three reads Merchandise and Finance price with; a person needs none of them for that. */
const TAX_RATE_READS = [
  'commerce.tax.tax-rule-set.read',
  'commerce.tax.tax-rule.read-history',
  'commerce.tax.seller-vat-regime.read-at-instant',
] as const;

const authorizationCatalogUrl = new URL('../../topology/authorization-catalog.json', import.meta.url);
const transitionFixtureUrl = new URL(
  '../../verticals/merchandise/tests/fixtures/vat-transition-pre-migration.json',
  import.meta.url,
);
const MERCHANDISE_TABLES = [
  'catalog_heads',
  'categories',
  'products',
  'product_variants',
  'price_tiers',
  'stock_movements',
  'market_settings',
  'market_product_offers',
] as const;
const TransitionFixtureSchema = Schema.Struct({
  order: Schema.Struct({ command: Schema.Struct({ command: Schema.Record(Schema.String, Schema.Json) }) }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
});

/** One persona's run: the route it took, what the Shell and Tax decided, and the outcome. */
interface PersonaOutcome {
  readonly decisions: readonly string[];
  readonly outcome: string;
  readonly persona: string;
  readonly route: string;
  readonly shell: string;
}

const builtApp = Config.option(Config.String('ONTOS_VAT_BUILT_APP'));
const reportFile = Config.option(Config.String('ONTOS_VAT_REAL_SHELL_REPORT'));

/** The status and reason code of a refused owner or Shell answer; anything else names none. */
const RefusalSchema = Schema.Struct({
  reason: Schema.optionalKey(Schema.String),
  status: Schema.Number,
  type: Schema.optionalKey(Schema.String),
});
const refusalOf = (failure: unknown) =>
  Option.match(Schema.decodeUnknownOption(RefusalSchema)(failure), {
    onNone: () => 'refused (no status)',
    onSome: ({ reason, status, type }) =>
      [String(status), reason, type === undefined ? undefined : `(${type})`]
        .filter((part): part is string => part !== undefined)
        .join(' '),
  });
/** What one call came to: `onSuccess` of its answer, or the status and reason code it was refused with. */
const outcomeOf = <A, E>(result: Result.Result<A, E>, onSuccess: (answer: A) => string) =>
  Result.match(result, { onFailure: (failure) => `refused ${refusalOf(failure)}`, onSuccess });

/** Publishes the checked-in authorization catalog, so every Tenant pins the release of every module. */
const publishCatalogRelease = Effect.fn('VatRealShell.publishCatalogRelease')(function* publishCatalogRelease(
  database: Effect.Success<typeof testCoreDatabase>,
) {
  const [filesystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  const { modules } = yield* path.fromFileUrl(authorizationCatalogUrl).pipe(
    Effect.flatMap((catalogPath) => filesystem.readFileString(catalogPath)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ modules: AccessCatalogModulesSchema }))),
    ),
  );
  const release = yield* Effect.fromResult(
    buildAccessCatalogRelease({
      installedModuleKeys: modules.map(({ moduleId }) => moduleId),
      modules,
      publishedAt: DateTime.toDateUtc(yield* DateTime.now),
    }),
  );
  const store = makeAccessChangesDrizzleStore({ enrollment: SHELL_DATABASE_IDENTITY_ENROLLMENT, executor: database });
  yield* store.publishCatalog({ snapshot: release });
  return release;
});

/**
 * A Tenant with Merchandise, Finance Billing and Tax installed: its owner and one more member (the persona whose roles
 * the test sets) as signed-up Shell users, and the packaged Shell of the export serving it, started as stage starts it.
 */
const makeShellFixture = Effect.fn('VatRealShell.shellFixture')(function* makeShellFixture(input: {
  readonly compositionUrl: string;
  readonly gateway: { readonly privateJwk: Redacted.Redacted; readonly publicJwks: string };
  readonly shellDirectory: string;
}) {
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const issuerConfiguration = yield* loadDatabaseConfig({
    envPath: '/dev/null',
    identity: SHELL_GATEWAY_ISSUER_IDENTITY,
  });
  const admin = yield* PgClient.make({ url: Redacted.make(connections.admin.connectionString) });
  const database = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, admin));
  const core = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [],
      adminConnectionString: Redacted.make(connections.admin.connectionString),
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: 'a'.repeat(64),
      moduleKeys: [MERCHANDISE_MODULE, FINANCE_MODULE, taxModuleKey],
      runtimeConnectionString: Redacted.make(connections.runtime.connectionString),
    }),
    (fixture) => fixture.close().pipe(Effect.orDie),
  );
  const access = {
    legalEntityIds: [core.legalEntityId] as const,
    spiceDb: yield* liveFixtureSpiceDb(core.permissionEnvironment),
    writerConnectionString: Redacted.make(connections.runtime.connectionString),
  };
  const release = yield* publishCatalogRelease(database);
  yield* grantTestTenantOwnerAccess({ ...access, memberPrincipalIds: [core.reader.principalId], owner: core.manager });
  const crypto = yield* Crypto.Crypto;
  const secret = Redacted.make(yield* crypto.randomUUIDv4());
  const password = Redacted.make(yield* crypto.randomUUIDv4());
  const port = yield* allocateLoopbackPort();
  const origin = `http://localhost:${port}`;
  const configuration = yield* parseAuthConfig({
    BETTER_AUTH_SECRET: Redacted.value(secret),
    BETTER_AUTH_URL: origin,
    DATABASE_URL: connections.runtime.connectionString,
    NODE_ENV: 'production',
  });
  const persistence = yield* makeAuthDatabase({ ...configuration, expectedRole: SHARED_RUNTIME_IDENTITY.role });
  const resolver = makePrincipalResolver(
    { executor: database },
    { authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID },
  );
  const authentication = yield* makeShellTestAuthentication({ allowFixtureSignUp: true }).pipe(
    Effect.provideService(AuthConfig, configuration),
    Effect.provideService(AuthDatabase, persistence),
    Effect.provideService(CoreDatabase, { executor: database }),
    Effect.provideService(PrincipalResolver, resolver),
  );
  /** A signed-up Shell user whose Auth id is the fixture actor's binding, as Core's binding names it. */
  const signUp = Effect.fn('VatRealShell.signUp')(function* signUp(authBindingId: string, label: string) {
    const email = `vat-${label}-${authBindingId}@example.test`;
    const generatedId = yield* Effect.acquireRelease(authentication.createFixtureUser(email, label, password), (id) =>
      persistence.executor
        .delete(user)
        .where(eq(user.id, authBindingId))
        .pipe(Effect.andThen(persistence.executor.delete(user).where(eq(user.id, id))), Effect.orDie),
    );
    yield* persistence.executor.transaction(
      Effect.fn('VatRealShell.alignAuthSubject')(function* alignAuthSubject(transaction) {
        const [generated] = yield* transaction.select().from(user).where(eq(user.id, generatedId));
        if (generated === undefined) {
          return yield* new PackagedOwnerStartupError({ reason: 'Actual fixture Auth user was not persisted' });
        }
        yield* transaction
          .update(user)
          .set({ email: `relocated-${generatedId}@example.test` })
          .where(eq(user.id, generatedId));
        yield* transaction.insert(user).values({ ...generated, email, id: authBindingId });
        yield* transaction
          .update(account)
          .set({ accountId: authBindingId, userId: authBindingId })
          .where(eq(account.userId, generatedId));
        yield* transaction.delete(user).where(eq(user.id, generatedId));
        return yield* Effect.void;
      }),
    );
    return email;
  });
  const ownerEmail = yield* signUp(core.manager.authBindingId, 'owner');
  const personaEmail = yield* signUp(core.reader.authBindingId, 'persona');
  const application = yield* startPackagedApplication({
    appId: 'shell-super-app',
    authentication: {
      baseUrl: origin,
      connectionString: Redacted.make(connections.runtime.connectionString),
      issuerConnectionString: Redacted.make(issuerConfiguration.connectionString),
      port,
      secret,
      spice: yield* Config.all({
        caCertificate: Config.String('SPICEDB_CA_CERT'),
        endpoint: Config.String('SPICEDB_ENDPOINT'),
        preSharedKey: Config.Redacted('SPICEDB_PRESHARED_KEY'),
      }),
    },
    compositionUrl: input.compositionUrl,
    gateway: { issuer: origin, privateJwk: input.gateway.privateJwk, publicJwks: input.gateway.publicJwks },
    relativeDirectory: input.shellDirectory,
  });
  return {
    access,
    admin,
    application,
    configuration,
    core,
    database,
    origin,
    ownerEmail,
    password,
    persistence,
    personaEmail,
    release,
  };
});
type ShellFixture = Effect.Success<ReturnType<typeof makeShellFixture>>;

/** A hosted owner as `startHostedOwnerWithHandover` returns it. */
type HostedOwner = Effect.Success<ReturnType<typeof startHostedOwnerWithHandover>>;
/** The owners this release serves through the owners process. */
const HostedAppIdSchema = Schema.Literals([FINANCE_APP, MERCHANDISE_APP, TAX_APP]);
type HostedAppId = typeof HostedAppIdSchema.Type;

/**
 * The release as stage runs it: the packaged Shell, hosted Tax and Finance Billing (Merchandise starts fresh per
 * persona), the active composition derived from what they serve, every module key from the platform's provisioning
 * and the company's catalog. Returns what the phases share.
 */
const setUpScenario = Effect.fn('VatRealShell.setUp')(function* setUpScenario(
  exportApp: string,
  children: ChildProcessHandle[],
) {
  const crypto = yield* Crypto.Crypto;
  const client = yield* HttpClient.HttpClient;
  const uuid = crypto.randomUUIDv4();
  const keyPair = yield* Effect.tryPromise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const kid = `vat-real-shell-${yield* uuid}`;
  const privateJwk = yield* Effect.tryPromise(() => exportJWK(keyPair.privateKey));
  const publicJwk = yield* Effect.tryPromise(() => exportJWK(keyPair.publicKey));
  const gateway = {
    privateJwk: Redacted.make(JSON.stringify({ ...privateJwk, alg: 'EdDSA', kid, use: 'sig' })),
    publicJwks: JSON.stringify({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] }),
  };
  const published = { encoded: Option.none<string>() };
  const source = yield* startNativeHttpServer((request) => {
    if (new URL(request.url).pathname !== '/active') {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(
      Option.match(published.encoded, {
        onNone: () => new Response(null, { status: 503 }),
        onSome: (encoded) => new Response(encoded, { headers: { 'content-type': 'application/json' }, status: 200 }),
      }),
    );
  });
  const compositionUrl = `${source.origin}/active`;
  const fixture: ShellFixture = yield* makeShellFixture({
    compositionUrl,
    gateway,
    shellDirectory: `${exportApp}/apps/shell-super-app`,
  });
  const { admin: sql, application: shell, core } = fixture;
  children.push(shell.child);
  const companyId = core.legalEntityId;
  const { tenantId } = core;

  // The company's catalog as stage holds it (the transition fixture's rows), priced at the migrated rates.
  const filesystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const transition = yield* path.fromFileUrl(transitionFixtureUrl).pipe(
    Effect.flatMap((file) => filesystem.readFileString(file)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(TransitionFixtureSchema))),
  );
  const rowsOf = (table: string) =>
    JSON.stringify(
      (transition.rows[table] ?? []).map((row) => ({ ...row, legal_entity_id: companyId, tenant_id: tenantId })),
    );
  yield* Effect.forEach(
    MERCHANDISE_TABLES,
    (table) =>
      sql.unsafe(
        `insert into demo_merchandise.${table} select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
        [rowsOf(table)],
      ),
    { concurrency: 1, discard: true },
  );
  yield* sql.unsafe(
    'update demo_merchandise.catalog_heads set tax_rates = demo_merchandise.migration_tax_rates(tenant_id, legal_entity_id) where tenant_id = $1 and legal_entity_id = $2',
    [tenantId, companyId],
  );

  // Tax, Finance and Merchandise as the app host serves them: claimed before they load, keys only on fd 3.
  const hosted = (appId: HostedAppId) =>
    startHostedOwnerWithHandover({
      appId,
      compositionUrl,
      gateway: { issuer: fixture.origin, publicJwks: gateway.publicJwks },
      relativeDirectory: `${exportApp}/verticals/${appId}`,
      shellGatewayBaseUrl: `${fixture.origin}${SHELL_API}`,
      workspaceDirectory: exportApp,
    });
  const tax = yield* hosted(TAX_APP);
  const finance = yield* hosted(FINANCE_APP);
  children.push(tax.child, finance.child);
  const observe = Effect.fn('VatRealShell.observe')(function* observe(url: string) {
    const response = yield* client.get(url, { headers: { 'cache-control': 'no-cache' } });
    expect([url, response.status]).toEqual([url, 200]);
    return { bytes: new Uint8Array(yield* response.arrayBuffer), url };
  });
  const moduleOf = Effect.fn('VatRealShell.moduleOf')(function* moduleOf(appId: HostedAppId, origin: string) {
    const module = {
      appId,
      backend: { baseUrl: `${origin}/`, transport: 'node-http' as const },
      contract: yield* observe(`${origin}${ONTOS_MODULE_CONTRACT_PATH}`),
    };
    // Tax is API-only: it serves no federation manifest, so the release records none for it.
    return appId === TAX_APP ? module : { ...module, federationManifest: yield* observe(`${origin}/mf-manifest.json`) };
  });
  // Merchandise's first process only serves what the release records of it; every persona gets a fresh one.
  const merchandiseModule = yield* Effect.scoped(
    hosted(MERCHANDISE_APP).pipe(Effect.flatMap((merchandise) => moduleOf(MERCHANDISE_APP, merchandise.origin))),
  );
  const snapshot = yield* deriveActiveApplicationCompositionSnapshot({
    environment: 'development',
    modules: [merchandiseModule, yield* moduleOf(TAX_APP, tax.origin), yield* moduleOf(FINANCE_APP, finance.origin)],
    observedAt: yield* DateTime.now,
    shell: {
      federationManifest: yield* observe(`${shell.origin}/mf-manifest.json`),
      runtimeContract: yield* observe(`${shell.origin}${ONTOS_SHELL_RUNTIME_CONTRACT_PATH}`),
    },
    validity: Duration.minutes(30),
  });
  const approved = yield* validateActiveApplicationCompositionSnapshot(snapshot);
  yield* fixture.database.transaction(
    Effect.fn('VatRealShell.drainPreviousAuthority')(function* drainPreviousAuthority(transaction) {
      yield* lockApplicationCompositionPublication(transaction);
      const previous = yield* transaction.query.applicationCompositionAuthority.findFirst({
        where: { authorityKey: 'active' },
      });
      if (previous !== undefined && previous.revision !== approved.composition.revision) {
        if (previous.phase === 'active') {
          yield* closeApplicationCompositionDurableAdmission(transaction, previous.revision);
        }
        yield* drainApplicationCompositionAuthority(transaction, previous.revision);
      }
    }),
  );
  yield* publishTestApplicationCompositionAuthority(fixture.database, approved);
  published.encoded = Option.some(yield* encodeActiveApplicationCompositionSnapshot(approved));
  const { revision } = approved.composition;

  // The operator's data: the company's registered storefront client (a service principal, its workload binding and
  // the one company it acts for). The platform's provisioning then issues every key.
  const storefrontPrincipal = yield* uuid;
  const storefrontBinding = yield* uuid;
  yield* fixture.database.insert(principals).values({
    displayName: 'Storefront',
    kind: 'service',
    principalId: storefrontPrincipal,
    status: 'active',
    tenantId,
  });
  yield* fixture.database.insert(accessWorkloadBindings).values({
    bindingId: storefrontBinding,
    incarnation: yield* uuid,
    principalId: storefrontPrincipal,
    status: 'active',
    tenantId,
    workloadKey: STOREFRONT_WORKLOAD,
  });
  yield* fixture.database.insert(accessWorkloadCompanyBindings).values({
    companyBindingId: yield* uuid,
    incarnation: yield* uuid,
    legalEntityId: companyId,
    status: 'active',
    tenantId,
    workloadBindingId: storefrontBinding,
  });
  yield* Effect.addFinalizer(() =>
    DateTime.nowAsDate.pipe(
      Effect.flatMap((revokedAt) =>
        fixture.database
          .update(accessWorkloadBindings)
          .set({ revokedAt, status: 'revoked' })
          .where(eq(accessWorkloadBindings.bindingId, storefrontBinding)),
      ),
      Effect.orDie,
    ),
  );
  const connections = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
  const runtime = yield* PgClient.make({ url: Redacted.make(connections.runtime.connectionString) });
  const runtimeDatabase = yield* testCoreDatabase.pipe(Effect.provideService(PgClient.PgClient, runtime));
  const apiKeys = yield* makeApiKeyService().pipe(
    Effect.provideService(AuthConfig, fixture.configuration),
    Effect.provideService(AuthDatabase, fixture.persistence),
  );
  const provisioned = yield* provisionModuleCredentials({
    appIds: [MERCHANDISE_APP, FINANCE_APP],
    bootId: yield* uuid,
    hostId: 'vat-real-shell-native',
    operationId: yield* uuid,
    release: moduleCredentialReleaseOf({ composition: approved.composition, contracts: approved.composition.modules }),
    workloads: new Map([[MERCHANDISE_APP, [STOREFRONT_WORKLOAD]]]),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ApiKeyService, apiKeys),
        Layer.succeed(AuthDatabase, fixture.persistence),
        Layer.succeed(CoreDatabase, { executor: runtimeDatabase }),
      ),
    ),
  );
  expect(provisioned.failedAppIds).toEqual([]);
  const credentials = Object.fromEntries(provisioned.credentials);
  const storefrontKey = provisioned.workloadCredentials.get(`merchandise/${STOREFRONT_WORKLOAD}/${tenantId}`);
  if (storefrontKey === undefined) {
    return yield* new PackagedOwnerStartupError({ reason: 'No storefront client key was issued' });
  }
  /** Hands one owner its own module key, and nothing else, on its private channel. */
  const handOver = Effect.fn('VatRealShell.handOver')(function* handOver(owner: HostedOwner, appId: string) {
    yield* owner.handOver(yield* encodeModuleCredentialHandover(credentials, [appId]));
    const taken = yield* owner.received.pipe(
      Effect.tapError(() =>
        Effect.logError(`${appId} took no key`, {
          lines: owner.diagnostics.map(Redacted.value).slice(-30),
          running: owner.child.pid,
        }),
      ),
    );
    expect(taken).toBe(appId);
  });
  yield* handOver(finance, FINANCE_APP);

  /** A person signed in to the Shell: the session cookie the browser holds. */
  const signIn = Effect.fn('VatRealShell.signIn')(function* signIn(email: string) {
    const response = yield* client.post(`${fixture.origin}${shell.apiPrefix}/auth/sign-in`, {
      body: yield* HttpBody.json({ email, password: Redacted.value(fixture.password) }),
      headers: { origin: fixture.origin },
    });
    expect(response.status).toBe(200);
    return Redacted.make(Cookies.toCookieHeader(response.cookies));
  });
  /** The Shell's context for one module, issued for the session exactly as the browser asks for it. */
  const sessionContext = Effect.fn('VatRealShell.sessionContext')(function* sessionContext(
    cookie: Redacted.Redacted,
    audience: HostedAppId,
  ) {
    const response = yield* client.post(`${fixture.origin}${shell.apiPrefix}/auth/gateway-context`, {
      body: yield* HttpBody.json({ audience, compositionRevision: revision, legalEntityId: companyId }),
      headers: { cookie: Redacted.value(cookie), origin: fixture.origin, 'x-correlation-id': yield* uuid },
    });
    expect([audience, response.status]).toEqual([audience, 200]);
    const issued = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(GatewayContextResponseSchema)));
    return `Bearer ${issued.token}`;
  });
  const personaRoles = yield* makeTestTenantRoleAccess({
    ...fixture.access,
    principalId: core.reader.principalId,
    tenantId,
  });
  /** The persona holds exactly these capabilities, as one role, and nothing else. */
  const becomes = Effect.fn('VatRealShell.becomes')(function* becomes(capabilities: readonly string[]) {
    const [first, ...rest] = capabilities;
    if (first === undefined) {
      return yield* new PackagedOwnerStartupError({ reason: 'A preset without capabilities' });
    }
    yield* personaRoles.endHeldRoles();
    return yield* (yield* personaRoles.capabilityRole([first, ...rest])).grant();
  });
  return {
    becomes,
    client,
    companyId,
    core,
    finance,
    fixture,
    handOver,
    hosted,
    revision,
    sessionContext,
    signIn,
    sql,
    storefrontKey,
    storefrontPrincipal,
    tax,
    tenantId,
    transition,
    uuid,
  };
});
type Scenario = Effect.Success<ReturnType<typeof setUpScenario>>;

/** Tax's baseline for the company, seeded by the owner through the seed's own planner against hosted Tax. */
const seedTax = Effect.fn('VatRealShell.seedTax')(function* seedTax(
  scenario: Scenario,
  ownerCookie: Redacted.Redacted,
) {
  const taxCall = <A, E>(
    run: (
      authorization: string,
      options: { readonly baseUrl: string; readonly compositionRevision: string },
    ) => Effect.Effect<A, E>,
  ) =>
    scenario.sessionContext(ownerCookie, TAX_APP).pipe(
      Effect.flatMap((authorization) =>
        run(authorization, { baseUrl: `${scenario.tax.origin}${TAX_API}`, compositionRevision: scenario.revision }),
      ),
      Effect.mapError((cause) => ({
        _tag: 'TaxCallRefused' as const,
        refusal: { _tag: 'Conflict' as const, detail: refusalOf(cause) },
      })),
    );
  const correlation = 'vat-real-shell-seed';
  const companyPort: TaxBaselineCompanyPort = {
    applicableRules: (taxClassificationCode, at) =>
      taxCall((authorization, options) =>
        executeApplicableTaxRuleSetWithAuthorization(
          { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode, taxRelevantTime: at },
          authorization,
          correlation,
          options,
        ),
      ).pipe(Effect.map(toRuleObservation)),
    // The Shell's "Proč?" explain is not part of this chain: Tax's own gate decides every call.
    checkRight: () => Effect.succeed({ _tag: 'Allowed' as const }),
    createRule: (payload, idempotencyKey) =>
      taxCall((authorization, options) =>
        executeCreateTaxRuleWithAuthorization(payload, authorization, correlation, { ...options, idempotencyKey }),
      ).pipe(Effect.map(({ created }) => ({ created }))),
    declareRegime: (payload, idempotencyKey) =>
      taxCall((authorization, options) =>
        executeDeclareSellerVatRegimeWithAuthorization(payload, authorization, correlation, {
          ...options,
          idempotencyKey,
        }),
      ).pipe(Effect.map(toDeclareAnswer)),
    regimeAt: (instant) =>
      taxCall((authorization, options) =>
        executeSellerVatRegimeAtInstantWithAuthorization({ instant }, authorization, correlation, options),
      ).pipe(Effect.map(toRegimeObservation)),
  };
  const tenant: TaxBaselineTenantPort = {
    companies: [{ legalEntityId: LegalEntityIdSchema.make(scenario.companyId), name: 'Native fixture company' }],
    company: () => Effect.succeed(companyPort),
    operatorPrincipalId: PrincipalIdSchema.make(scenario.core.manager.principalId),
    tenantId: TenantIdSchema.make(scenario.tenantId),
  };
  const options = { allowedTenants: new Map([[scenario.tenantId, 'VAT real Shell']]), companiesExpected: 1 };
  const planned = yield* Effect.scoped(runTaxBaseline('dry-run', tenant, Option.none(), options));
  yield* Effect.scoped(runTaxBaseline('apply', tenant, Option.some(planned.fingerprint), options));
  const verified = yield* Effect.scoped(runTaxBaseline('verify', tenant, Option.none(), options));
  expect(verified.plan.writes).toEqual([]);
});

/** The company's stored rates: their source and when Tax last confirmed them. */
const syncedAtOf = (scenario: Scenario) =>
  scenario.sql
    .unsafe<{ readonly source: string | null; readonly synced: string | null }>(
      "select tax_rates ->> 'source' as source, tax_rates ->> 'syncedAt' as synced from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2",
      [scenario.tenantId, scenario.companyId],
    )
    .pipe(Effect.map(([row]) => `${row?.source ?? '-'} ${row?.synced ?? '-'}`));
const databaseNow = (scenario: Scenario) =>
  scenario.sql
    .unsafe<{ readonly now: string }>('select clock_timestamp()::text as now')
    .pipe(Effect.map(([row]) => row?.now ?? ''));

/** Tax's decisions since `since` on reads for `principalId`: capability, calling module, outcome and reason codes. */
const taxDecisionsOf = (scenario: Scenario, principalId: string, since: string) =>
  scenario.sql
    .unsafe<{ readonly line: string }>(
      `select capability_key || ' by ' || coalesce(delegate_app_id, 'the person') || ': ' || outcome || ' ' ||
              coalesce(reasons_json::text, '') as line
         from core.access_decision_logs
        where actor_principal_id = $1 and decided_at > $2::timestamptz and capability_key like 'commerce.tax.%'
        order by decided_at`,
      [principalId, since],
    )
    .pipe(Effect.map((rows) => [...new Set(rows.map((row) => row.line))]));

/** Finance's decisions on its writes since `since` for `principalId`, with their reason codes. */
const financeWriteDecisionsOf = (scenario: Scenario, principalId: string, since: string) =>
  scenario.sql
    .unsafe<{ readonly line: string }>(
      `select capability_key || ': ' || outcome || ' ' || coalesce(reasons_json::text, '') as line
         from core.access_decision_logs
        where actor_principal_id = $1 and decided_at > $2::timestamptz and capability_key like 'finance.billing.%.write'
        order by decided_at`,
      [principalId, since],
    )
    .pipe(Effect.map((rows) => [...new Set(rows.map((row) => row.line))]));

const interestingLines = (diagnostics: readonly Redacted.Redacted[]) =>
  diagnostics
    .map(Redacted.value)
    .filter((line) => /tax|refus|warn|error/iu.test(line))
    .slice(-12);

const ratesOf = (records: { readonly taxRates?: readonly { readonly code: string; readonly ratePercent: number }[] }) =>
  (records.taxRates ?? []).map((rate) => `${rate.code} ${String(rate.ratePercent)} %`).join(', ');

/**
 * A fresh Merchandise process on its topology port (so the release's backend address still holds), knowing nothing of
 * Tax yet. The previous one may still be letting go of the port: the start is retried a few times.
 */
const freshMerchandise = (
  scenario: Scenario,
  attemptsLeft = 4,
): Effect.Effect<HostedOwner, unknown, Scope.Scope | Effect.Services<ReturnType<Scenario['hosted']>>> =>
  Effect.acquireRelease(Scope.make(), Scope.close).pipe(
    Effect.flatMap((attempt) =>
      scenario.hosted(MERCHANDISE_APP).pipe(
        Effect.tap((merchandise) => scenario.handOver(merchandise, MERCHANDISE_APP)),
        Scope.provide(attempt),
        // A failed attempt is stopped before the next one starts, so it never keeps the port.
        Effect.tapError(() => Scope.close(attempt, Exit.void)),
      ),
    ),
    Effect.result,
    Effect.flatMap((attempted) =>
      Result.isSuccess(attempted) || attemptsLeft === 0
        ? Effect.fromResult(attempted)
        : freshMerchandise(scenario, attemptsLeft - 1),
    ),
  );

/** One persona's staff product read in a fresh Merchandise process: it asks Tax, then stores Tax's answer. */
const staffRead = Effect.fn('VatRealShell.staffRead')(function* staffRead(
  scenario: Scenario,
  persona: string,
  principalId: string,
  cookie: Redacted.Redacted,
) {
  const merchandise = yield* freshMerchandise(scenario);
  const before = yield* syncedAtOf(scenario);
  const since = yield* databaseNow(scenario);
  const read = Effect.all([scenario.sessionContext(cookie, MERCHANDISE_APP), scenario.uuid]).pipe(
    Effect.flatMap(([authorization, correlation]) =>
      executeRecordsWithAuthorization(
        { view: { limit: 0, ordersLimit: 0, summary: true } },
        authorization,
        correlation,
        {
          baseUrl: `${merchandise.origin}${MERCHANDISE_API}`,
          compositionRevision: scenario.revision,
        },
      ),
    ),
  );
  // The first read starts the refresh; a later one stores Tax's answer (each read is a real request).
  const untilStored = (left: number): Effect.Effect<string, unknown> =>
    read.pipe(
      Effect.andThen(syncedAtOf(scenario)),
      Effect.flatMap((synced) => (synced !== before || left === 0 ? Effect.succeed(synced) : untilStored(left - 1))),
    );
  const after = yield* untilStored(40);
  const records = yield* read;
  const decisions = yield* taxDecisionsOf(scenario, principalId, since);
  yield* Effect.logInfo(`Merchandise log for ${persona}`, { lines: interestingLines(merchandise.diagnostics) });
  return {
    after,
    before,
    outcome: {
      decisions,
      outcome:
        after === before
          ? `rates not refreshed (${records.taxRatesSource ?? 'none'})`
          : `refreshed from ${records.taxRatesSource ?? 'none'}: ${ratesOf(records)}`,
      persona,
      route: 'session → Merchandise staff read → Shell delegated issuance (Merchandise key) → Tax rate reads',
      shell: after === before ? 'not issued (see Merchandise log)' : 'issued',
    } satisfies PersonaOutcome,
    records,
  };
}, Effect.scoped);

/** The registered storefront client: its key, its context from the Shell, a storefront order Merchandise prices. */
const storefrontOrder = Effect.fn('VatRealShell.storefrontOrder')(function* storefrontOrder(scenario: Scenario) {
  const merchandise = yield* freshMerchandise(scenario);
  const before = yield* syncedAtOf(scenario);
  const since = yield* databaseNow(scenario);
  const issued = yield* issueApiKeyGatewayContext(
    { audience: MERCHANDISE_APP, compositionRevision: scenario.revision, legalEntityId: scenario.companyId },
    {
      apiKey: scenario.storefrontKey,
      baseUrl: `${scenario.fixture.origin}${SHELL_API}`,
      requestCorrelation: yield* scenario.uuid,
    },
  );
  const [head] = yield* scenario.sql.unsafe<{ readonly revision: number }>(
    'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
    [scenario.tenantId, scenario.companyId],
  );
  const payload = yield* Schema.decodeUnknownEffect(PlaceStorefrontOrderPayloadSchema)({
    command: {
      ...scenario.transition.order.command.command,
      clientRequestId: `vat-real-shell-${yield* scenario.uuid}`,
    },
    expectedRevision: head?.revision ?? 0,
  });
  const placed = yield* executePlaceStorefrontOrderWithAuthorization(
    payload,
    `Bearer ${issued.token}`,
    yield* scenario.uuid,
    {
      baseUrl: `${merchandise.origin}${MERCHANDISE_API}`,
      compositionRevision: scenario.revision,
      idempotencyKey: yield* scenario.uuid,
    },
  ).pipe(Effect.result);
  // A workload subject leaves no decision row in Core (O29, O73): Tax's answer shows in the stored sync time and in the
  // rates the order's lines were priced and stored with.
  const decisions = yield* taxDecisionsOf(scenario, scenario.storefrontPrincipal, since);
  const after = yield* syncedAtOf(scenario);
  const lines = yield* scenario.sql.unsafe<{ readonly line: string }>(
    `select (line ->> 'productId') || ' ' || (line ->> 'vatRate') || ' % ' || coalesce(line ->> 'taxClassificationCode', '-') as line
       from demo_merchandise.orders, jsonb_array_elements(document -> 'lines') as line
      where tenant_id = $1 and legal_entity_id = $2 and created_at > $3::timestamptz`,
    [scenario.tenantId, scenario.companyId, since],
  );
  const stored = lines.map((row) => row.line);
  yield* Effect.logInfo('Merchandise log for the storefront order', {
    lines: interestingLines(merchandise.diagnostics),
  });
  return {
    after,
    before,
    outcome: {
      decisions,
      outcome: outcomeOf(
        placed,
        () =>
          `order placed; rates ${after === before ? 'not refreshed' : 'refreshed from Tax'}; lines ${stored.join(', ')}`,
      ),
      persona: 'Storefront client (registered workload)',
      route: 'storefront key → Shell api-key context → PlaceStorefrontOrder → delegated issuance → Tax rate reads',
      shell: Result.isSuccess(placed) ? 'issued' : 'see Merchandise log',
    } satisfies PersonaOutcome,
    placed,
    stored,
  };
}, Effect.scoped);

/** The DPH page reads Tax as the person; the invoice form's VAT choices come through Finance's own Tax read. */
const financePersona = Effect.fn('VatRealShell.financePersona')(function* financePersona(
  scenario: Scenario,
  persona: string,
  capabilities: readonly string[],
) {
  yield* scenario.becomes(capabilities);
  const cookie = yield* scenario.signIn(scenario.fixture.personaEmail);
  const since = yield* databaseNow(scenario);
  // Each Tax read with a context of its own, as the page asks the Shell for one per call (a context is single-use).
  const taxOptions = { baseUrl: `${scenario.tax.origin}${TAX_API}`, compositionRevision: scenario.revision };
  const history = yield* executeSellerVatRegimeHistoryWithAuthorization(
    {},
    yield* scenario.sessionContext(cookie, TAX_APP),
    yield* scenario.uuid,
    taxOptions,
  ).pipe(Effect.result);
  const rules = yield* executeApplicableTaxRuleSetWithAuthorization(
    { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: STANDARD, taxRelevantTime: yield* DateTime.now },
    yield* scenario.sessionContext(cookie, TAX_APP),
    yield* scenario.uuid,
    taxOptions,
  ).pipe(Effect.result);
  const choices = yield* executeVatChoicesWithAuthorization(
    { on: DateTime.formatIsoDateUtc(yield* DateTime.now) },
    yield* scenario.sessionContext(cookie, FINANCE_APP),
    yield* scenario.uuid,
    { baseUrl: `${scenario.finance.origin}${FINANCE_API}`, compositionRevision: scenario.revision },
  ).pipe(Effect.result);
  const line = lineVatOf({ code: STANDARD, kind: 'classification' }, Result.getOrUndefined(choices));
  // The invoice itself: an Obchodník's role reads Finance only, so Finance's own gate decides before anything else.
  const invoice =
    persona === 'Obchodník'
      ? yield* Schema.decodeUnknownEffect(ApplyCommandPayloadSchema)({
          command: {
            _tag: 'CreateInvoiceDraft',
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: yield* scenario.uuid,
              resourceType: 'party.registry.counterparty',
              tenantId: scenario.tenantId,
            },
            currency: 'CZK',
            direction: 'OUTGOING',
            documentNumber: 'FV-VAT-REAL-SHELL',
            dueDate: '2026-12-31',
            issueDate: DateTime.formatIsoDateUtc(yield* DateTime.now),
            lines: [{ description: 'Služba', quantity: 1, unitPriceMinor: 10_000, ...line }],
          },
          expectedRevision: 0,
        }).pipe(
          Effect.flatMap((payload) =>
            Effect.all([scenario.sessionContext(cookie, FINANCE_APP), scenario.uuid, scenario.uuid]).pipe(
              Effect.flatMap(([authorization, correlation, idempotencyKey]) =>
                executeApplyCommandWithAuthorization(payload, authorization, correlation, {
                  baseUrl: `${scenario.finance.origin}${FINANCE_API}`,
                  compositionRevision: scenario.revision,
                  idempotencyKey,
                }),
              ),
            ),
          ),
          Effect.result,
          Effect.map((created) => `; invoice draft: ${outcomeOf(created, () => 'created')}`),
        )
      : '';
  const decisions = [
    ...(yield* taxDecisionsOf(scenario, scenario.core.reader.principalId, since)),
    ...(yield* financeWriteDecisionsOf(scenario, scenario.core.reader.principalId, since)),
  ];
  const revisionNote = line?.taxRuleRevisionRef === undefined ? 'missing' : 'stored';
  const describedLine = `${String(line?.vatRate)} % ${line?.vatClassification ?? '-'}, rule revision ${revisionNote}`;
  return {
    line,
    outcome: {
      decisions,
      outcome: [
        `DPH page: regime history ${outcomeOf(history, () => 'shown')}, rates ${outcomeOf(rules, () => 'shown')}`,
        `invoice line VAT choices: ${outcomeOf(choices, () => describedLine)}${invoice}`,
      ].join('; '),
      persona,
      route:
        'session → Tax reads as the person (DPH page); session → Finance VAT choices → delegated issuance (Finance key) → Tax rate reads',
      shell: 'issued',
    } satisfies PersonaOutcome,
  };
});

it.live(
  'Merchandise and Finance price with Tax through the real Shell for every persona; a person reads Tax only on their own rights',
  () =>
    Effect.gen(function* vatThroughRealShell() {
      const exportApp = yield* builtApp;
      if (Option.isNone(exportApp)) {
        return yield* Effect.logWarning('Not run: the VAT deploy rehearsal sets ONTOS_VAT_BUILT_APP to a built export');
      }
      const children: ChildProcessHandle[] = [];
      const outcomes: PersonaOutcome[] = [];
      const result = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* proveVatThroughRealShell() {
            const scenario = yield* setUpScenario(exportApp.value, children);
            const { core, fixture } = scenario;
            const ownerCookie = yield* scenario.signIn(fixture.ownerEmail);
            yield* seedTax(scenario, ownerCookie);

            // The owner, then a Skladník and an e-shop administrator, who hold no Tax read at all.
            const owner = yield* staffRead(scenario, 'Owner', core.manager.principalId, ownerCookie);
            outcomes.push(owner.outcome);
            expect(owner.after).not.toBe(owner.before);
            const presets = [
              ['Skladník', demoRoles.warehouse],
              ['Správce e-shopu', eshopDemoRoles.eshopAdmin],
            ] as const;
            for (const [persona, role] of presets) {
              const capabilities = policyRoleKeys(role, fixture.release.entries);
              expect(capabilities.filter((key) => key.startsWith('commerce.tax.'))).toEqual([]);
              yield* scenario.becomes(capabilities);
              const read = yield* staffRead(
                scenario,
                persona,
                core.reader.principalId,
                yield* scenario.signIn(fixture.personaEmail),
              );
              outcomes.push(read.outcome);
              expect([persona, read.after === read.before, read.records.taxRatesSource]).toEqual([
                persona,
                false,
                'TAX',
              ]);
              expect(read.outcome.decisions.length).toBeGreaterThan(0);
              expect(
                read.outcome.decisions.every(
                  (decision) =>
                    TAX_RATE_READS.some((key) => decision.startsWith(key)) &&
                    decision.includes('by merchandise: ALLOWED'),
                ),
              ).toBe(true);
            }

            const order = yield* storefrontOrder(scenario);
            outcomes.push(order.outcome);
            expect(Result.isSuccess(order.placed)).toBe(true);
            expect(order.after).not.toBe(order.before);
            // BOOK-IT, migrated at 10 %, sells at Tax's reduced 12 % now; every line names its classification.
            expect(order.stored).toEqual([
              'book-it 12 % cz.vat.reduced',
              'p-reduced 12 % cz.vat.reduced',
              'p2 21 % cz.vat.standard',
            ]);

            for (const [persona, role] of [
              ['Účetní', demoRoles.accountant],
              ['Obchodník', demoRoles.salesRep],
            ] as const) {
              const run = yield* financePersona(scenario, persona, policyRoleKeys(role, fixture.release.entries));
              outcomes.push(run.outcome);
              expect([persona, run.line?.vatRate, run.line?.taxRuleRevisionRef !== undefined]).toEqual([
                persona,
                21,
                true,
              ]);
              // The Obchodník's role reads Finance only: Finance refuses the invoice itself, whatever Tax would answer.
              expect(persona !== 'Obchodník' || run.outcome.outcome.includes('invoice draft: refused 403')).toBe(true);
            }
            yield* Effect.logInfo('Hosted owners and Shell', {
              finance: interestingLines(scenario.finance.diagnostics),
              shell: interestingLines(fixture.application.diagnostics),
              tax: interestingLines(scenario.tax.diagnostics),
            });
          }),
        ),
      );
      yield* Effect.logInfo('VAT through the real Shell', { outcomes });
      const report = yield* reportFile;
      if (Option.isSome(report)) {
        writeFileSync(report.value, JSON.stringify(outcomes, null, 2));
      }
      for (const child of children) {
        expect(yield* child.isRunning).toBe(false);
      }
      return yield* Exit.isFailure(result) ? Effect.failCause(result.cause) : Effect.void;
    }).pipe(
      Effect.timeout('420 seconds'),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeHttpClient.layerNodeHttp,
          Reactivity.layer,
          makeDatabaseIdentityEnrollmentLive(SHELL_DATABASE_IDENTITY_ENROLLMENT),
        ),
      ),
    ),
  480_000,
);
