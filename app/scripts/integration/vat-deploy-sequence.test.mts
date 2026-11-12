/**
 * The VAT deploy on stage, in the order stage runs it, on one private database and the shared SpiceDB:
 *
 * 1. A fresh clone of the deployed database (`vat-deploy-rehearsal.sh`) gets the stage-shaped Merchandise rows the code
 *    before classifications wrote (21/12/10 %, stored gross not net × rate, tiers, variants, a EUR market); then the
 *    deploy's migrations run exactly as `db:migrate` runs them: Core's convergence (with the two access-fence
 *    migrations), Tax, Finance Billing and Merchandise (its classification migration on those rows).
 * 2. Tax is not installed for the tenant yet: storefront reads answer byte for byte what they answered before, and the
 *    same storefront order is placed with the same lines and totals. Merchandise asks Tax through the delegated module
 *    call and the Shell says the module is not installed; the migrated rates serve.
 * 3. The release module-install step runs (Core's `installReleaseTenantModules` with the stage list's entry for this
 *    tenant): `commerce.tax` is installed as the platform and the tenant is projected, so the owner's tax rights become
 *    effective. Before it, the seed's own reads are refused.
 * 4. The baseline seed runs through its own planner (`runTaxBaseline`) as the owner: dry-run, apply with the reviewed
 *    fingerprint, verify; every write is Tax's own Action through Tax's deployment root and its real access gate.
 * 5. A staff read syncs Merchandise with Tax by itself; storefront reads still answer the same bytes, except that BOOK-IT
 *    (stored at 10 %, now reduced) shows 12 %; no price changes.
 * 6. Finance reads Tax for an invoice line: before the seed its line is refused (no declared regime); after it the line
 *    picks a classification and stores the Tax rule revision, for an invoice dated 1 January 2024 (Prague) and today.
 *
 * 7. With `ONTOS_VAT_BUILT_APP` naming the app folder of a built export (both units built and given their in-process
 *    entry by `scripts/zerops/owner-entry.mts`), the release's Merchandise is that BUILT unit: the owners process
 *    (`scripts/zerops/serve-units.mts`) serves it with an environment that holds no key, the host hands its module key
 *    over on the process's private channel (fd 3), and a staff read over HTTP asks Tax through the Shell with that key
 *    and stores Tax's answer.
 *
 * Merchandise's own runtime runs in process for steps 1 to 6 (its native read runtime and its owner write path); Tax
 * runs as its deployment root; the Shell's delegated issuance is stood in for by a handler that decides as the real
 * issuer does (module key, a valid source assertion, both modules installed, else the Shell's own "not installed"
 * problem). In step 7 a loopback ingress puts the active release, that handler and Tax's API in front of the built
 * process, as the app host's Shell does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { holdTestModuleCredentials } from '../../packages/core-runtime/tests/support/module-credentials.ts';
import { startNativeHttpServer } from '../../apps/shell-super-app/tests/support/native-http-server.ts';
import { startHostedOwnerWithHandover } from '../../apps/shell-super-app/tests/support/server-owner-relay-native-fixture.ts';

import {
  canonicalizeApplicationComposition,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
  makeDatabaseIdentityEnrollmentLive,
  trustVerifiedGatewayPrincipalContext,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { NativeReadTestOwnerRegistration, makeNativeReadTestContext } from '@app/core-runtime/testing/native-reads';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_MODULE_NOT_INSTALLED_TYPE,
  GatewayDelegatedContextRequestSchema,
  shellGatewayContextContract,
} from '@app/shared-contracts';
import type { ActiveApplicationCompositionSnapshot, TrustedPrincipalContext } from '@app/core-runtime';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpClient, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  Clock,
  Config,
  ConfigProvider,
  Crypto,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schedule,
  Schema,
  Scope,
} from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { FetchHttpClient, HttpBody, HttpClient, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { ChildProcess } from 'effect/process';
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from 'jose';

import { AccessReleaseStoreLive } from '../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import {
  makeAccessProjectionCompiler,
  makeAccessProjectionTransport,
} from '../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
} from '../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { AccessProjectionCompiler } from '../../packages/core-runtime/src/access/intent/projection-compiler.ts';
import { AccessProjectionWriterLive } from '../../packages/core-runtime/src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import { CoreDatabaseLive } from '../../packages/core-runtime/src/db/client.ts';
import { DatabaseConfig, parseDatabaseConfig } from '../../packages/core-runtime/src/db/config.ts';
import { installReleaseTenantModules } from '../../packages/core-runtime/src/install/release-tenant-modules.ts';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { loadSpiceDbConfig } from '../../packages/core-runtime/src/permissions/config.ts';
import { makeTestDatabaseFromClient, makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { lineVatIssue, lineVatOf, pragueDayStart } from '../../verticals/finance-billing/shared/domain/line-vat.ts';
import { ultramodernApiMarker as financeMarker } from '../../verticals/finance-billing/shared/ultramodern-build.ts';
import { FinanceTaxRates, FinanceTaxRatesLive } from '../../verticals/finance-billing/src/integrations/tax-rates.ts';
import { financeBillingRegistration } from '../../verticals/finance-billing/vertical.registration.ts';
import {
  MerchandiseCommandPayloadSchema,
  StorefrontOrderResultSchema,
} from '../../verticals/merchandise/shared/actions/apply-command.ts';
import { recordsDeclaration } from '../../verticals/merchandise/shared/access-declarations.ts';
import { RecordsResponseSchema } from '../../verticals/merchandise/shared/apis/records.ts';
import type { RecordsRequestEncoded } from '../../verticals/merchandise/shared/apis/records.ts';
import { ultramodernApiMarker as merchandiseMarker } from '../../verticals/merchandise/shared/ultramodern-build.ts';
import { recordsRead } from '../../verticals/merchandise/src/api/records.read.ts';
import { merchandiseRelations } from '../../verticals/merchandise/src/database/schema.ts';
import {
  persistenceService,
  prepareCommandTax,
  prepareStaffTaxRates,
} from '../../verticals/merchandise/src/services/persistence.service.ts';
import { TAX_RATE_FRESHNESS, currentTaxRateBook } from '../../verticals/merchandise/src/services/tax-rates.ts';
import { merchandiseRegistration } from '../../verticals/merchandise/vertical.registration.ts';
import {
  INFORMATIONAL_GROSS,
  JACKET_GROSS,
  VAT_TRANSITION_VIEWS,
  expectJacketAtVariantPrice,
  withBookItAt,
} from '../../verticals/merchandise/tests/support/vat-transition-fixture.ts';
import { governedReadApiHandlersLive as taxHandlersLive } from '../../verticals/tax/api/index.ts';
import { taxApi } from '../../verticals/tax/shared/api.ts';
import { ultramodernApiMarker as taxMarker } from '../../verticals/tax/shared/ultramodern-build.ts';
import { executeApplicableTaxRuleSetWithAuthorization } from '../../verticals/tax/src/api/applicable-tax-rule-set-client.ts';
import { executeCreateTaxRuleWithAuthorization } from '../../verticals/tax/src/api/create-tax-rule-action-client.ts';
import { executeDeclareSellerVatRegimeWithAuthorization } from '../../verticals/tax/src/api/declare-seller-vat-regime-action-client.ts';
import { executeSellerVatRegimeAtInstantWithAuthorization } from '../../verticals/tax/src/api/seller-vat-regime-at-instant-client.ts';
import { publishedTaxComposition } from '../../verticals/tax/tests/support/published-tax-composition.ts';
import {
  TAX_BASELINE_EFFECTIVE_FROM,
  runTaxBaseline,
  taxBaselineRights,
  toDeclareAnswer,
  toRegimeObservation,
  toRuleObservation,
} from '../demo/seed-tax-baseline.mts';
import type { TaxBaselineCompanyPort, TaxBaselineTenantPort } from '../demo/seed-tax-baseline.mts';
import { sellingModuleKeys, taxModuleKey } from '../demo/stage-tenant-modules.mts';
import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';
import { encodeModuleCredentialHandover } from '../zerops/module-credentials.mts';

const COMPOSITION_URL = 'https://composition.vat-deploy.test/active';
const SHELL_ORIGIN = 'https://shell.vat-deploy.test';
const TAX_ORIGIN = 'https://tax.vat-deploy.test';
const SHELL_GATEWAY_BASE_URL = `${SHELL_ORIGIN}${shellGatewayContextContract.apiPrefix}`;
const DELEGATION_PATH = `${shellGatewayContextContract.apiPrefix}/auth/delegated/gateway-context`;
const TAX_PREFIX = '/tax-api';
const MERCHANDISE_KEY = 'merchandise-module-key-for-the-deploy-sequence';
const FINANCE_KEY = 'finance-module-key-for-the-deploy-sequence';
const TAX_CLASSIFICATION = '20261112010127_tax-classification';
const GATEWAY_FORBIDDEN_TYPE = 'https://ontos.dev/problems/gateway-forbidden';
const SEED_CORRELATION = 'vat-deploy-seed';
const OUTGOING = 'OUTGOING' as const;
const STANDARD = 'cz.vat.standard' as const;
const OWNER_MIGRATION = ['exec', 'drizzle-kit', 'migrate', '--config', 'drizzle.config.ts'] as const;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const FixtureSchema = Schema.Struct({
  after: Schema.Record(Schema.String, Schema.Json),
  before: Schema.Record(Schema.String, Schema.Json),
  jacketOrder: Schema.Struct({ command: Schema.Json, storefrontOrder: Schema.Json }),
  order: Schema.Struct({ command: Schema.Json, storefrontOrder: Schema.Json }),
  rows: Schema.Record(Schema.String, Schema.Array(Schema.Record(Schema.String, Schema.Json))),
});
/** The deploy-transition fixture the code before classifications wrote (see the Merchandise transition suite). */
const fixture = Schema.decodeUnknownSync(Schema.fromJsonString(FixtureSchema))(
  readFileSync(here('../../verticals/merchandise/tests/fixtures/vat-transition-pre-migration.json'), 'utf-8'),
);
const TABLES = [
  'catalog_heads',
  'categories',
  'products',
  'product_variants',
  'price_tiers',
  'stock_movements',
  'orders',
  'market_settings',
  'market_product_offers',
] as const;
const views = VAT_TRANSITION_VIEWS;

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Json);
const decodeResponses = Schema.decodeUnknownSync(JsonRecordSchema);
const encodeResponse = Schema.encodeSync(RecordsResponseSchema);
/** The encoded response without the per-run identities (the actor and the catalog revision). */
const comparable = (response: typeof RecordsResponseSchema.Type) => {
  const { actorPrincipalRef: _actor, revision: _revision, ...rest } = encodeResponse(response);
  void _actor;
  void _revision;
  return rest;
};

const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digest = (document: string) => bytesToHex(sha256(utf8ToBytes(document)));

/**
 * Merchandise, Tax and Finance Billing, each at its own build marker, in one validated release; Merchandise at the
 * built unit's marker when step 7 runs it.
 */
const compositionSnapshot = Effect.fn('VatDeploy.composition')(function* compositionSnapshot(
  merchandiseBuildMarker: string,
) {
  const merchandise = yield* makeOwnerApplicationCompositionFixture({
    appId: merchandiseMarker.appId,
    buildMarker: merchandiseBuildMarker,
    ownerRegistration: merchandiseRegistration,
  });
  const finance = yield* makeOwnerApplicationCompositionFixture({
    appId: financeMarker.appId,
    buildMarker: financeMarker.buildMarker,
    ownerRegistration: financeBillingRegistration,
  });
  const tax = yield* publishedTaxComposition;
  const composition = {
    ...merchandise.snapshot.composition,
    modules: [
      ...merchandise.snapshot.composition.modules,
      ...finance.snapshot.composition.modules,
      ...tax.snapshot.composition.modules,
    ],
    revision: '0'.repeat(64),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...merchandise.snapshot,
    composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
  });
});

const ClockRowSchema = Schema.Struct({ now: Schema.DateTimeUtcFromString });
const databaseNow = (admin: PgClient.PgClient) =>
  admin.unsafe(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`).pipe(
    Effect.flatMap(([row]) => Schema.decodeUnknownEffect(ClockRowSchema)(row)),
    Effect.map(({ now }) => now),
    Effect.orDie,
  );

const UPSERT_AUTHORITY =
  "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) values ('active', $1, 'active', 'open', $2::timestamptz, '[]'::jsonb, $3::timestamptz) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, durable_work_admission = excluded.durable_work_admission, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json, updated_at = excluded.updated_at";

const GatewayPrivateJwkSchema = Schema.fromJsonString(
  Schema.Struct({
    alg: Schema.String,
    crv: Schema.String,
    d: Schema.String,
    kid: Schema.String,
    kty: Schema.String,
    x: Schema.String,
  }),
);
const GatewayPublicJwksSchema = Schema.fromJsonString(
  Schema.Struct({ keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
);
/** The principal a gateway assertion names, exactly as the gateway signs it. */
const AssertionPrincipalSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  authContextRef: Schema.String,
  authenticationNamespaceId: AuthenticationNamespaceIdSchema,
  authMethod: Schema.Literals(['session', 'api_key']),
  legalEntityId: LegalEntityIdSchema,
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});
type AssertionPrincipal = typeof AssertionPrincipalSchema.Type;
const SourceClaimsSchema = Schema.Struct({ principal: AssertionPrincipalSchema });

interface CallingModule {
  readonly appId: string;
  readonly buildMarker: string;
  readonly principalId: string;
}

/** The deployment's gateway key: what the Shell signs staff and module-call assertions with. */
const makeGateway = Effect.fn('VatDeploy.gateway')(function* makeGateway(admin: PgClient.PgClient) {
  const issuer = yield* Config.String('ONTOS_GATEWAY_ISSUER');
  const jwk = yield* Config.schema(GatewayPrivateJwkSchema, 'ONTOS_GATEWAY_PRIVATE_JWK');
  const jwks = yield* Config.schema(GatewayPublicJwksSchema, 'ONTOS_GATEWAY_PUBLIC_JWKS');
  const key = yield* Effect.promise(() => importJWK(jwk, 'EdDSA'));
  const keySet = createLocalJWKSet({ keys: jwks.keys.map((entry) => ({ ...entry })) });
  const sign = Effect.fn('VatDeploy.sign')(function* sign(input: {
    readonly actor?: CallingModule;
    readonly audience: string;
    readonly principal: AssertionPrincipal;
    readonly revision: string;
    readonly targetBuildMarker: string;
  }) {
    const issuedAt = Math.floor(DateTime.toEpochMillis(yield* databaseNow(admin)) / 1000);
    const jti = yield* uuid;
    const base = {
      compositionRevision: input.revision,
      principal: input.principal,
      targetBuildMarker: input.targetBuildMarker,
    };
    const claims =
      input.actor === undefined
        ? { ...base, ver: EXTERNAL_GATEWAY_ASSERTION_VERSION }
        : { ...base, act: input.actor, ver: DELEGATED_GATEWAY_ASSERTION_VERSION };
    const token = yield* Effect.promise(() =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })
        .setAudience(input.audience)
        .setIssuer(issuer)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
        .setJti(jti)
        .setSubject(input.principal.principalId)
        .sign(key),
    );
    return { expiresAt: issuedAt + GATEWAY_ASSERTION_TTL_SECONDS, token };
  });
  const sourcePrincipal = (assertion: string, audience: string) =>
    Effect.promise(() => jwtVerify(assertion, keySet, { audience, issuer })).pipe(
      Effect.flatMap(({ payload }) => Schema.decodeUnknownEffect(SourceClaimsSchema)(payload)),
      Effect.map(({ principal }) => principal),
    );
  return { sign, sourcePrincipal };
});
type Gateway = Effect.Success<ReturnType<typeof makeGateway>>;

const problem = (type: string, title: string) =>
  HttpServerResponse.jsonUnsafe(
    { _tag: 'GatewayForbiddenProblem', detail: title, status: 403, title, type },
    { contentType: 'application/problem+json', status: 403 },
  );
const forbidden = () => problem(GATEWAY_FORBIDDEN_TYPE, 'Gateway context forbidden');

interface Caller {
  readonly module: CallingModule;
  readonly moduleKey: string;
}

/**
 * The Shell's delegated issuance as the real issuer decides it: the calling module's own key, a valid source assertion
 * for that module, the calling module installed for the subject's tenant and the called one too, else the Shell's
 * own "not installed" problem; it then signs the module-call assertion for Tax.
 */
const delegationHandler = (input: {
  readonly admin: PgClient.PgClient;
  readonly callers: ReadonlyMap<string, Caller>;
  readonly gateway: Gateway;
  /** The calling app of every module-call assertion issued, in order. */
  readonly issued: string[];
  readonly revision: string;
}) =>
  Effect.gen(function* delegation() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const caller = input.callers.get(request.headers['x-api-key'] ?? '');
    if (caller === undefined) {
      return forbidden();
    }
    const payload = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
    );
    if (payload.subject._tag !== 'Assertion' || payload.audience !== taxMarker.appId) {
      return forbidden();
    }
    const principal = yield* input.gateway.sourcePrincipal(
      Redacted.value(payload.subject.sourceAssertion),
      caller.module.appId,
    );
    const installed = yield* input.admin.unsafe<{ readonly module_key: string }>(
      "select module_key from core.tenant_module_states where tenant_id = $1 and state = 'active'",
      [principal.tenantId],
    );
    const keys = new Set(installed.map((row) => row.module_key));
    if (!keys.has(caller.moduleKey)) {
      return forbidden();
    }
    if (!keys.has(taxModuleKey)) {
      return problem(GATEWAY_MODULE_NOT_INSTALLED_TYPE, 'Module not installed');
    }
    const issued = yield* input.gateway.sign({
      actor: caller.module,
      audience: taxMarker.appId,
      principal,
      revision: input.revision,
      targetBuildMarker: taxMarker.buildMarker,
    });
    input.issued.push(caller.module.appId);
    return HttpServerResponse.jsonUnsafe({
      apiBaseUrl: TAX_PREFIX,
      compositionRevision: input.revision,
      expiresAt: issued.expiresAt,
      token: issued.token,
    });
  });

/** The real clock moved forward by `offset`; sleeps stay real. */
const shiftedClock = (real: Clock.Clock, offset: Duration.Duration): Clock.Clock => {
  const millis = () =>
    DateTime.toEpochMillis(DateTime.addDuration(DateTime.makeUnsafe(real.currentTimeMillisUnsafe()), offset));
  return {
    currentTimeMillis: Effect.sync(millis),
    currentTimeMillisUnsafe: millis,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(millis()) * 1_000_000n,
    monotonicTimeNanos: real.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
    sleep: (duration) => real.sleep(duration),
  };
};

/** One owner's migrations, exactly as the deploy's `db:migrate` runs them in that owner's folder. */
const migrateAsDeploy = Effect.fn('VatDeploy.migrate')(function* migrateAsDeploy(
  owner: string,
  executable: string,
  args: readonly string[],
) {
  const migrated = yield* collectToolingProcess(
    ChildProcess.make(executable, args, {
      cwd: here(`../../${owner}/`),
      extendEnv: true,
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    }),
  ).pipe(Effect.scoped, Effect.timeout('300 seconds'));
  expect([owner, migrated.status, migrated.stderr]).toEqual([owner, 0, migrated.stderr]);
});

/**
 * A calling module's deployment settings: the Shell and the active release. Its own module key is never a setting: the
 * test holds each caller's key in its own store copy, as the host hands it over (`holdTestModuleCredentials`).
 */
const settings = ConfigProvider.orElse(
  ConfigProvider.fromUnknown({
    ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_URL,
    ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE_URL,
  }),
  ConfigProvider.fromEnv(),
);

type RootHandler = ReturnType<ReturnType<typeof assembleEffectBffRuntime>['createHandler']>;
type ShellHandler = ReturnType<
  ReturnType<typeof HttpEffect.toWebHandlerWith<Crypto.Crypto, HttpServerRequest.HttpServerRequest | Crypto.Crypto>>
>;

/** Every request of the scenario: the active release, the stand-in Shell and Tax's deployment root. */
const routeThrough =
  (snapshot: ActiveApplicationCompositionSnapshot, shell: ShellHandler, roots: ReadonlyMap<'tax', RootHandler>) =>
  (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const tax = roots.get('tax');
    if (request.url === COMPOSITION_URL) {
      return Promise.resolve(Response.json(snapshot));
    }
    if (url.origin === SHELL_ORIGIN && url.pathname === DELEGATION_PATH) {
      return shell(request);
    }
    if (tax !== undefined && url.origin === SHELL_ORIGIN && url.pathname.startsWith(TAX_PREFIX)) {
      return tax.handler(new Request(`${SHELL_ORIGIN}${url.pathname.slice(TAX_PREFIX.length)}${url.search}`, request));
    }
    if (tax !== undefined && url.origin === TAX_ORIGIN) {
      return tax.handler(request);
    }
    return Promise.resolve(new Response('No route in the fixture', { status: 502 }));
  };

/** Tax's deployment root on the scenario's database, and the fetch every module's request goes through. */
const serveTax = Effect.fn('VatDeploy.serveTax')(function* serveTax(
  snapshot: ActiveApplicationCompositionSnapshot,
  shell: ShellHandler,
) {
  const roots = new Map<'tax', RootHandler>();
  const route = routeThrough(snapshot, shell, roots);
  const fetchThroughRoots = (input: RequestInfo | URL, init?: RequestInit) => route(new Request(input, init));
  const tax = yield* Effect.acquireRelease(
    Effect.sync(() =>
      assembleEffectBffRuntime({
        api: taxApi,
        handlers: taxHandlersLive.pipe(
          Layer.provide(
            Layer.mergeAll(ConfigProvider.layer(settings), Layer.succeed(FetchHttpClient.Fetch, fetchThroughRoots)),
          ),
          Layer.orDie,
        ),
      }).createHandler(),
    ),
    (root) => Effect.promise(() => root.dispose()),
  );
  roots.set('tax', tax);
  rs.stubGlobal('fetch', fetchThroughRoots);
  yield* Effect.addFinalizer(() => Effect.sync(() => rs.unstubAllGlobals()));
  return fetchThroughRoots;
});

/** The release step's own runtime (as `release-tenant-modules.mts` composes it) on the scenario's database. */
const releaseRuntimeOf = (runtimeUrl: string) =>
  Layer.unwrap(
    Effect.gen(function* releaseRuntime() {
      const configuration = yield* parseDatabaseConfig({ DATABASE_URL: runtimeUrl }).pipe(Effect.orDie);
      const spiceDb = yield* loadSpiceDbConfig().pipe(Effect.orDie);
      const coreDatabase = Layer.mergeAll(
        CoreDatabaseLive.pipe(Layer.provide(Layer.succeed(DatabaseConfig, configuration))),
        makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])),
      );
      const engine = Layer.effect(
        AccessProjectionCompiler,
        Effect.acquireRelease(
          Effect.sync(() => makeAccessProjectionTransport(spiceDb)),
          (transport) => Effect.sync(() => transport.close()),
        ).pipe(Effect.map(makeAccessProjectionCompiler)),
      );
      const stores = Layer.mergeAll(TenantIntentLoaderLive, AccessWriteJournalStoreLive, AccessReleaseStoreLive).pipe(
        Layer.provideMerge(Layer.merge(coreDatabase, engine)),
      );
      return Layer.mergeAll(stores, AccessProjectionWriterLive.pipe(Layer.provide(stores)));
    }),
  );

/** A refused tax call in the seed's vocabulary: a missing right for 401/403, otherwise a conflict, by the problem. */
const taxCallRefused = (cause: unknown) => {
  const detail = Predicate.hasProperty(cause, '_tag') ? String(cause._tag) : 'refused';
  const missingRight = Predicate.hasProperty(cause, 'status') && (cause.status === 401 || cause.status === 403);
  return {
    _tag: 'TaxCallRefused' as const,
    refusal: { _tag: missingRight ? 'MissingRight' : 'Conflict', detail } as const,
  };
};

type TaxCall = <A, E>(
  run: (
    authorization: string,
    options: { readonly baseUrl: string; readonly compositionRevision: string },
  ) => Effect.Effect<A, E>,
) => Effect.Effect<A, ReturnType<typeof taxCallRefused>>;

/** The seed's company port over Tax's deployment root, each call with a fresh staff assertion of the owner for Tax. */
const seedPortOf = (taxCall: TaxCall): TaxBaselineCompanyPort => ({
  applicableRules: (taxClassificationCode, at) =>
    taxCall((authorization, options) =>
      executeApplicableTaxRuleSetWithAuthorization(
        { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode, taxRelevantTime: at },
        authorization,
        SEED_CORRELATION,
        options,
      ),
    ).pipe(Effect.map(toRuleObservation)),
  // The Shell's "Proč?" explain is not part of this chain: Tax's own gate decides every call.
  checkRight: () => Effect.succeed({ _tag: 'Allowed' as const }),
  createRule: (payload, idempotencyKey) =>
    taxCall((authorization, options) =>
      executeCreateTaxRuleWithAuthorization(payload, authorization, SEED_CORRELATION, { ...options, idempotencyKey }),
    ).pipe(Effect.map(({ created }) => ({ created }))),
  declareRegime: (payload, idempotencyKey) =>
    taxCall((authorization, options) =>
      executeDeclareSellerVatRegimeWithAuthorization(payload, authorization, SEED_CORRELATION, {
        ...options,
        idempotencyKey,
      }),
    ).pipe(Effect.map(toDeclareAnswer)),
  regimeAt: (instant) =>
    taxCall((authorization, options) =>
      executeSellerVatRegimeAtInstantWithAuthorization({ instant }, authorization, SEED_CORRELATION, options),
    ).pipe(Effect.map(toRegimeObservation)),
});

/** The deployed database with the stage-shaped rows, migrated as the deploy migrates it. */
const deployOnStageRows = Effect.fn('VatDeploy.deploy')(function* deployOnStageRows() {
  const connections = yield* loadDatabaseConnectionPair();
  const database = { admin: connections.admin.connectionString, runtime: connections.runtime.connectionString };
  const adminPg = yield* makeTestPgClient(database.admin, { maxConnections: 2 });
  const [merchandiseMigration] = yield* adminPg
    .unsafe<{ readonly applied: boolean }>(
      `select exists (select 1 from drizzle.__drizzle_migrations_demo_merchandise where name = '${TAX_CLASSIFICATION}') as applied`,
    )
    .pipe(Effect.orDie);
  expect(
    merchandiseMigration?.applied,
    'The rehearsal needs a fresh clone of the deployed database: Merchandise must not have its classification migration yet',
  ).toBe(false);
  const allowAll = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'ALLOWED' } });
  const native = yield* makeNativeReadTestContext({
    accessDecision: allowAll.bound,
    connections: {
      admin: { connectionString: Redacted.make(database.admin) },
      runtime: { connectionString: Redacted.make(database.runtime) },
    },
    contextPermissions: [],
    moduleId: 'demo.merchandise',
    ownerFixtureRetention: 'retain-complete-context',
  }).pipe(
    Effect.provideService(NativeReadTestOwnerRegistration, merchandiseRegistration),
    // The deploy leaves audit, invocation and access rows naming this tenant; the rehearsal's clone is dropped with all
    // of them afterwards, so the fixture's own row cleanup is never run.
    Scope.provide(yield* Scope.make()),
  );
  const { legalEntityId, tenantId } = native.principal;
  const companyId = legalEntityId ?? '';
  const rowsOf = (table: (typeof TABLES)[number]) =>
    JSON.stringify(
      (fixture.rows[table] ?? []).map((row) => ({ ...row, legal_entity_id: companyId, tenant_id: tenantId })),
    );
  yield* Effect.forEach(
    TABLES,
    (table) =>
      adminPg.unsafe(
        `insert into demo_merchandise.${table} select * from jsonb_populate_recordset(null::demo_merchandise.${table}, $1::jsonb)`,
        [rowsOf(table)],
      ),
    { concurrency: 1, discard: true },
  );
  yield* migrateAsDeploy('packages/core-runtime', 'node', ['../../scripts/migration-convergence-cli.mts', 'core']);
  yield* migrateAsDeploy('verticals/tax', 'pnpm', OWNER_MIGRATION);
  yield* migrateAsDeploy('verticals/finance-billing', 'pnpm', OWNER_MIGRATION);
  yield* migrateAsDeploy('verticals/merchandise', 'pnpm', OWNER_MIGRATION);
  // The selling modules are installed for the tenant; Tax is not yet.
  yield* Effect.forEach(
    sellingModuleKeys,
    (moduleKey) =>
      adminPg.unsafe(
        "insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $2, 'active') on conflict do nothing",
        [tenantId, moduleKey],
      ),
    { concurrency: 1, discard: true },
  );
  return { adminPg, allowAll, companyId, database, native, tenantId };
});

const BuiltUnitSchema = Schema.fromJsonString(
  Schema.Struct({ deliveryUnit: Schema.Struct({ appId: Schema.Literal('merchandise'), buildMarker: Schema.String }) }),
);

/** The built Merchandise unit of a built export (`ONTOS_VAT_BUILT_APP` names its app folder), when step 7 is asked for. */
const builtMerchandise = Effect.gen(function* builtMerchandise() {
  const app = yield* Config.option(Config.String('ONTOS_VAT_BUILT_APP'));
  if (Option.isNone(app)) {
    return Option.none<{ readonly buildMarker: string; readonly directory: string; readonly workspace: string }>();
  }
  const directory = `${app.value}/verticals/merchandise`;
  const fileSystem = yield* FileSystem.FileSystem;
  const { deliveryUnit } = yield* fileSystem
    .readFileString(`${directory}/.output/ultramodern-build.json`)
    .pipe(Effect.flatMap(Schema.decodeEffect(BuiltUnitSchema)), Effect.orDie);
  return Option.some({ buildMarker: deliveryUnit.buildMarker, directory, workspace: app.value });
});
type BuiltMerchandise = Option.Option.Value<Effect.Success<typeof builtMerchandise>>;

/**
 * 7. The release's BUILT Merchandise, served as the app host serves it: the owners process claims the unit before it
 *    loads, its environment holds no key, and its module key arrives only on its private channel (fd 3). Its first staff
 *    read asks Tax through the Shell with that key (the Shell issues the module-call assertion for Merchandise's built
 *    release) and stores Tax's answer.
 */
const builtMerchandiseReadsTax = Effect.fn('VatDeploy.builtMerchandise')(function* builtMerchandiseReadsTax(input: {
  readonly adminPg: PgClient.PgClient;
  readonly built: BuiltMerchandise;
  readonly companyId: string;
  /** The app host's loopback ingress in front of the active release, the Shell and Tax. */
  readonly ingress: { readonly origin: string };
  readonly issued: readonly string[];
  readonly revision: string;
  readonly staffToken: Effect.Effect<string, never, Crypto.Crypto>;
  readonly tenantId: string;
}) {
  const { ingress } = input;
  const merchandise = yield* startHostedOwnerWithHandover({
    appId: 'merchandise',
    compositionUrl: `${ingress.origin}/active`,
    gateway: {
      issuer: yield* Config.String('ONTOS_GATEWAY_ISSUER'),
      publicJwks: yield* Config.String('ONTOS_GATEWAY_PUBLIC_JWKS'),
    },
    relativeDirectory: input.built.directory,
    shellGatewayBaseUrl: `${ingress.origin}${shellGatewayContextContract.apiPrefix}`,
    workspaceDirectory: input.built.workspace,
  });
  expect(merchandise.buildMarker).toBe(input.built.buildMarker);
  yield* merchandise.handOver(
    yield* encodeModuleCredentialHandover({ merchandise: Redacted.make(MERCHANDISE_KEY) }, ['merchandise']),
  );
  expect(yield* merchandise.received).toBe('merchandise');

  const client = yield* HttpClient.HttpClient;
  const staffRead = Effect.gen(function* builtStaffRead() {
    const response = yield* client.post(`${merchandise.origin}/merchandise-api/reads/records`, {
      body: yield* HttpBody.json({ view: { limit: 0, ordersLimit: 0, summary: true } }),
      headers: {
        authorization: `Bearer ${yield* input.staffToken}`,
        'x-correlation-id': yield* uuid,
        'x-ontos-composition-revision': input.revision,
      },
    });
    expect(response.status).toBe(200);
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordsResponseSchema)));
  });
  const syncedAt = input.adminPg
    .unsafe<{ readonly synced: string | null }>(
      "select tax_rates ->> 'syncedAt' as synced from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2",
      [input.tenantId, input.companyId],
    )
    .pipe(
      Effect.map(([row]) => row?.synced ?? null),
      Effect.orDie,
    );
  const before = yield* syncedAt;
  const issuedBefore = input.issued.length;
  // The first read starts the refresh; a later one stores Tax's answer with the time Tax gave it.
  const stored = yield* staffRead.pipe(
    Effect.andThen(syncedAt),
    Effect.repeat({ schedule: Schedule.spaced('1 second'), times: 20, until: (synced) => synced !== before }),
  );
  expect(stored).not.toBe(before);
  // Every module-call assertion the Shell issued meanwhile went to Merchandise's key, which only fd 3 carried.
  expect(input.issued.slice(issuedBefore).length).toBeGreaterThan(0);
  expect(input.issued.slice(issuedBefore).every((app) => app === 'merchandise')).toBe(true);
  const records = yield* staffRead;
  expect([records.sellerVatRegime, records.taxRatesSource]).toEqual(['VAT_PAYER', 'TAX']);
  expect(records.taxRates?.map((rate) => [rate.code, rate.ratePercent])).toEqual([
    [STANDARD, 21],
    ['cz.vat.reduced', 12],
  ]);
  // The process never printed the key.
  expect(merchandise.diagnostics.filter((line) => Redacted.value(line).includes(MERCHANDISE_KEY))).toEqual([]);
});

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

/**
 * The rehearsal runs the deploy's migrations on the database it is given, so it runs only when asked to, against a
 * fresh clone of the deployed database (`scripts/integration/vat-deploy-rehearsal.sh` sets both).
 */
const rehearsalRequested = Config.Boolean('ONTOS_VAT_DEPLOY_REHEARSAL').pipe(Config.withDefault(false));

/** The whole sequence, step by step. */
const vatDeploySequence = Effect.fn('VatDeploy.sequence')(function* vatDeploySequence() {
  // 1. The deploy: migrations on the stage-shaped rows.
  const { adminPg, allowAll, companyId, database, native, tenantId } = yield* deployOnStageRows();
  const built = yield* builtMerchandise;
  // Merchandise and Finance call Tax with their own keys, handed over as the host hands them.
  yield* holdTestModuleCredentials({ 'finance-billing': FINANCE_KEY, merchandise: MERCHANDISE_KEY });

  // The release, the gateway, the stand-in Shell and Tax's deployment root on this database.
  const merchandiseBuildMarker = Option.match(built, {
    onNone: () => merchandiseMarker.buildMarker,
    onSome: (unit) => unit.buildMarker,
  });
  const snapshot = yield* compositionSnapshot(merchandiseBuildMarker);
  const { revision } = snapshot.composition;
  const now = yield* databaseNow(adminPg);
  yield* adminPg.unsafe(UPSERT_AUTHORITY, [
    revision,
    DateTime.formatIso(DateTime.add(now, { hours: 1 })),
    DateTime.formatIso(now),
  ]);
  const gateway = yield* makeGateway(adminPg);
  const merchandiseModule: CallingModule = {
    appId: merchandiseMarker.appId,
    buildMarker: merchandiseBuildMarker,
    principalId: yield* uuid,
  };
  const financeModule: CallingModule = {
    appId: financeMarker.appId,
    buildMarker: financeMarker.buildMarker,
    principalId: yield* uuid,
  };
  const issued: string[] = [];
  const shell = HttpEffect.toWebHandlerWith<Crypto.Crypto, HttpServerRequest.HttpServerRequest | Crypto.Crypto>(
    yield* Effect.context<Crypto.Crypto>(),
  )(
    delegationHandler({
      admin: adminPg,
      callers: new Map<string, Caller>([
        [MERCHANDISE_KEY, { module: merchandiseModule, moduleKey: 'demo.merchandise' }],
        [FINANCE_KEY, { module: financeModule, moduleKey: 'finance.billing' }],
      ]),
      gateway,
      issued,
      revision,
    }),
  );
  const fetchThroughRoots = yield* serveTax(snapshot, shell);
  /** A call as a calling module's deployment makes it: its settings, its own held key, every request through the roots. */
  const asModule = <A, E, R>(call: Effect.Effect<A, E, R>) =>
    call.pipe(
      Effect.provide(ConfigProvider.layer(settings)),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughRoots),
    );

  // The owner: the tenant's member the fixture created, signed in as staff of the company.
  const owner = native.principal;
  const assertionPrincipal = Schema.decodeUnknownSync(AssertionPrincipalSchema)({
    authBindingId: owner.authBindingId,
    authContextRef: owner.authContextRef,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: owner.authMethod,
    legalEntityId: companyId,
    principalId: owner.principalId,
    tenantId,
  });
  const signedIn = (audience: string, targetBuildMarker: string) =>
    gateway.sign({ audience, principal: assertionPrincipal, revision, targetBuildMarker });
  /** The owner's request scope in a module's deployment, verified there as the gateway redemption leaves it. */
  const scopeIn = (module: CallingModule, correlation: string) =>
    signedIn(module.appId, module.buildMarker).pipe(
      // The provenance belongs to the very scope object: it is trusted with its correlation already on it.
      Effect.map(({ token }) =>
        trustVerifiedGatewayPrincipalContext({ ...owner, correlationId: correlation }, revision, {
          assertion: Redacted.make(token),
          audience: module.appId,
        }),
      ),
    );
  // The owner's rights: the seed's four tax rights, as a role of the tenant, effective once Tax is installed; and the
  // Merchandise records read the built unit's own gate decides in step 7.
  yield* grantTestTenantRoleAccess({
    holders: [
      {
        capabilityKeys: [...Object.values(taxBaselineRights), recordsDeclaration.key],
        principalId: owner.principalId,
      },
    ],
    legalEntityIds: [companyId],
    spiceDb: yield* loadSpiceDbConfig().pipe(Effect.orDie),
    tenantId,
    writerConnectionString: Redacted.make(database.runtime),
  });

  const runtimeDb = yield* makeTestDatabaseFromClient(
    yield* makeTestPgClient(database.runtime, { maxConnections: 2 }),
    merchandiseRelations,
  );
  const read = (input: RecordsRequestEncoded, principal: TrustedPrincipalContext = owner) =>
    native.runtime
      .runRead({ input, principal, registration: recordsRead, transport: { correlationId: 'vat-deploy' } })
      .pipe(Effect.provide(native.layer), Effect.provideService(AccessDecisionGate, allowAll.accessDecision));
  const storefront = Effect.forEach(
    Object.entries(views),
    ([name, view]) => read(view).pipe(Effect.map((response) => [name, comparable(response)] as const)),
    { concurrency: 1 },
  ).pipe(Effect.map(Object.fromEntries));
  /** The fixture's storefront order, prepared (Tax asked through the delegated call) and written by Merchandise. */
  const placeOrder = Effect.fn('VatDeploy.placeOrder')(function* placeOrder(
    clientRequestId: string,
    entry: { readonly command: Schema.Json } = fixture.order,
  ) {
    const [head] = yield* adminPg.unsafe<{ readonly revision: number }>(
      'select revision from demo_merchandise.catalog_heads where tenant_id = $1 and legal_entity_id = $2',
      [tenantId, companyId],
    );
    const expectedRevision = head?.revision ?? 0;
    const { command } = Schema.decodeUnknownSync(Schema.Struct({ command: JsonRecordSchema }))(entry.command);
    const payload = Schema.decodeUnknownSync(MerchandiseCommandPayloadSchema)({
      command: { ...command, clientRequestId },
      expectedRevision,
    });
    const scope = yield* scopeIn(merchandiseModule, `vat-deploy-${clientRequestId}`);
    const prepared = yield* asModule(prepareCommandTax(payload.command, scope));
    const result = yield* runtimeDb.transaction((tx) =>
      installOperationalScope(tx, scope, defineDatabaseIdentityEnrollment([])).pipe(
        Effect.flatMap((scoped) =>
          persistenceService(scoped, {
            prepared: { actionInvocationId: scope.correlationId, payload, tax: prepared },
            scope,
          }),
        ),
        Effect.flatMap((services) => services.apply(payload.command, expectedRevision, scope.correlationId)),
      ),
    );
    const order = Predicate.hasProperty(result, 'storefrontOrder') ? result.storefrontOrder : undefined;
    return {
      order: Schema.encodeSync(Schema.UndefinedOr(StorefrontOrderResultSchema))(
        Schema.decodeUnknownSync(Schema.UndefinedOr(StorefrontOrderResultSchema))(order),
      ),
      prepared,
    };
  });

  // 2. Tax not installed: the same bytes, and the same order with the same lines and totals.
  const migrated = decodeResponses(yield* storefront);
  expect(migrated).toEqual(fixture.before);
  expectJacketAtVariantPrice(migrated);
  const placed = yield* placeOrder('vat-deploy-order-1');
  expect(placed.prepared.refused).toBe(true);
  const orderBefore = Schema.decodeUnknownSync(JsonRecordSchema)(fixture.order.storefrontOrder);
  expect(placed.order).toEqual({ ...orderBefore, orderId: placed.order?.orderId });
  // A jacket variant at 10 623,80 and the product with informational variants at its own price, as before.
  const jacket = yield* placeOrder('vat-transition-order-jacket', fixture.jacketOrder);
  const jacketBefore = Schema.decodeUnknownSync(JsonRecordSchema)(fixture.jacketOrder.storefrontOrder);
  expect(jacket.order).toEqual({ ...jacketBefore, orderId: jacket.order?.orderId });
  expect(jacket.order?.lines.map((sold) => sold.unitPriceMinor)).toEqual([JACKET_GROSS, INFORMATIONAL_GROSS]);
  const after = decodeResponses(yield* storefront);
  expect(after).toEqual(fixture.after);
  expectJacketAtVariantPrice(after);

  // The seed as the owner, through its own planner, against Tax's root.
  const taxCall: TaxCall = (run) =>
    signedIn(taxMarker.appId, taxMarker.buildMarker).pipe(
      Effect.flatMap(({ token }) => run(`Bearer ${token}`, { baseUrl: TAX_ORIGIN, compositionRevision: revision })),
      Effect.mapError(taxCallRefused),
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughRoots),
      Effect.provide(NodeCrypto.layer),
    );
  const companyPort = seedPortOf(taxCall);
  const tenant: TaxBaselineTenantPort = {
    companies: [
      {
        legalEntityId: Schema.decodeUnknownSync(LegalEntityIdSchema)(companyId),
        name: 'Native Read test entity',
      },
    ],
    company: () => Effect.succeed(companyPort),
    operatorPrincipalId: Schema.decodeUnknownSync(PrincipalIdSchema)(owner.principalId),
    tenantId: Schema.decodeUnknownSync(TenantIdSchema)(tenantId),
  };
  const allowed = new Map([[tenantId, 'Deploy rehearsal']]);
  const seed = (mode: 'apply' | 'dry-run' | 'verify', reviewed: Option.Option<string> = Option.none()) =>
    Effect.scoped(
      runTaxBaseline(mode, tenant, reviewed, { allowedTenants: allowed, companiesExpected: tenant.companies.length }),
    );

  // Finance reads Tax for the owner's invoice lines.
  const financeScope = yield* scopeIn(financeModule, 'vat-deploy-finance');
  const financeChoices = (on: string) =>
    asModule(
      Effect.gen(function* financeVatChoices() {
        const rates = yield* FinanceTaxRates;
        return yield* rates.choices(financeScope, on);
      }).pipe(Effect.provide(FinanceTaxRatesLive)),
    );
  const today = DateTime.formatIsoDateUtc(yield* DateTime.now);

  // 3. The release module-install step: Tax is installed as the platform and the tenant projected.
  const seedBeforeInstall = yield* Effect.exit(seed('dry-run'));
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition).pipe(Effect.orDie);
  const report = yield* installReleaseTenantModules({
    catalog,
    modules: [{ moduleKey: taxModuleKey, sellingModuleKeys, tenantId }],
    reconcileRetrySpacing: Duration.zero,
    runReference: revision,
  }).pipe(Effect.provide(releaseRuntimeOf(database.runtime)));
  expect(report.modules.map(({ moduleKey, outcome }) => [moduleKey, outcome])).toEqual([[taxModuleKey, 'installed']]);
  expect(report.reconciles.map(({ failure }) => failure)).toEqual([undefined]);
  // Before the install the seed could not even read Tax for the company.
  expect(seedBeforeInstall._tag).toBe('Failure');
  // Before the seed Finance's line is refused: the company has no declared regime in Tax.
  const line = { vatClassification: STANDARD, vatRate: 21 };
  expect(lineVatIssue(line, yield* financeChoices(today), OUTGOING)).toBe('vat_regime_not_declared');

  // 4. The baseline seed as the owner: dry-run, apply with the reviewed fingerprint, verify.
  const planned = yield* seed('dry-run');
  expect(planned.plan.writes.length).toBe(3);
  const seeded = yield* seed('apply', Option.some(planned.fingerprint));
  expect(seeded.outcomes.length).toBe(3);
  expect((yield* seed('verify')).plan.writes).toEqual([]);

  // 5. Staff reads sync Merchandise with Tax by themselves: the first starts the refresh, the next stores it. This
  //    process was refused (Tax not installed) before the release step and asks Tax again only after the whole
  //    twelve-minute window: the reads run that much later.
  const real = yield* Clock.Clock;
  const later = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Clock.Clock, shiftedClock(real, Duration.sum(TAX_RATE_FRESHNESS, Duration.seconds(1)))),
    );
  const staffScope = yield* scopeIn(merchandiseModule, 'vat-deploy-staff');
  yield* later(asModule(prepareStaffTaxRates(staffScope)));
  yield* later(asModule(currentTaxRateBook(staffScope)));
  const staffTax = yield* later(asModule(prepareStaffTaxRates(staffScope)));
  expect(staffTax.fetched?.book.regime).toBe('VAT_PAYER');
  const synced = yield* later(
    asModule(
      native.runtime
        .runRead({
          input: { view: { limit: 0, ordersLimit: 0, summary: true } },
          principal: owner,
          registration: recordsRead,
          transport: { correlationId: 'vat-deploy-staff' },
        })
        .pipe(Effect.provide(native.layer), Effect.provideService(AccessDecisionGate, allowAll.accessDecision)),
    ),
  );
  expect([synced.sellerVatRegime, synced.taxRatesSource]).toEqual(['VAT_PAYER', 'TAX']);
  expect(synced.taxRates?.map((rate) => [rate.code, rate.ratePercent, DateTime.formatIso(rate.effectiveFrom)])).toEqual(
    [
      [STANDARD, 21, TAX_BASELINE_EFFECTIVE_FROM],
      ['cz.vat.reduced', 12, TAX_BASELINE_EFFECTIVE_FROM],
    ],
  );
  // Storefront: the same bytes, except BOOK-IT, now reduced at 12 %; no price moved.
  const priced = decodeResponses(yield* later(storefront));
  expect(priced).toEqual(withBookItAt(fixture.after, 12));
  expectJacketAtVariantPrice(priced);
  const pricedJacket = yield* later(placeOrder('vat-deploy-order-jacket-priced', fixture.jacketOrder));
  expect(pricedJacket.order?.lines.map((sold) => sold.unitPriceMinor)).toEqual([JACKET_GROSS, INFORMATIONAL_GROSS]);

  // 6. Finance after the seed: the line picks the standard classification and stores Tax's rule revision, for an
  //    invoice dated today and one dated 1 January 2024 (the seed's Prague midnight).
  expect(DateTime.formatIso(pragueDayStart('2024-01-01') ?? DateTime.makeUnsafe(0))).toBe(TAX_BASELINE_EFFECTIVE_FROM);
  for (const on of [today, '2024-01-01']) {
    const choices = yield* financeChoices(on);
    const stored = lineVatOf({ code: STANDARD, kind: 'classification' }, choices);
    expect([on, stored?.vatRate, stored?.vatClassification, stored?.taxRuleRevisionRef !== undefined]).toEqual([
      on,
      21,
      STANDARD,
      true,
    ]);
    expect(lineVatIssue({ ...line, ...stored }, choices, OUTGOING)).toBeUndefined();
  }

  // 7. The built Merchandise of the release, its key only on fd 3, reads Tax through the Shell.
  if (Option.isSome(built)) {
    // The host's loopback ingress: the active release, the Shell's delegated issuance and Tax's API behind the Shell,
    // each request forwarded with its method, headers and body.
    const ingress = yield* startNativeHttpServer(async (request) => {
      const url = new URL(request.url);
      const target = url.pathname === '/active' ? COMPOSITION_URL : `${SHELL_ORIGIN}${url.pathname}${url.search}`;
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
      return await fetchThroughRoots(target, { body, headers: request.headers, method: request.method });
    });
    yield* builtMerchandiseReadsTax({
      adminPg,
      built: built.value,
      companyId,
      ingress,
      issued,
      revision,
      staffToken: signedIn(merchandiseModule.appId, merchandiseModule.buildMarker).pipe(
        Effect.map(({ token }) => token),
        Effect.orDie,
      ),
      tenantId,
    }).pipe(Effect.provide(NodeHttpClient.layerNodeHttp));
  }
});

it.layer(nativeServices, { excludeTestServices: true })('the VAT deploy, step by step as stage runs it', (suite) => {
  suite.effect(
    'migrations, an unchanged storefront without Tax, the release install, the seed, the first sync and Finance',
    () =>
      rehearsalRequested.pipe(
        Effect.flatMap((requested) =>
          requested
            ? Effect.scoped(vatDeploySequence())
            : Effect.logWarning('VAT deploy rehearsal not requested (run scripts/integration/vat-deploy-rehearsal.sh)'),
        ),
      ),
    600_000,
  );
});
