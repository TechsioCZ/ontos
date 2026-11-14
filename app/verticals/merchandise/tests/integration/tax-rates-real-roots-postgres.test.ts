/*
 * Merchandise prices with Tax's rates, end to end through both deployment roots on PostgreSQL and SpiceDB:
 *
 * - a Tax author records the company's rules and VAT regime through Tax's Actions;
 * - staff create products by classification and read them (admin view with `taxRates`, storefront view with
 *   `vatRate`) through Merchandise's root, which reads Tax through the delegated module call;
 * - the registered Storefront client places orders through Merchandise's root: a classification without a rule is
 *   refused with a clear message, a rule added later sells after a resync, and the order lines keep the rate, the
 *   classification and the Tax rule revision;
 * - a tenant without Tax installed cannot sell at all.
 *
 * The Shell's delegated-context issuer is stood in for by a fixture that admits what the real issuer admits
 * (Merchandise's module key, both modules installed for the tenant, a valid source assertion) and signs the
 * module-call assertion with the deployment's gateway key. Everything after it is the real Merchandise and Tax code.
 */
import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';
import {
  canonicalizeApplicationComposition,
  DatabaseConfigLive,
  defineDatabaseIdentityEnrollment,
  loadDatabaseConnectionPair,
  makeDatabaseIdentityEnrollmentLive,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { ActiveApplicationCompositionSourceLive } from '@app/core-runtime/modules/active-application-composition-source';
import { makeOwnerApplicationCompositionFixture } from '@app/core-runtime/testing/module-contract';
import { deleteTestCoreOutbox } from '@app/core-runtime/testing/owner-evidence';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
  GATEWAY_MODULE_NOT_INSTALLED_TYPE,
  GatewayDelegatedContextRequestSchema,
  shellGatewayContextContract,
} from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { HttpApiBuilder } from '@modern-js/bff-effect/effect-edge';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  Array as Arr,
  Config,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Option,
  Order,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { expect, it, rs } from 'effect-rstest';
import { FetchHttpClient, HttpEffect, HttpServerRequest, HttpServerResponse } from 'effect/http';
import { createLocalJWKSet, importJWK, jwtVerify, SignJWT } from 'jose';

import { governedReadApiHandlersLive as merchandiseHandlersLive } from '../../api/index.ts';
import { merchandiseApi } from '../../shared/api.ts';
import { ultramodernApiMarker as merchandiseMarker } from '../../shared/ultramodern-build.ts';
import { executeApplyCommandWithAuthorization } from '../../src/api/apply-command-action-client.ts';
import { executeManageCatalogWithAuthorization } from '../../src/api/manage-catalog-action-client.ts';
import { executePlaceStorefrontOrderWithAuthorization } from '../../src/api/place-storefront-order-action-client.ts';
import { executeRecordStockMovementWithAuthorization } from '../../src/api/record-stock-movement-action-client.ts';
import { executeRecordsWithAuthorization } from '../../src/api/records-client.ts';
import { PlaceStorefrontOrderPayloadSchema } from '../../shared/actions/place-storefront-order.ts';
import { ProductIdSchema } from '../../shared/domain/merchandise-model.ts';
import { merchandiseRegistration } from '../../vertical.registration.ts';
import { bootstrapScopesOf } from '../../../../packages/core-runtime/src/access/bootstrap/persistence.ts';
import {
  LegalEntityIdSchema,
  PrincipalIdSchema,
  TenantIdSchema,
} from '../../../../packages/core-runtime/src/access/ids.ts';
import {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
} from '../../../../packages/core-runtime/src/auth/external-identity-contracts.ts';
import { governedReadApiHandlersLive as taxHandlersLive } from '../../../tax/api/index.ts';
import { taxApi } from '../../../tax/shared/api.ts';
import { publishedTaxComposition } from '../../../tax/tests/support/published-tax-composition.ts';
import { ultramodernApiMarker as taxMarker } from '../../../tax/shared/ultramodern-build.ts';
import { executeCreateTaxRuleWithAuthorization } from '../../../tax/src/api/create-tax-rule-action-client.ts';
import { executeDeclareSellerVatRegimeWithAuthorization } from '../../../tax/src/api/declare-seller-vat-regime-action-client.ts';

const COMPOSITION_URL = 'https://composition.merchandise-tax.test/active';
const MERCHANDISE_ORIGIN = 'http://merchandise.test';
const SHELL_ORIGIN = 'https://shell.test';
/** Tax's own origin, for the author who calls Tax directly. */
const TAX_ORIGIN = 'https://tax.test';
const SHELL_GATEWAY_BASE_URL = `${SHELL_ORIGIN}${shellGatewayContextContract.apiPrefix}`;
const DELEGATION_PATH = `${shellGatewayContextContract.apiPrefix}/auth/delegated/gateway-context`;
const TAX_PREFIX = '/tax-api';
const MODULE_KEY = 'merchandise-module-key-for-tests';
/** Core's own publication lock, taken around each write of the authority row as Core takes it. */
const AUTHORITY_LOCK = "hashtextextended('ontos.application-composition-authority', 0)";
/**
 * The session lock every suite that replaces the active authority row holds for as long as its row is in place
 * (Core's native suites, Payment's fixture, Tax's historical-access fixture, the baseline seed test): without it a
 * suite running alongside could publish its own release mid-scenario, and the owner would then rightly refuse this
 * scenario's writes as no longer admitted by the approved composition.
 */
const FIXTURE_LOCK = "hashtextextended('ontos.search-test-authority', 0)";
const EFFECTIVE_FROM = '2024-01-01T00:00:00.000Z';

const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const digest = (document: string) => bytesToHex(sha256(utf8ToBytes(document)));

/**
 * Merchandise and Tax, each at its own build marker, in one validated release. Tax is another deployment: its part of
 * the release is the composition Tax itself publishes for tests (its operation contracts as data), never its private
 * registration.
 */
const compositionSnapshot = Effect.gen(function* compositionSnapshot() {
  const merchandise = yield* makeOwnerApplicationCompositionFixture({
    appId: merchandiseMarker.appId,
    buildMarker: merchandiseMarker.buildMarker,
    ownerRegistration: merchandiseRegistration,
  });
  const tax = yield* publishedTaxComposition;
  const composition = {
    ...merchandise.snapshot.composition,
    modules: [...merchandise.snapshot.composition.modules, ...tax.snapshot.composition.modules],
    revision: '0'.repeat(64),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...merchandise.snapshot,
    composition: { ...composition, revision: digest(canonicalizeApplicationComposition(composition)) },
  });
});

const adminClientOf = (maxConnections: number) =>
  Effect.gen(function* adminClient() {
    const connections = yield* loadDatabaseConnectionPair();
    const services = yield* Layer.build(
      PgClient.layer({ maxConnections, url: Redacted.make(connections.admin.connectionString) }),
    );
    return Context.get(services, PgClient.PgClient);
  });
const adminClient = adminClientOf(2);

const ClockRowSchema = Schema.Struct({ now: Schema.DateTimeUtcFromString });
const databaseNow = (admin: PgClient.PgClient) =>
  admin.unsafe(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`).pipe(
    Effect.flatMap(([row]) => Schema.decodeUnknownEffect(ClockRowSchema)(row)),
    Effect.map(({ now }) => now),
    Effect.orDie,
  );

interface AuthorityRow {
  readonly durable_work_admission: string;
  readonly phase: string;
  readonly revision: string;
  readonly subscriptions_json: string;
  readonly updated_at: string;
  readonly valid_until: string;
}

const UPSERT_AUTHORITY =
  "insert into core.application_composition_authority (authority_key, revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) values ('active', $1, $2, $3, $4::timestamptz, $5::jsonb, $6::timestamptz) on conflict (authority_key) do update set revision = excluded.revision, phase = excluded.phase, durable_work_admission = excluded.durable_work_admission, valid_until = excluded.valid_until, subscriptions_json = excluded.subscriptions_json, updated_at = excluded.updated_at";

/** Publishes this release as the active one for the scenario and restores whatever was active before. */
const installCompositionAuthority = Effect.fn('MerchandiseTaxRoots.authority')(function* installAuthority(
  admin: PgClient.PgClient,
  revision: string,
) {
  // A session lock is held by one connection: a client of its own takes it and releases it.
  const lockSession = yield* adminClientOf(1);
  yield* lockSession.unsafe(`select pg_advisory_lock(${FIXTURE_LOCK})`);
  const [previous] = yield* admin.unsafe<AuthorityRow>(
    "select revision, phase, durable_work_admission, valid_until::text as valid_until, subscriptions_json::text as subscriptions_json, updated_at::text as updated_at from core.application_composition_authority where authority_key = 'active'",
  );
  const write = (statement: string, parameters: readonly unknown[]) =>
    admin.withTransaction(
      admin
        .unsafe(`select pg_advisory_xact_lock(${AUTHORITY_LOCK})`)
        .pipe(Effect.andThen(admin.unsafe(statement, parameters))),
    );
  yield* Effect.addFinalizer(() =>
    (previous === undefined
      ? write("delete from core.application_composition_authority where authority_key = 'active'", [])
      : write(UPSERT_AUTHORITY, [
          previous.revision,
          previous.phase,
          previous.durable_work_admission,
          previous.valid_until,
          previous.subscriptions_json,
          previous.updated_at,
        ])
    ).pipe(Effect.andThen(lockSession.unsafe(`select pg_advisory_unlock(${FIXTURE_LOCK})`)), Effect.orDie),
  );
  const now = yield* databaseNow(admin);
  yield* write(UPSERT_AUTHORITY, [
    revision,
    'active',
    'open',
    DateTime.formatIso(DateTime.add(now, { hours: 1 })),
    '[]',
    DateTime.formatIso(now),
  ]);
});

interface Person {
  readonly authBindingId: string;
  readonly kind: 'human' | 'service';
  readonly principalId: string;
}

interface Company {
  readonly author: Person;
  readonly companyId: string;
  readonly staff: Person;
  readonly storefront: Person;
  readonly tenantId: string;
}

const person = (kind: Person['kind']) =>
  Effect.all({ authBindingId: uuid, principalId: uuid }, { concurrency: 1 }).pipe(
    Effect.map((ids): Person => ({ ...ids, kind })),
  );

/**
 * One tenant with one company: an author, a staff member and the registered Storefront client (an API-key workload),
 * Merchandise installed and Tax installed only when `withTax`. Core retains access scopes, the identities its access
 * intent names and the bindings its evidence names; its module states and its Outbox queue are removed on close.
 */
const seedCompany = Effect.fn('MerchandiseTaxRoots.seedCompany')(function* seedCompany(
  admin: PgClient.PgClient,
  withTax: boolean,
) {
  const company: Company = yield* Effect.all(
    {
      author: person('human'),
      companyId: uuid,
      staff: person('human'),
      storefront: person('service'),
      tenantId: uuid,
    },
    { concurrency: 1 },
  );
  const { companyId, tenantId } = company;
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from core.tenant_module_states where tenant_id = $1', [tenantId]).pipe(Effect.orDie),
  );
  // The Actions this suite runs queue Merchandise's search refreshes; no Outbox host delivers them here. Release them
  // on close, so a later suite promoting a composition in this database finds the Outbox drained.
  yield* Effect.addFinalizer(() => deleteTestCoreOutbox(admin, tenantId).pipe(Effect.orDie));
  yield* admin.unsafe(
    "insert into core.tenants (tenant_id, name, slug, status, default_locale) values ($1, 'Merchandise and Tax', $2, 'active', 'cs')",
    [tenantId, `merchandise-tax-${tenantId}`],
  );
  for (const member of [company.author, company.staff, company.storefront]) {
    yield* admin.unsafe(
      "insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, $3, $4, 'active')",
      [member.principalId, tenantId, member.kind, `Merchandise and Tax ${member.kind}`],
    );
    yield* admin.unsafe(
      "insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, $4, 'better-auth', $5, $6, 'active')",
      [
        member.authBindingId,
        tenantId,
        member.principalId,
        STAFF_AUTHENTICATION_NAMESPACE_ID,
        `merchandise-tax-${member.principalId}`,
        member.kind === 'human' ? 'user' : 'api_key',
      ],
    );
  }
  yield* admin.unsafe(
    "insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, 'Prodejce s. r. o.', 'CZ', $3, 'active')",
    [companyId, tenantId, `merchandise-tax-${companyId}`],
  );
  for (const moduleKey of withTax ? ['demo.merchandise', 'commerce.tax'] : ['demo.merchandise']) {
    yield* admin.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $2, 'active')",
      [tenantId, moduleKey],
    );
  }
  // The Storefront client is a registered workload of this one company.
  const workloadBindingId = yield* uuid;
  yield* admin.unsafe(
    "insert into core.access_workload_bindings (binding_id, incarnation, principal_id, status, tenant_id, workload_key) values ($1, $2, $3, 'active', $4, 'demo.storefront-client')",
    [workloadBindingId, yield* uuid, company.storefront.principalId, tenantId],
  );
  yield* admin.unsafe(
    "insert into core.access_workload_company_bindings (company_binding_id, created_at, incarnation, legal_entity_id, status, tenant_id, workload_binding_id) values ($1, now(), $2, $3, 'active', $4, $5)",
    [yield* uuid, yield* uuid, companyId, tenantId, workloadBindingId],
  );
  for (const scope of bootstrapScopesOf(TenantIdSchema.make(tenantId), [LegalEntityIdSchema.make(companyId)])) {
    const legalEntityId = Predicate.isTagged(scope, 'LegalEntity') ? scope.legalEntityId : null;
    yield* admin.unsafe(
      'insert into core.access_scopes (scope_id, tenant_id, legal_entity_id, tenant_context_id) values ($1, $2, $3, $4) on conflict do nothing',
      [scope.scopeId, tenantId, legalEntityId, legalEntityId === null ? tenantId : null],
    );
    yield* admin.unsafe(
      "insert into core.access_scope_fences (scope_id, tenant_id, revision, state, owning_operation_id) values ($1, $2, 1, 'Ready', null) on conflict do nothing",
      [scope.scopeId, tenantId],
    );
  }
  yield* grantTestTenantRoleAccess({
    ...(yield* environmentTestAccessTarget),
    holders: [
      {
        capabilityKeys: ['commerce.tax.tax-rule.create', 'commerce.tax.seller-vat-regime-declaration.declare'],
        principalId: company.author.principalId,
      },
      {
        capabilityKeys: [
          'demo.merchandise.api-records.read',
          'demo.merchandise.apply-command.write',
          'demo.merchandise.catalog.manage',
          'demo.merchandise.stock-movement.record',
        ],
        principalId: company.staff.principalId,
      },
    ],
    legalEntityIds: [companyId],
    tenantId,
  });
  return company;
});

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

interface CallingModule {
  readonly appId: string;
  readonly buildMarker: string;
  readonly principalId: string;
}

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

/** The deployment's gateway key: what the Shell signs staff, Storefront and module-call assertions with. */
const makeGateway = Effect.fn('MerchandiseTaxRoots.gateway')(function* makeGateway(admin: PgClient.PgClient) {
  const issuer = yield* Config.String('ONTOS_GATEWAY_ISSUER');
  const jwk = yield* Config.schema(GatewayPrivateJwkSchema, 'ONTOS_GATEWAY_PRIVATE_JWK');
  const jwks = yield* Config.schema(GatewayPublicJwksSchema, 'ONTOS_GATEWAY_PUBLIC_JWKS');
  const key = yield* Effect.promise(() => importJWK(jwk, 'EdDSA'));
  const keySet = createLocalJWKSet({ keys: jwks.keys.map((entry) => ({ ...entry })) });
  const sign = Effect.fn('MerchandiseTaxRoots.sign')(function* sign(input: {
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
  const sourcePrincipal = (assertion: string) =>
    Effect.promise(() => jwtVerify(assertion, keySet, { audience: merchandiseMarker.appId, issuer })).pipe(
      Effect.flatMap(({ payload }) => Schema.decodeUnknownEffect(SourceClaimsSchema)(payload)),
      Effect.map(({ principal }) => principal),
    );
  return { sign, sourcePrincipal };
});

const principalOf = (member: Person, company: Company): AssertionPrincipal =>
  Schema.decodeUnknownSync(AssertionPrincipalSchema)({
    authBindingId: member.authBindingId,
    authContextRef:
      member.kind === 'human'
        ? `better-auth-session:${member.authBindingId}`
        : `better-auth-api-key:${member.authBindingId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: member.kind === 'human' ? 'session' : 'api_key',
    legalEntityId: company.companyId,
    principalId: member.principalId,
    tenantId: company.tenantId,
  });

const forbidden = () =>
  HttpServerResponse.jsonUnsafe(
    { _tag: 'GatewayForbiddenProblem', detail: 'Refused', status: 403, title: 'Forbidden', type: 'about:blank' },
    { contentType: 'application/problem+json', status: 403 },
  );

const moduleNotInstalled = () =>
  HttpServerResponse.jsonUnsafe(
    {
      _tag: 'GatewayForbiddenProblem',
      detail: 'The module the call is for is not installed for the tenant.',
      status: 403,
      title: 'Module not installed',
      type: GATEWAY_MODULE_NOT_INSTALLED_TYPE,
    },
    { contentType: 'application/problem+json', status: 403 },
  );

type Gateway = Effect.Success<ReturnType<typeof makeGateway>>;

/**
 * The Shell's delegated issuance as the real issuer decides it: Merchandise's module key, a valid source assertion,
 * both modules installed for the subject's tenant (Tax missing: the Shell's own "not installed" problem); it then signs
 * the module-call assertion for the audience.
 */
const delegationHandler = (input: {
  readonly admin: PgClient.PgClient;
  readonly gateway: Gateway;
  readonly merchandise: CallingModule;
  readonly revision: string;
}) =>
  Effect.gen(function* delegation() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.headers['x-api-key'] !== MODULE_KEY) {
      return forbidden();
    }
    const payload = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GatewayDelegatedContextRequestSchema)),
    );
    if (!Predicate.isTagged(payload.subject, 'Assertion') || payload.audience !== taxMarker.appId) {
      return forbidden();
    }
    const principal = yield* input.gateway.sourcePrincipal(Redacted.value(payload.subject.sourceAssertion));
    const installed = yield* input.admin.unsafe<{ readonly module_key: string }>(
      "select module_key from core.tenant_module_states where tenant_id = $1 and state = 'active'",
      [principal.tenantId],
    );
    const keys = new Set(installed.map((row) => row.module_key));
    if (!keys.has('demo.merchandise')) {
      return forbidden();
    }
    // The one refusal the real Shell gives for a module the tenant has not installed.
    if (!keys.has('commerce.tax')) {
      return moduleNotInstalled();
    }
    const issued = yield* input.gateway.sign({
      actor: input.merchandise,
      audience: taxMarker.appId,
      principal,
      revision: input.revision,
      targetBuildMarker: taxMarker.buildMarker,
    });
    return HttpServerResponse.jsonUnsafe({
      apiBaseUrl: TAX_PREFIX,
      compositionRevision: input.revision,
      expiresAt: issued.expiresAt,
      token: issued.token,
    });
  });

const configLayer = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromUnknown({
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_URL,
      ONTOS_SHELL_GATEWAY_BASE_URL: SHELL_GATEWAY_BASE_URL,
    }),
    ConfigProvider.fromEnv(),
  ),
);

const merchandiseReadiness = HttpApiBuilder.group(merchandiseApi, 'foundation', (handlers) =>
  handlers.handle('readiness', () => Effect.die('The readiness probe is not part of this scenario')),
);

type RootHandler = ReturnType<ReturnType<typeof assembleEffectBffRuntime>['createHandler']>;

/** Storefront card rows in product order, so the comparison does not depend on the listing order. */
const byProduct = Order.mapInput(Order.String, (row: readonly unknown[]) => String(row[0]));

/**
 * Both deployment roots' handlers and runtimes, as their roots compose them; only configuration is supplied. The
 * stand-in Shell's delegation app is served as a web handler beside them, with the scenario's services.
 */
const serveRoots = <E>(
  snapshot: ActiveApplicationCompositionSnapshot,
  shellApp: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    HttpServerRequest.HttpServerRequest | Crypto.Crypto
  >,
) =>
  Effect.acquireRelease(
    Effect.gen(function* startRoots() {
      const shell = HttpEffect.toWebHandlerWith<Crypto.Crypto, HttpServerRequest.HttpServerRequest | Crypto.Crypto>(
        yield* Effect.context<Crypto.Crypto>(),
      )(shellApp);
      // Each root reaches the others through this fetch; the roots are registered once both are assembled.
      const rootHandlers = new Map<'merchandise' | 'tax', RootHandler>();
      const forward = (root: 'merchandise' | 'tax', request: Request) =>
        rootHandlers.get(root)?.handler(request) ?? Promise.resolve(new Response('Root not started', { status: 503 }));
      const route = (request: Request) => {
        const url = new URL(request.url);
        if (request.url === COMPOSITION_URL) {
          return Promise.resolve(Response.json(snapshot));
        }
        if (url.origin === SHELL_ORIGIN && url.pathname === DELEGATION_PATH) {
          return shell(request);
        }
        if (url.origin === SHELL_ORIGIN && url.pathname.startsWith(TAX_PREFIX)) {
          return forward(
            'tax',
            new Request(`${SHELL_ORIGIN}${url.pathname.slice(TAX_PREFIX.length)}${url.search}`, request),
          );
        }
        if (url.origin === TAX_ORIGIN) {
          return forward('tax', request);
        }
        if (url.origin === MERCHANDISE_ORIGIN) {
          return forward('merchandise', request);
        }
        return Promise.resolve(new Response('No route in the fixture', { status: 502 }));
      };
      const fetchThroughRoots = (input: RequestInfo | URL, init?: RequestInit) => route(new Request(input, init));
      const support = Layer.mergeAll(configLayer, Layer.succeed(FetchHttpClient.Fetch, fetchThroughRoots));
      const shared = Layer.mergeAll(
        ActiveApplicationCompositionSourceLive.pipe(Layer.provide(FetchHttpClient.layer)),
        DatabaseConfigLive,
        makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([])),
        NodeCrypto.layer,
      ).pipe(Layer.provideMerge(support));
      const merchandise = assembleEffectBffRuntime({
        api: merchandiseApi,
        // The root adds its readiness probe beside the governed handlers; this scenario never calls it.
        handlers: Layer.mergeAll(merchandiseHandlersLive, merchandiseReadiness).pipe(
          Layer.provide(shared),
          Layer.orDie,
        ),
      }).createHandler();
      const tax = assembleEffectBffRuntime({
        api: taxApi,
        handlers: taxHandlersLive.pipe(Layer.provide(support), Layer.orDie),
      }).createHandler();
      rootHandlers.set('merchandise', merchandise);
      rootHandlers.set('tax', tax);
      rs.stubGlobal('fetch', fetchThroughRoots);
      return { merchandise, route, tax };
    }),
    ({ merchandise, tax }) =>
      Effect.promise(() => Promise.all([merchandise.dispose(), tax.dispose()])).pipe(
        Effect.ensuring(Effect.sync(() => rs.unstubAllGlobals())),
      ),
  );

it.live(
  'Merchandise sells at Tax rates through both roots, refuses what Tax cannot price and keeps each line rate',
  () =>
    Effect.scoped(
      Effect.gen(function* merchandiseTaxRoots() {
        // Merchandise's own module key, handed over as the host hands it (never a setting).
        yield* holdTestModuleCredentials({ merchandise: MODULE_KEY });
        const snapshot = yield* compositionSnapshot;
        const { revision } = snapshot.composition;
        const admin = yield* adminClient;
        yield* installCompositionAuthority(admin, revision);
        const seller = yield* seedCompany(admin, true);
        const taxless = yield* seedCompany(admin, false);
        const gateway = yield* makeGateway(admin);
        const merchandiseModule = { appId: merchandiseMarker.appId, buildMarker: merchandiseMarker.buildMarker };
        const merchandiseService = yield* uuid;
        const delegate = delegationHandler({
          admin,
          gateway,
          merchandise: { ...merchandiseModule, principalId: merchandiseService },
          revision,
        });
        // The stand-in Shell answers from inside the scenario, with its crypto service for assertion identities.
        const roots = yield* serveRoots(snapshot, delegate);
        const through = <A, E, R>(call: Effect.Effect<A, E, R>) =>
          call.pipe(
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => roots.route(new Request(input, init))),
          );
        const assertion = (member: Person, company: Company, audience: 'merchandise' | 'tax') =>
          gateway
            .sign({
              audience,
              principal: principalOf(member, company),
              revision,
              targetBuildMarker: audience === 'tax' ? taxMarker.buildMarker : merchandiseMarker.buildMarker,
            })
            .pipe(Effect.map(({ token }) => `Bearer ${token}`));
        const correlation = uuid.pipe(Effect.map((id) => `merchandise-tax-${id}`));
        const merchandiseOptions = { baseUrl: MERCHANDISE_ORIGIN, compositionRevision: revision };
        const writeOptions = uuid.pipe(Effect.map((idempotencyKey) => ({ ...merchandiseOptions, idempotencyKey })));
        const taxWrite = uuid.pipe(
          Effect.map((idempotencyKey) => ({ baseUrl: TAX_ORIGIN, compositionRevision: revision, idempotencyKey })),
        );
        const effectiveFrom = DateTime.makeUnsafe(EFFECTIVE_FROM);

        const createRule = Effect.fn('MerchandiseTaxRoots.createRule')(function* createRule(
          code: 'cz.vat.reduced' | 'cz.vat.standard',
          ratePercent: string,
        ) {
          return yield* through(
            executeCreateTaxRuleWithAuthorization(
              {
                initialRevision: {
                  compositionKind: 'EXCLUSIVE',
                  effectiveFrom,
                  jurisdiction: 'CZ_DOMESTIC',
                  ratePercent,
                  taxClassificationCode: code,
                  treatmentCategory: 'TAXABLE',
                },
                meaningKind: 'VAT_RATE',
                provenanceRef: 'zakon-235-2004',
                reason: 'Czech VAT rate for the selling company',
                stableCode: code,
              },
              yield* assertion(seller.author, seller, 'tax'),
              yield* correlation,
              yield* taxWrite,
            ),
          );
        });
        // Tax: the standard rule and the payer regime; the reduced rule is added later.
        const standard = yield* createRule('cz.vat.standard', '21');
        yield* through(
          executeDeclareSellerVatRegimeWithAuthorization(
            { effectiveFrom, expectedCurrentRevision: 0, reason: 'Plátce DPH od založení', regime: 'VAT_PAYER' },
            yield* assertion(seller.author, seller, 'tax'),
            yield* correlation,
            yield* taxWrite,
          ),
        );

        const records = Effect.fn('MerchandiseTaxRoots.records')(function* records(
          company: Company,
          view: Parameters<typeof executeRecordsWithAuthorization>[0]['view'],
        ) {
          return yield* through(
            executeRecordsWithAuthorization(
              view === undefined ? {} : { view },
              yield* assertion(company.staff, company, 'merchandise'),
              yield* correlation,
              merchandiseOptions,
            ),
          );
        });
        const createProduct = Effect.fn('MerchandiseTaxRoots.createProduct')(function* createProduct(
          company: Company,
          sku: string,
          taxClassificationCode: 'cz.vat.reduced' | 'cz.vat.standard',
          priceMinor: number,
        ) {
          const before = yield* records(company, { limit: 0, ordersLimit: 0, summary: true });
          const created = yield* through(
            executeApplyCommandWithAuthorization(
              {
                command: {
                  _tag: 'CreateProduct',
                  active: true,
                  category: 'Káva',
                  lowStockThreshold: 0,
                  name: `Produkt ${sku}`,
                  priceMinor,
                  sku,
                  taxClassificationCode,
                  unit: 'ks',
                },
                expectedRevision: before.revision,
              },
              yield* assertion(company.staff, company, 'merchandise'),
              yield* correlation,
              yield* writeOptions,
            ),
          );
          const [entityId] = 'proposalId' in created ? [] : created.entityIds;
          if (entityId === undefined || 'proposalId' in created) {
            return yield* Effect.die('CreateProduct returned no product');
          }
          const productId = Schema.decodeUnknownSync(ProductIdSchema)(entityId);
          yield* through(
            executeRecordStockMovementWithAuthorization(
              {
                command: { _tag: 'RecordStockMovement', delta: 10, productId, reason: 'RECEIPT' },
                expectedRevision: created.revision,
              },
              yield* assertion(company.staff, company, 'merchandise'),
              yield* correlation,
              yield* writeOptions,
            ),
          );
          return productId;
        });

        // Staff create one standard and one reduced product; the reduced one has no rule in Tax yet.
        const coffee = yield* createProduct(seller, 'KAVA', 'cz.vat.standard', 10_000);
        const tea = yield* createProduct(seller, 'CAJ', 'cz.vat.reduced', 5000);

        const staffView = yield* records(seller, { ordersLimit: 0, summary: true });
        expect(staffView.sellerVatRegime).toEqual(Option.some('VAT_PAYER'));
        expect(staffView.taxRates?.map((rate) => [rate.code, rate.ratePercent])).toEqual([['cz.vat.standard', 21]]);
        const staffCoffee = staffView.products.find((product) => product.id === coffee);
        expect(staffCoffee).toMatchObject({ grossPriceMinor: 12_100, taxClassificationCode: 'cz.vat.standard' });
        expect(staffView.products.find((product) => product.id === tea)?.grossPriceMinor).toBeUndefined();

        const storefrontCards = () =>
          records(seller, { storefront: true, storefrontCatalog: { fields: 'card' } }).pipe(
            Effect.map((response) =>
              response.products.map((product) => [product.id, product.vatRate, product.grossPriceMinor]),
            ),
          );
        expect(yield* storefrontCards()).toEqual([[coffee, 21, 12_100]]);

        const place = Effect.fn('MerchandiseTaxRoots.place')(function* place(
          company: Company,
          lines: readonly {
            readonly expectedUnitPriceMinor: number;
            readonly productId: string;
            readonly quantity: number;
          }[],
        ) {
          const payload = Schema.decodeUnknownSync(PlaceStorefrontOrderPayloadSchema)({
            command: {
              _tag: 'PlaceStorefrontOrder',
              clientRequestId: yield* uuid,
              contact: { email: 'zakaznik@example.cz', name: 'Zákazník' },
              deliveryAddress: { city: 'Praha', postalCode: '11000', street: 'Václavské náměstí 1' },
              lines,
              shippingMethod: 'ZASILKOVNA',
            },
            expectedRevision: 0,
          });
          const result = yield* through(
            executePlaceStorefrontOrderWithAuthorization(
              payload,
              yield* assertion(company.storefront, company, 'merchandise'),
              yield* correlation,
              yield* writeOptions,
            ),
          );
          if ('proposalId' in result || result.storefrontOrder === undefined) {
            return yield* Effect.die('PlaceStorefrontOrder answered no storefront order');
          }
          return result.storefrontOrder;
        });

        // The reduced product cannot be sold: no rule in Tax. The storefront gets a readable issue, nothing is saved.
        const refused = yield* place(seller, [{ expectedUnitPriceMinor: 5600, productId: tea, quantity: 1 }]);
        expect(refused.outcome).toBe('REJECTED');
        expect(refused.issues).toEqual([
          expect.objectContaining({
            code: 'PRICE_UNAVAILABLE',
            message: expect.stringContaining('není v daních firmy platné pravidlo'),
            productId: tea,
          }),
        ]);

        // Tax gets the reduced rule; after a resync the reduced product (no gross stored yet) sells at net plus 12 %.
        const reduced = yield* createRule('cz.vat.reduced', '12');
        const beforeSync = yield* records(seller, { limit: 0, ordersLimit: 0, summary: true });
        const synced = yield* through(
          executeManageCatalogWithAuthorization(
            { command: { _tag: 'SyncTaxRates' }, expectedRevision: beforeSync.revision },
            yield* assertion(seller.staff, seller, 'merchandise'),
            yield* correlation,
            yield* writeOptions,
          ),
        );
        expect('proposalId' in synced ? undefined : synced.revision).toBe(beforeSync.revision + 1);
        expect(Arr.sort(yield* storefrontCards(), byProduct)).toEqual(
          Arr.sort(
            [
              [coffee, 21, 12_100],
              [tea, 12, 5600],
            ],
            byProduct,
          ),
        );

        // The Storefront client places both; each line keeps its rate, classification and Tax rule revision.
        const placed = yield* place(seller, [
          { expectedUnitPriceMinor: 12_100, productId: coffee, quantity: 1 },
          { expectedUnitPriceMinor: 5600, productId: tea, quantity: 2 },
        ]);
        expect(placed.outcome).toBe('PLACED');
        const orders = yield* records(seller, { orderId: placed.orderId, summary: true });
        const [order] = orders.orders;
        expect(
          order?.lines.map((line) => [
            line.productId,
            line.vatRate,
            line.taxClassificationCode,
            line.taxRuleRevisionId,
          ]),
        ).toEqual([
          [coffee, 21, 'cz.vat.standard', standard.initialRevisionRef.resourceId],
          [tea, 12, 'cz.vat.reduced', reduced.initialRevisionRef.resourceId],
        ]);
        expect(order?.shipping?.vatRate).toBe(21);
        // Gross storefront prices: 121 + 2 × 56 Kč and Zásilkovna 79 Kč.
        expect(order?.totalMinor).toBe(12_100 + 2 * 5600 + 7900);

        // Without Tax installed nothing can be sold: products save, the order is refused with a clear reason.
        const loose = yield* createProduct(taxless, 'BEZ-DANI', 'cz.vat.standard', 10_000);
        const taxlessView = yield* records(taxless, { ordersLimit: 0, summary: true });
        expect(taxlessView.taxRates).toEqual([]);
        expect(taxlessView.products.find((product) => product.id === loose)?.grossPriceMinor).toBeUndefined();
        const notInstalled = yield* place(taxless, [{ expectedUnitPriceMinor: 12_100, productId: loose, quantity: 1 }]);
        expect(notInstalled.outcome).toBe('REJECTED');
        expect(notInstalled.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'PRICE_UNAVAILABLE',
              message: expect.stringContaining('daně firmy nejsou dostupné'),
            }),
          ]),
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  180_000,
);
