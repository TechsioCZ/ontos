// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Merchandise prices goods with the VAT rates Tax publishes for the selling company. This proves that call
 * through Tax's own deployment root on PostgreSQL and SpiceDB: an authorized staff member records the company's
 * rules and VAT regime through Tax's real Actions, then Merchandise reads them for a different staff member who
 * holds no Tax right, with the module-call assertion the Shell signs for Merchandise (`act`). Tax admits that
 * call only because its reads name Merchandise as a caller (`accessActor`); the same person calling Tax
 * directly, or another module calling for them, is refused.
 */
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import {
  canonicalizeApplicationComposition,
  loadDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import {
  makeApplicationCompositionSnapshotFixture,
  makeOwnerApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '@app/shared-contracts';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  Config,
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from 'effect';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { importJWK, SignJWT } from 'jose';

import { governedReadApiHandlersLive } from '../../api/index.ts';
import { taxApi } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { executeApplicableTaxRuleSetWithAuthorization } from '../../src/api/applicable-tax-rule-set-client.ts';
import { executeCreateTaxRuleWithAuthorization } from '../../src/api/create-tax-rule-action-client.ts';
import { executeDeclareSellerVatRegimeWithAuthorization } from '../../src/api/declare-seller-vat-regime-action-client.ts';
import { executeSellerVatRegimeAtInstantWithAuthorization } from '../../src/api/seller-vat-regime-at-instant-client.ts';
import { executeTaxRuleHistoryWithAuthorization } from '../../src/api/tax-rule-history-client.ts';
import { taxRegistration } from '../../vertical.registration.ts';
import { bootstrapScopesOf } from '../../../../packages/core-runtime/src/access/bootstrap/persistence.ts';

const TAX_APP = 'tax';
const MERCHANDISE_APP = 'merchandise';
const UNDECLARED_APP = 'work-tasks';
const STANDARD = 'cz.vat.standard';
const REDUCED = 'cz.vat.reduced';
const COMPOSITION_URL = 'https://composition.tax-merchandise-delegation.test/active';
const TAX_ORIGIN = 'http://localhost:3020';
/** Core's own publication lock, taken around each write of the authority row as Core takes it. */
const AUTHORITY_LOCK = "hashtextextended('ontos.application-composition-authority', 0)";
/**
 * The session lock every suite that replaces the active authority row holds for as long as its row is in place
 * (Core's native suites, Payment's fixture, Tax's historical-access fixture, the baseline seed test): without it a
 * suite running alongside could publish its own release mid-scenario, and Tax would then rightly refuse this
 * scenario's writes as no longer admitted by the approved composition.
 */
const FIXTURE_LOCK = "hashtextextended('ontos.search-test-authority', 0)";

const digest = (document: string) => bytesToHex(sha256(utf8ToBytes(document)));
const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

/** Tax's real registration plus the two calling apps the Shell knows, all in one validated release. */
const compositionSnapshot = Effect.gen(function* compositionSnapshot() {
  const { snapshot } = yield* makeOwnerApplicationCompositionFixture({
    appId: TAX_APP,
    buildMarker: ultramodernApiMarker.buildMarker,
    ownerRegistration: taxRegistration,
  });
  const callers = yield* makeApplicationCompositionSnapshotFixture(
    [MERCHANDISE_APP, UNDECLARED_APP],
    ultramodernApiMarker.buildMarker,
  );
  const composition = {
    ...snapshot.composition,
    modules: [...snapshot.composition.modules, ...callers.composition.modules],
    revision: '0'.repeat(64),
  };
  return yield* validateActiveApplicationCompositionSnapshot({
    ...snapshot,
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

/**
 * The deployment's own PostgreSQL clock: the instant the gateway assertions, the release lease and the Tax reads
 * are judged against, never this process's clock.
 */
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
const installCompositionAuthority = Effect.fn('TaxMerchandiseDelegation.authority')(function* installAuthority(
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
  readonly principalId: string;
}

interface Realm {
  readonly author: Person;
  readonly merchandiseService: string;
  readonly nonPayerCompanyId: string;
  readonly payerCompanyId: string;
  readonly staff: Person;
  readonly tenantId: string;
}

const person = Effect.all({ authBindingId: uuid, principalId: uuid });

/**
 * The Core rows a staff request reads: the Tenant, its two companies, both modules installed, the two staff
 * members with their session bindings, Merchandise's service principal, and the Ready access scopes. Core retains
 * access scopes, the identities its access intent names and the bindings its Action evidence names; only the
 * module states are removed on close.
 */
const seedRealm = Effect.fn('TaxMerchandiseDelegation.seedRealm')(function* seedRealm(admin: PgClient.PgClient) {
  const realm: Realm = yield* Effect.all({
    author: person,
    merchandiseService: uuid,
    nonPayerCompanyId: uuid,
    payerCompanyId: uuid,
    staff: person,
    tenantId: uuid,
  });
  const { tenantId } = realm;
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from core.tenant_module_states where tenant_id = $1', [tenantId]).pipe(Effect.orDie),
  );
  yield* admin.unsafe(
    "insert into core.tenants (tenant_id, name, slug, status, default_locale) values ($1, 'Tax delegation acceptance', $2, 'active', 'cs')",
    [tenantId, `tax-delegation-${tenantId}`],
  );
  const principalRows = [
    [realm.author.principalId, 'human'],
    [realm.staff.principalId, 'human'],
    [realm.merchandiseService, 'service'],
  ] as const;
  for (const [principalId, kind] of principalRows) {
    yield* admin.unsafe(
      "insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, $3, $4, 'active')",
      [principalId, tenantId, kind, `Tax delegation ${kind}`],
    );
  }
  for (const companyId of [realm.payerCompanyId, realm.nonPayerCompanyId]) {
    yield* admin.unsafe(
      "insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, $3, 'CZ', $4, 'active')",
      [companyId, tenantId, `Seller ${companyId}`, `tax-delegation-${companyId}`],
    );
  }
  for (const moduleKey of ['commerce.tax', 'demo.merchandise']) {
    yield* admin.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $2, 'active')",
      [tenantId, moduleKey],
    );
  }
  for (const staff of [realm.author, realm.staff]) {
    yield* admin.unsafe(
      "insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, $4, 'better-auth', $5, 'user', 'active')",
      [
        staff.authBindingId,
        tenantId,
        staff.principalId,
        STAFF_AUTHENTICATION_NAMESPACE_ID,
        `tax-delegation-${staff.principalId}`,
      ],
    );
  }
  const scopes = bootstrapScopesOf(TenantIdSchema.make(tenantId), [
    LegalEntityIdSchema.make(realm.payerCompanyId),
    LegalEntityIdSchema.make(realm.nonPayerCompanyId),
  ]);
  for (const scope of scopes) {
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
  return realm;
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

interface CallingModule {
  readonly appId: string;
  readonly buildMarker: string;
  readonly principalId: string;
}

/**
 * Signs what the Shell signs with the deployment's gateway key: a staff member's own assertion (v2), or, with
 * `actor`, the module-call assertion the Shell issues to a calling module for that staff member (v3).
 */
const makeGatewaySigner = Effect.fn('TaxMerchandiseDelegation.signer')(function* makeGatewaySigner(
  admin: PgClient.PgClient,
) {
  const issuer = yield* Config.String('ONTOS_GATEWAY_ISSUER');
  const jwk = yield* Config.schema(GatewayPrivateJwkSchema, 'ONTOS_GATEWAY_PRIVATE_JWK');
  const key = yield* Effect.promise(() => importJWK(jwk, 'EdDSA'));
  return Effect.fn('TaxMerchandiseDelegation.sign')(function* sign(
    revision: string,
    staff: Person,
    tenantId: string,
    legalEntityId: string,
    actor?: CallingModule,
  ) {
    const issuedAt = Math.floor(DateTime.toEpochMillis(yield* databaseNow(admin)) / 1000);
    const jti = yield* uuid;
    const principal = {
      authBindingId: staff.authBindingId,
      authContextRef: `better-auth-session:${staff.authBindingId}`,
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'session',
      legalEntityId,
      principalId: staff.principalId,
      tenantId,
    };
    const base = { compositionRevision: revision, principal, targetBuildMarker: ultramodernApiMarker.buildMarker };
    const claims =
      actor === undefined
        ? { ...base, ver: EXTERNAL_GATEWAY_ASSERTION_VERSION }
        : { ...base, act: actor, ver: DELEGATED_GATEWAY_ASSERTION_VERSION };
    const token = yield* Effect.promise(() =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })
        .setAudience(TAX_APP)
        .setIssuer(issuer)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + GATEWAY_ASSERTION_TTL_SECONDS)
        .setJti(jti)
        .setSubject(staff.principalId)
        .sign(key),
    );
    return `Bearer ${token}`;
  });
});

/**
 * Tax's own deployment handlers and production runtimes, exactly as its root exports them, served as one web
 * handler. Only the release source is supplied: its URL as configuration and its answer at the HTTP boundary.
 */
const serveTaxRoot = (snapshot: ActiveApplicationCompositionSnapshot) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      assembleEffectBffRuntime({
        api: taxApi,
        handlers: governedReadApiHandlersLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              ConfigProvider.layer(
                ConfigProvider.orElse(
                  ConfigProvider.fromUnknown({ ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: COMPOSITION_URL }),
                  ConfigProvider.fromEnv(),
                ),
              ),
              Layer.succeed(FetchHttpClient.Fetch, (input, init) => {
                const request = new Request(input, init);
                return request.url === COMPOSITION_URL
                  ? Promise.resolve(Response.json(snapshot))
                  : Promise.reject(new Error(`Tax fetched an unexpected origin: ${request.url}`));
              }),
            ),
          ),
          Layer.orDie,
        ),
      }).createHandler(),
    ),
    (server) => Effect.promise(() => server.dispose()),
  );

const ProblemStatusSchema = Schema.Struct({ status: Schema.Number });
const statusOf = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(
    Effect.match({
      onFailure: (problem) => (Schema.is(ProblemStatusSchema)(problem) ? problem.status : -1),
      onSuccess: () => 200,
    }),
  );

it.live(
  'Merchandise reads the selling company VAT rates and regime from Tax for a staff member without Tax rights',
  () =>
    Effect.scoped(
      Effect.gen(function* merchandiseDelegatedRateRead() {
        const snapshot = yield* compositionSnapshot;
        const { revision } = snapshot.composition;
        const moduleOf = (appId: string) =>
          Effect.fromOption(
            Option.fromNullishOr(snapshot.composition.modules.find((module) => module.deployment.appId === appId)),
          ).pipe(Effect.orDie);
        const [merchandiseModule, undeclaredModule] = yield* Effect.all([
          moduleOf(MERCHANDISE_APP),
          moduleOf(UNDECLARED_APP),
        ]);
        const admin = yield* adminClient;
        yield* installCompositionAuthority(admin, revision);
        const realm = yield* seedRealm(admin);
        // The author holds exactly Tax's rule and regime authoring rights; the staff member holds only a
        // Merchandise right, so nothing in Tax admits them on their own.
        yield* grantTestTenantRoleAccess({
          ...(yield* environmentTestAccessTarget),
          holders: [
            {
              capabilityKeys: ['commerce.tax.tax-rule.create', 'commerce.tax.seller-vat-regime-declaration.declare'],
              principalId: realm.author.principalId,
            },
            { capabilityKeys: ['demo.merchandise.api-records.read'], principalId: realm.staff.principalId },
          ],
          legalEntityIds: [realm.payerCompanyId, realm.nonPayerCompanyId],
          tenantId: realm.tenantId,
        });

        // Tax's own deployment root; only the release source it fetches is answered by the fixture.
        const runtime = yield* serveTaxRoot(snapshot);
        const throughTax = <A, E, R>(call: Effect.Effect<A, E, R>) =>
          call.pipe(
            Effect.provideService(FetchHttpClient.Fetch, (input, init) => runtime.handler(new Request(input, init))),
          );
        const read = { baseUrl: TAX_ORIGIN, compositionRevision: revision };
        const write = uuid.pipe(Effect.map((idempotencyKey) => ({ ...read, idempotencyKey })));
        const correlation = uuid.pipe(Effect.map((id) => `tax-delegation-${id}`));
        const sign = yield* makeGatewaySigner(admin);
        const asAuthor = (companyId: string) => sign(revision, realm.author, realm.tenantId, companyId);
        const asStaff = (companyId: string) => sign(revision, realm.staff, realm.tenantId, companyId);
        const viaModule = (companyId: string, module = merchandiseModule) =>
          sign(revision, realm.staff, realm.tenantId, companyId, {
            appId: module.deployment.appId,
            buildMarker: module.deployment.buildMarker,
            principalId: realm.merchandiseService,
          });
        const effectiveFrom = DateTime.makeUnsafe('2024-01-01T00:00:00.000Z');

        // The payer company: a VAT payer with a standard and a reduced rate, recorded by the author.
        const createRule = Effect.fn('TaxMerchandiseDelegation.createRule')(function* createRule(
          code: string,
          ratePercent: string,
        ) {
          return yield* throughTax(
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
              yield* asAuthor(realm.payerCompanyId),
              yield* correlation,
              yield* write,
            ),
          );
        });
        const standard = yield* createRule(STANDARD, '21');
        const reduced = yield* createRule(REDUCED, '12');
        expect([standard.created, reduced.created]).toEqual([true, true]);
        const declare = Effect.fn('TaxMerchandiseDelegation.declare')(function* declare(
          companyId: string,
          regime: 'VAT_PAYER' | 'NON_PAYER',
        ) {
          return yield* throughTax(
            executeDeclareSellerVatRegimeWithAuthorization(
              {
                effectiveFrom,
                expectedCurrentRevision: 0,
                reason: 'Declared since the company was founded',
                regime,
              },
              yield* asAuthor(companyId),
              yield* correlation,
              yield* write,
            ),
          );
        });
        expect(Predicate.isTagged(yield* declare(realm.payerCompanyId, 'VAT_PAYER'), 'DECLARED')).toBe(true);
        expect(Predicate.isTagged(yield* declare(realm.nonPayerCompanyId, 'NON_PAYER'), 'DECLARED')).toBe(true);

        const now = yield* databaseNow(admin);
        const ruleSet = Effect.fn('TaxMerchandiseDelegation.ruleSet')(function* ruleSet(
          code: string,
          credential: string,
        ) {
          return yield* throughTax(
            executeApplicableTaxRuleSetWithAuthorization(
              { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: now },
              credential,
              yield* correlation,
              read,
            ),
          );
        });
        const regimeAt = Effect.fn('TaxMerchandiseDelegation.regimeAt')(function* regimeAt(credential: string) {
          return yield* throughTax(
            executeSellerVatRegimeAtInstantWithAuthorization({ instant: now }, credential, yield* correlation, read),
          );
        });

        // Merchandise, for the staff member, reads both rates, the regime and the rule history.
        const started = yield* databaseNow(admin);
        const standardSet = yield* ruleSet(STANDARD, yield* viaModule(realm.payerCompanyId));
        const elapsedMs = DateTime.distance(started, yield* databaseNow(admin));
        const reducedSet = yield* ruleSet(REDUCED, yield* viaModule(realm.payerCompanyId));
        expect(standardSet.outcome).toBe('SELECTED');
        expect(standardSet.applicable.map((rule) => rule.ratePercent)).toEqual(['21']);
        expect(standardSet.applicable[0]?.taxRuleRevisionRef).toEqual(standard.initialRevisionRef);
        expect(standardSet.completeness.setFingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(reducedSet.applicable.map((rule) => rule.ratePercent)).toEqual(['12']);
        const payerSelection = (yield* regimeAt(yield* viaModule(realm.payerCompanyId))).selection;
        expect(Predicate.isTagged(payerSelection, 'DECLARED')).toBe(true);
        expect(payerSelection).toMatchObject({ regime: 'VAT_PAYER' });
        const history = yield* throughTax(
          executeTaxRuleHistoryWithAuthorization(
            { taxRuleRef: standard.taxRuleRef },
            yield* viaModule(realm.payerCompanyId),
            yield* correlation,
            read,
          ),
        );
        expect(history.revisions.map((entry) => entry.ratePercent)).toEqual(['21']);

        // A non-payer company with no rules: an explicit missing outcome and a NON_PAYER regime, never a rate.
        expect(yield* ruleSet(STANDARD, yield* viaModule(realm.nonPayerCompanyId))).toMatchObject({
          applicable: [],
          outcome: 'TAX_RULE_MISSING',
        });
        const nonPayerSelection = (yield* regimeAt(yield* viaModule(realm.nonPayerCompanyId))).selection;
        expect(Predicate.isTagged(nonPayerSelection, 'DECLARED')).toBe(true);
        expect(nonPayerSelection).toMatchObject({ regime: 'NON_PAYER' });

        // The staff member alone holds no Tax right, and a module Tax does not name cannot act for them.
        expect(yield* statusOf(ruleSet(STANDARD, yield* asStaff(realm.payerCompanyId)))).toBe(403);
        expect(yield* statusOf(ruleSet(STANDARD, yield* viaModule(realm.payerCompanyId, undeclaredModule)))).toBe(403);

        yield* Effect.logInfo(`Delegated applicable-tax-rule-set read took ${Duration.format(elapsedMs)}`);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  120_000,
);
