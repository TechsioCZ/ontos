// @effect-diagnostics strictEffectProvide:off -- Integration test entrypoint composes its layers once; expires: 2027-03-31.
/*
 * Finance's VAT settings and invoice VAT through Tax's own deployment root on PostgreSQL and SpiceDB.
 *
 * - An accountant with Tax's rule rights plans a new standard rate from a future day exactly as the DPH page does
 *   (end the covering rate, add the new one, each against Tax's latest basis) and sees it listed as planned.
 * - A Finance clerk without any Tax right is refused by Tax (403, the problem the page shows as "no access").
 * - An accountant with only the preset's Tax reads sees the rates and the regime with their history; Tax tells the
 *   page she may make no VAT change and refuses each one she sends anyway. The author, who holds the change rights,
 *   is told so.
 * - Finance, calling Tax for that same clerk with the module-call assertion the Shell signs for Finance, gets the
 *   company's rates for an invoice line; Tax's reads list `finance-billing` as a caller.
 */
import type { ActiveApplicationCompositionSnapshot } from '@app/core-runtime';
import {
  canonicalizeApplicationComposition,
  loadDatabaseConnectionPair,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { LegalEntityIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import {
  DELEGATED_GATEWAY_ASSERTION_VERSION,
  EXTERNAL_GATEWAY_ASSERTION_VERSION,
  GATEWAY_ASSERTION_TTL_SECONDS,
} from '@app/shared-contracts';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';
import {
  executeApplicableTaxRuleSetWithAuthorization,
  executeCreateTaxRuleRevisionWithAuthorization,
  executeCreateTaxRuleWithAuthorization,
  executeDeclareSellerVatRegimeWithAuthorization,
  executeEndTaxRuleRevisionWithAuthorization,
  executeSellerVatRegimeAtInstantWithAuthorization,
  executeSellerVatRegimeHistoryWithAuthorization,
  executeTaxRuleHistoryWithAuthorization,
} from '@app/tax/api/client';
import { NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { Config, ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';
import { importJWK, SignJWT } from 'jose';

import { governedReadApiHandlersLive } from '../../../tax/api/index.ts';
import { taxApi } from '../../../tax/shared/api.ts';
import { ultramodernApiMarker } from '../../../tax/shared/ultramodern-build.ts';
import { publishedTaxComposition } from '../../../tax/tests/support/published-tax-composition.ts';
import { bootstrapScopesOf } from '../../../../packages/core-runtime/src/access/bootstrap/persistence.ts';
import { pragueDayStart } from '../../shared/domain/line-vat.ts';
import { classificationView, planRateChange } from '../../src/routes/[lang]/finance/dph/vat-settings-model.ts';

const TAX_APP = 'tax';
const FINANCE_APP = 'finance-billing';
const UNDECLARED_APP = 'work-tasks';
const COMPOSITION_URL = 'https://composition.finance-vat-settings.test/active';
const TAX_ORIGIN = 'http://localhost:3020';
/** Core's own publication lock, taken around each write of the authority row as Core takes it. */
const AUTHORITY_LOCK = "hashtextextended('ontos.application-composition-authority', 0)";
/**
 * The session lock every suite that replaces the active authority row holds for as long as its row is in place
 * (Core's native suites, Payment's fixture, Tax's historical-access fixture, the baseline seed test): without it a
 * suite running alongside could publish its own release mid-scenario, and the owner would then rightly refuse this
 * scenario's writes as no longer admitted by the approved composition.
 */
const FIXTURE_LOCK = "hashtextextended('ontos.search-test-authority', 0)";

const digest = (document: string) => bytesToHex(sha256(utf8ToBytes(document)));
const uuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

/** Tax's real registration plus the two calling apps the Shell knows, all in one validated release. */
const compositionSnapshot = Effect.gen(function* compositionSnapshot() {
  // Tax is another deployment: its part of the release is the composition Tax publishes for tests, not its registration.
  const { snapshot } = yield* publishedTaxComposition;
  const callers = yield* makeApplicationCompositionSnapshotFixture(
    [FINANCE_APP, UNDECLARED_APP],
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
const installCompositionAuthority = Effect.fn('FinanceVatSettings.authority')(function* installAuthority(
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
  readonly financeService: string;
  readonly nonPayerCompanyId: string;
  readonly payerCompanyId: string;
  /** An accountant with only the preset's Tax reads. */
  readonly reader: Person;
  readonly staff: Person;
  readonly tenantId: string;
}

const person = Effect.all({ authBindingId: uuid, principalId: uuid });

/**
 * The Core rows a staff request reads: the Tenant, its two companies, both modules installed, the two staff
 * members with their session bindings, Finance's service principal, and the Ready access scopes. Core retains
 * access scopes, the identities its access intent names and the bindings its Action evidence names; only the
 * module states are removed on close.
 */
const seedRealm = Effect.fn('FinanceVatSettings.seedRealm')(function* seedRealm(admin: PgClient.PgClient) {
  const realm: Realm = yield* Effect.all({
    author: person,
    financeService: uuid,
    nonPayerCompanyId: uuid,
    payerCompanyId: uuid,
    reader: person,
    staff: person,
    tenantId: uuid,
  });
  const { tenantId } = realm;
  yield* Effect.addFinalizer(() =>
    admin.unsafe('delete from core.tenant_module_states where tenant_id = $1', [tenantId]).pipe(Effect.orDie),
  );
  yield* admin.unsafe(
    "insert into core.tenants (tenant_id, name, slug, status, default_locale) values ($1, 'Finance VAT settings acceptance', $2, 'active', 'cs')",
    [tenantId, `finance-vat-${tenantId}`],
  );
  const principalRows = [
    [realm.author.principalId, 'human'],
    [realm.staff.principalId, 'human'],
    [realm.reader.principalId, 'human'],
    [realm.financeService, 'service'],
  ] as const;
  for (const [principalId, kind] of principalRows) {
    yield* admin.unsafe(
      "insert into core.principals (principal_id, tenant_id, kind, display_name, status) values ($1, $2, $3, $4, 'active')",
      [principalId, tenantId, kind, `Finance VAT ${kind}`],
    );
  }
  for (const companyId of [realm.payerCompanyId, realm.nonPayerCompanyId]) {
    yield* admin.unsafe(
      "insert into core.legal_entities (legal_entity_id, tenant_id, legal_name, registration_country, registration_number, status) values ($1, $2, $3, 'CZ', $4, 'active')",
      [companyId, tenantId, `Seller ${companyId}`, `finance-vat-${companyId}`],
    );
  }
  for (const moduleKey of ['commerce.tax', 'finance.billing']) {
    yield* admin.unsafe(
      "insert into core.tenant_module_states (tenant_id, module_key, state) values ($1, $2, 'active')",
      [tenantId, moduleKey],
    );
  }
  for (const staff of [realm.author, realm.staff, realm.reader]) {
    yield* admin.unsafe(
      "insert into core.principal_auth_bindings (principal_auth_binding_id, tenant_id, principal_id, authentication_namespace_id, provider, provider_subject_id, subject_type, status) values ($1, $2, $3, $4, 'better-auth', $5, 'user', 'active')",
      [
        staff.authBindingId,
        tenantId,
        staff.principalId,
        STAFF_AUTHENTICATION_NAMESPACE_ID,
        `finance-vat-${staff.principalId}`,
      ],
    );
  }
  const scopes = bootstrapScopesOf(TenantIdSchema.make(tenantId), [
    LegalEntityIdSchema.make(realm.payerCompanyId),
    LegalEntityIdSchema.make(realm.nonPayerCompanyId),
  ]);
  for (const scope of scopes) {
    const legalEntityId = scope._tag === 'LegalEntity' ? scope.legalEntityId : null;
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
const makeGatewaySigner = Effect.fn('FinanceVatSettings.signer')(function* makeGatewaySigner(admin: PgClient.PgClient) {
  const issuer = yield* Config.String('ONTOS_GATEWAY_ISSUER');
  const jwk = yield* Config.schema(GatewayPrivateJwkSchema, 'ONTOS_GATEWAY_PRIVATE_JWK');
  const key = yield* Effect.promise(() => importJWK(jwk, 'EdDSA'));
  return Effect.fn('FinanceVatSettings.sign')(function* sign(
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

const day = (isoDate: string) => Option.getOrThrow(Option.fromUndefinedOr(pragueDayStart(isoDate)));

/** The scenario: a payer company with Tax's baseline rates, an accountant with Tax rights and a Finance clerk. */
const setUp = Effect.fn('FinanceVatSettings.setUp')(function* setUp() {
  const snapshot = yield* compositionSnapshot;
  const { revision } = snapshot.composition;
  const moduleOf = (appId: string) =>
    Effect.fromOption(
      Option.fromNullishOr(snapshot.composition.modules.find((module) => module.deployment.appId === appId)),
    ).pipe(Effect.orDie);
  const [financeModule, undeclaredModule] = yield* Effect.all([moduleOf(FINANCE_APP), moduleOf(UNDECLARED_APP)]);
  const admin = yield* adminClient;
  yield* installCompositionAuthority(admin, revision);
  const realm = yield* seedRealm(admin);
  // The accountant holds Tax's rule and regime rights; the clerk holds only Finance rights.
  yield* grantTestTenantRoleAccess({
    ...(yield* environmentTestAccessTarget),
    holders: [
      {
        capabilityKeys: [
          'commerce.tax.tax-rule-set.read',
          'commerce.tax.tax-rule.read-history',
          'commerce.tax.tax-rule.create',
          'commerce.tax.tax-rule-revision.create',
          'commerce.tax.tax-rule-revision.end',
          'commerce.tax.seller-vat-regime.read-at-instant',
          'commerce.tax.seller-vat-regime-declaration.declare',
          'commerce.tax.seller-vat-regime-declaration.read-history',
        ],
        principalId: realm.author.principalId,
      },
      {
        // The accountant preset: the DPH page's four Tax reads and no Tax change.
        capabilityKeys: [
          'commerce.tax.seller-vat-regime-declaration.read-history',
          'commerce.tax.seller-vat-regime.read-at-instant',
          'commerce.tax.tax-rule-set.read',
          'commerce.tax.tax-rule.read-history',
        ],
        principalId: realm.reader.principalId,
      },
      {
        capabilityKeys: ['finance.billing.api-records.read', 'finance.billing.vat-choices.read'],
        principalId: realm.staff.principalId,
      },
    ],
    legalEntityIds: [realm.payerCompanyId, realm.nonPayerCompanyId],
    tenantId: realm.tenantId,
  });
  const runtime = yield* serveTaxRoot(snapshot);
  const throughTax = <A, E, R>(call: Effect.Effect<A, E, R>) =>
    call.pipe(Effect.provideService(FetchHttpClient.Fetch, (input, init) => runtime.handler(new Request(input, init))));
  const read = { baseUrl: TAX_ORIGIN, compositionRevision: revision };
  const write = uuid.pipe(Effect.map((idempotencyKey) => ({ ...read, idempotencyKey })));
  const correlation = uuid.pipe(Effect.map((id) => `finance-vat-${id}`));
  const sign = yield* makeGatewaySigner(admin);
  const asAccountant = sign(revision, realm.author, realm.tenantId, realm.payerCompanyId);
  const asClerk = sign(revision, realm.staff, realm.tenantId, realm.payerCompanyId);
  const asReader = sign(revision, realm.reader, realm.tenantId, realm.payerCompanyId);
  const financeForClerk = (module = financeModule) =>
    sign(revision, realm.staff, realm.tenantId, realm.payerCompanyId, {
      appId: module.deployment.appId,
      buildMarker: module.deployment.buildMarker,
      principalId: realm.financeService,
    });

  // Tax's baseline for the company: 21 % and 12 % since 1. 1. 2024 and a VAT payer regime.
  const baselineFrom = day('2024-01-01');
  const createRule = Effect.fn('FinanceVatSettings.createRule')(function* createRule(
    code: string,
    ratePercent: string,
  ) {
    return yield* throughTax(
      executeCreateTaxRuleWithAuthorization(
        {
          initialRevision: {
            compositionKind: 'EXCLUSIVE',
            effectiveFrom: baselineFrom,
            jurisdiction: 'CZ_DOMESTIC',
            ratePercent,
            taxClassificationCode: code,
            treatmentCategory: 'TAXABLE',
          },
          meaningKind: 'VAT_RATE',
          provenanceRef: 'zakon-235-2004',
          reason: 'Czech VAT rate of the company',
          stableCode: code,
        },
        yield* asAccountant,
        yield* correlation,
        yield* write,
      ),
    );
  });
  const standard = yield* createRule(CZ_VAT_STANDARD, '21');
  yield* createRule(CZ_VAT_REDUCED, '12');
  const declared = yield* throughTax(
    executeDeclareSellerVatRegimeWithAuthorization(
      { effectiveFrom: baselineFrom, expectedCurrentRevision: 0, reason: 'Registered payer', regime: 'VAT_PAYER' },
      yield* asAccountant,
      yield* correlation,
      yield* write,
    ),
  );
  expect(declared._tag).toBe('DECLARED');
  const now = yield* databaseNow(admin);
  const ruleSet = Effect.fn('FinanceVatSettings.ruleSet')(function* ruleSet(code: string, credential: string) {
    return yield* throughTax(
      executeApplicableTaxRuleSetWithAuthorization(
        { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode: code, taxRelevantTime: now },
        credential,
        yield* correlation,
        read,
      ),
    );
  });
  const ruleHistory = Effect.fn('FinanceVatSettings.ruleHistory')(function* ruleHistory(credential: string) {
    return yield* throughTax(
      executeTaxRuleHistoryWithAuthorization({ taxRuleRef: standard.taxRuleRef }, credential, yield* correlation, read),
    );
  });
  const regimeHistory = Effect.fn('FinanceVatSettings.regimeHistory')(function* regimeHistory(credential: string) {
    return yield* throughTax(executeSellerVatRegimeHistoryWithAuthorization({}, credential, yield* correlation, read));
  });
  return {
    asAccountant,
    asClerk,
    asReader,
    correlation,
    financeForClerk,
    now,
    read,
    regimeHistory,
    ruleHistory,
    ruleSet,
    standard,
    throughTax,
    undeclaredModule,
    write,
  };
});

const live = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.live(
  'an accountant plans a new standard rate on the DPH page and sees it planned; a clerk is refused by Tax',
  () =>
    Effect.scoped(
      Effect.gen(function* plannedRate() {
        const scenario = yield* setUp();
        const { asAccountant, asClerk, correlation, now, ruleHistory, standard, throughTax, write } = scenario;

        // The page's plan for "23 % from 1. 1. 2027": end the 21 % rate there, then add 23 % open-ended.
        const before = classificationView(CZ_VAT_STANDARD, yield* ruleHistory(yield* asAccountant), now, false);
        if (before.state !== 'ready') {
          return yield* Effect.die('The standard rate exists');
        }
        const from = day('2027-01-01');
        const plan = planRateChange(before, from, now);
        if (plan === 'alreadyPlanned' || plan === 'notInFuture') {
          return yield* Effect.die(`The plan is refused: ${plan}`);
        }
        expect(plan.end?.revisionRef).toEqual(standard.initialRevisionRef);
        const ended = yield* throughTax(
          executeEndTaxRuleRevisionWithAuthorization(
            {
              endedEffectiveTo: from,
              expectedBasisFingerprint: before.basisFingerprint,
              provenanceRef: 'ontos:finance-billing:vat-settings',
              reason: 'Změna zákona o DPH',
              taxRuleRevisionRef: standard.initialRevisionRef,
            },
            yield* asAccountant,
            yield* correlation,
            yield* write,
          ),
        );
        expect(ended.ended).toBe(true);
        const afterEnd = yield* ruleHistory(yield* asAccountant);
        const created = yield* throughTax(
          executeCreateTaxRuleRevisionWithAuthorization(
            {
              content: {
                compositionKind: 'EXCLUSIVE',
                effectiveFrom: plan.create.effectiveFrom,
                jurisdiction: 'CZ_DOMESTIC',
                ratePercent: '23',
                taxClassificationCode: CZ_VAT_STANDARD,
                treatmentCategory: 'TAXABLE',
              },
              expectedBasisFingerprint: afterEnd.basisFingerprint,
              provenanceRef: 'ontos:finance-billing:vat-settings',
              reason: 'Změna zákona o DPH',
              replacesRevisionRef: standard.initialRevisionRef,
              taxRuleRef: standard.taxRuleRef,
            },
            yield* asAccountant,
            yield* correlation,
            yield* write,
          ),
        );
        expect(created.created).toBe(true);

        // A second change against the basis the page showed before is refused, never applied over the first.
        const stale = yield* throughTax(
          executeEndTaxRuleRevisionWithAuthorization(
            {
              endedEffectiveTo: day('2028-01-01'),
              expectedBasisFingerprint: before.basisFingerprint,
              provenanceRef: 'ontos:finance-billing:vat-settings',
              reason: 'Souběžná změna',
              taxRuleRevisionRef: created.taxRuleRevisionRef,
            },
            yield* asAccountant,
            yield* correlation,
            yield* write,
          ),
        ).pipe(Effect.flip);
        expect(stale._tag).toBe('EndTaxRuleRevisionActionConflictProblem');

        // The page lists 21 % as the current rate and 23 % from 1. 1. 2027 as planned.
        const after = classificationView(CZ_VAT_STANDARD, yield* ruleHistory(yield* asAccountant), now, false);
        if (after.state !== 'ready') {
          return yield* Effect.die('The standard rate exists');
        }
        expect(after.current?.ratePercent).toBe('21');
        expect(after.scheduled.map((entry) => [DateTime.formatIso(entry.from), entry.ratePercent])).toEqual([
          [DateTime.formatIso(from), '23'],
        ]);

        // The clerk holds no Tax right: Tax refuses the read the DPH page makes, and the page shows "no access".
        const refused = yield* scenario.ruleSet(CZ_VAT_STANDARD, yield* asClerk).pipe(Effect.flip);
        expect(refused._tag).toBe('ApplicableTaxRuleSetForbiddenProblem');
        const refusedAction = yield* throughTax(
          executeEndTaxRuleRevisionWithAuthorization(
            {
              endedEffectiveTo: from,
              expectedBasisFingerprint: (yield* ruleHistory(yield* asAccountant)).basisFingerprint,
              provenanceRef: 'ontos:finance-billing:vat-settings',
              reason: 'Pokus bez oprávnění',
              taxRuleRevisionRef: created.taxRuleRevisionRef,
            },
            yield* asClerk,
            yield* correlation,
            yield* write,
          ),
        ).pipe(Effect.flip);
        expect(refusedAction._tag).toBe('EndTaxRuleRevisionActionForbiddenProblem');
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(live)),
  120_000,
);

it.live(
  'Finance reads the company rates and regime from Tax for a clerk without Tax rights',
  () =>
    Effect.scoped(
      Effect.gen(function* financeCallerPath() {
        const scenario = yield* setUp();
        const { correlation, financeForClerk, now, read, ruleSet, throughTax } = scenario;
        const standardSet = yield* ruleSet(CZ_VAT_STANDARD, yield* financeForClerk());
        expect(standardSet.outcome).toBe('SELECTED');
        expect(standardSet.applicable.map((entry) => entry.ratePercent)).toEqual(['21']);
        expect(standardSet.applicable[0]?.taxRuleRevisionRef).toEqual(scenario.standard.initialRevisionRef);
        const reducedSet = yield* ruleSet(CZ_VAT_REDUCED, yield* financeForClerk());
        expect(reducedSet.applicable.map((entry) => entry.ratePercent)).toEqual(['12']);
        const regime = yield* throughTax(
          executeSellerVatRegimeAtInstantWithAuthorization(
            { instant: now },
            yield* financeForClerk(),
            yield* correlation,
            read,
          ),
        );
        expect(regime.selection).toMatchObject({ _tag: 'DECLARED', regime: 'VAT_PAYER' });
        // A module Tax does not name cannot act for the clerk.
        const undeclared = yield* ruleSet(CZ_VAT_STANDARD, yield* financeForClerk(scenario.undeclaredModule)).pipe(
          Effect.flip,
        );
        expect(undeclared._tag).toBe('ApplicableTaxRuleSetForbiddenProblem');
      }),
    ).pipe(Effect.provide(live)),
  120_000,
);

it.live(
  'an accountant with only the Tax reads sees rates and regime with history; Tax offers and admits her no change',
  () =>
    Effect.scoped(
      Effect.gen(function* readOnlyAccountant() {
        const scenario = yield* setUp();
        const { asAccountant, asReader, correlation, now, regimeHistory, ruleHistory, ruleSet, standard, write } =
          scenario;
        // What the DPH page reads as her: the rate, its history and the regime with its history.
        const applicable = yield* ruleSet(CZ_VAT_STANDARD, yield* asReader);
        expect(applicable.applicable.length).toBe(1);
        const view = classificationView(CZ_VAT_STANDARD, yield* ruleHistory(yield* asReader), now, false);
        expect(view.state === 'ready' ? view.current?.ratePercent : undefined).toBe('21');
        const history = yield* regimeHistory(yield* asReader);
        expect(history.revisions.map(({ regime }) => regime)).toEqual(['VAT_PAYER']);
        // Tax tells the page she may make no change, and the author, who holds the rights, every one.
        expect(history.changeRights).toEqual({
          createRevision: false,
          createRule: false,
          declareRegime: false,
          endRevision: false,
        });
        expect((yield* regimeHistory(yield* asAccountant)).changeRights).toEqual({
          createRevision: true,
          createRule: true,
          declareRegime: true,
          endRevision: true,
        });
        // A change sent anyway is refused by Tax: a new rate, ending the current one, and the regime declaration.
        const from = day('2027-01-01');
        const created = yield* scenario
          .throughTax(
            executeCreateTaxRuleRevisionWithAuthorization(
              {
                content: {
                  compositionKind: 'EXCLUSIVE',
                  effectiveFrom: from,
                  jurisdiction: 'CZ_DOMESTIC',
                  ratePercent: '23',
                  taxClassificationCode: CZ_VAT_STANDARD,
                  treatmentCategory: 'TAXABLE',
                },
                expectedBasisFingerprint: (yield* ruleHistory(yield* asReader)).basisFingerprint,
                provenanceRef: 'ontos:finance-billing:vat-settings',
                reason: 'Pokus bez oprávnění',
                taxRuleRef: standard.taxRuleRef,
              },
              yield* asReader,
              yield* correlation,
              yield* write,
            ),
          )
          .pipe(Effect.flip);
        expect(created._tag).toBe('CreateTaxRuleRevisionActionForbiddenProblem');
        const [current] = (yield* ruleHistory(yield* asReader)).revisions;
        if (current === undefined) {
          return yield* Effect.die('The standard rate has a revision');
        }
        const ended = yield* scenario
          .throughTax(
            executeEndTaxRuleRevisionWithAuthorization(
              {
                endedEffectiveTo: from,
                expectedBasisFingerprint: (yield* ruleHistory(yield* asReader)).basisFingerprint,
                provenanceRef: 'ontos:finance-billing:vat-settings',
                reason: 'Pokus bez oprávnění',
                taxRuleRevisionRef: current.taxRuleRevisionRef,
              },
              yield* asReader,
              yield* correlation,
              yield* write,
            ),
          )
          .pipe(Effect.flip);
        expect(ended._tag).toBe('EndTaxRuleRevisionActionForbiddenProblem');
        const declared = yield* scenario
          .throughTax(
            executeDeclareSellerVatRegimeWithAuthorization(
              { effectiveFrom: from, expectedCurrentRevision: 1, reason: 'Pokus bez oprávnění', regime: 'NON_PAYER' },
              yield* asReader,
              yield* correlation,
              yield* write,
            ),
          )
          .pipe(Effect.flip);
        expect(declared._tag).toBe('DeclareSellerVatRegimeActionForbiddenProblem');
        // Nothing changed.
        expect((yield* regimeHistory(yield* asReader)).revisions.length).toBe(1);
        expect((yield* ruleHistory(yield* asReader)).revisions.length).toBe(1);
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(live)),
  120_000,
);
