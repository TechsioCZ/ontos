/**
 * The VAT baseline seed against the real Core and tax runtimes on the local integration database.
 *
 * A private Tenant with three companies gets `commerce.tax` through Core's own module-state Action, then the seed runs
 * through tax's real Actions and governed reads (Core runner, PostgreSQL/RLS, tax handlers, Core idempotency). The one
 * access gate is scripted per company and capability, as the tax suites do: this proves installation, the seed's
 * writes, its idempotency and its refusal of a missing right, not persisted v2 role currentness (the role scripts'
 * unit tests and the stage dry-run cover the rights themselves). Every row of the private Tenant is removed afterwards.
 */
import { randomUUID } from 'node:crypto';

import { NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { Config, Context, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  ActiveApplicationCompositionService,
  ContextAccess,
  CorePersistenceLive,
  DatabaseConfig,
  DatabaseIdentityEnrollmentContext,
  InstalledModuleCatalogService,
  ModuleEntrypointGateway,
  ModuleStateGate,
  OperationalScopeResolver,
  ReadRuntime,
  TenantModuleStateServiceLive,
  TrustedPrincipalContextSchema,
  changeTenantModuleStateAction,
  defineDatabaseIdentityEnrollment,
  makeDatabaseIdentityEnrollmentLive,
  makeReadRuntimeLive,
  parseDatabaseConfig,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  LegalEntityCandidates,
  seamRefusal,
} from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService, GateInput, ListGateInput } from '@app/core-runtime/access/enforcement';
import {
  ActionPermission,
  ActionRepositoryLive,
  ModuleEntrypointGatewayLive,
  ModuleStateGateLive,
  OperationalScopeResolverLive,
} from '@app/core-runtime/actions/runtime-wiring';
import {
  STAFF_AUTHENTICATION_NAMESPACE_ID,
  staffAuthenticationNamespaceRegistryLayer,
} from '@app/core-runtime/auth/staff-authentication-namespace';

import type { AccessDecision } from '../../packages/core-runtime/src/access/decision/contract.ts';
import { DecisionCheck } from '../../packages/core-runtime/src/access/decision/engine.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { ActionRepository } from '../../packages/core-runtime/src/actions/repository.ts';
import { makeActionRuntime } from '../../packages/core-runtime/src/actions/runtime.ts';
import { CoreDatabase } from '../../packages/core-runtime/src/db/client.ts';
import { buildApplicationCompositionCatalog } from '../../packages/core-runtime/src/modules/application-composition-catalog.ts';
import { bindAccessGate } from '../../packages/core-runtime/src/operations/access-gate.ts';
import { inertAccessEnforcementPorts } from '../../packages/core-runtime/src/testing/access-gate.ts';
import { allowTenantPermissions } from '../../packages/core-runtime/tests/support/action-runtime-options.ts';
import { makeTestPgClient } from '../../packages/core-runtime/tests/support/database.ts';
import { createTaxRuleAction } from '../../verticals/tax/src/actions/create-tax-rule.action.ts';
import { declareSellerVatRegimeAction } from '../../verticals/tax/src/actions/declare-seller-vat-regime.action.ts';
import { applicableTaxRuleSetRead } from '../../verticals/tax/src/api/applicable-tax-rule-set.read.ts';
import { sellerVatRegimeAtInstantRead } from '../../verticals/tax/src/api/seller-vat-regime-at-instant.read.ts';
import { publishedTaxComposition } from '../../verticals/tax/tests/support/published-tax-composition.ts';
import { taxRegistration } from '../../verticals/tax/vertical.registration.ts';
import {
  refused,
  runTaxBaseline,
  taxBaselineRights,
  toDeclareAnswer,
  toRegimeObservation,
  toRuleObservation,
} from '../demo/seed-tax-baseline.mts';
import type {
  RightCheck,
  TaxBaselineCompanyPort,
  TaxBaselineTenantPort,
  TaxCallRefusal,
} from '../demo/seed-tax-baseline.mts';

const TAX_MODULE = 'commerce.tax';
const LocalHostSchema = Schema.Literals(['localhost', '127.0.0.1']);
const services = Layer.mergeAll(NodeCrypto.layer, NodeServices.layer);
const allowedPermission = { checkActionPermission: () => Effect.succeed('allowed' as const) };

/** Core's own refusals, onto the seed's vocabulary, by the error's tag. */
const missingRight = (detail: string): TaxCallRefusal => ({ _tag: 'MissingRight', detail });
const conflict = (detail: string): TaxCallRefusal => ({ _tag: 'Conflict', detail });
const refusalByTag = new Map([
  ['ActionAlreadyCommitted', (): TaxCallRefusal => ({ _tag: 'AlreadyCommitted' })],
  ['ActionPermissionDenied', missingRight],
  ['ReadPermissionDenied', missingRight],
  ['TaxGovernanceConflict', conflict],
  ['TaxGovernanceStaleBasis', conflict],
]);
const transport = (idempotencyKey: string) => ({ correlationId: randomUUID(), idempotencyKey });
const reasonOf = <A extends object>(effect: Effect.Effect<A, { readonly _tag: string; readonly reason?: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => failure.reason ?? failure._tag),
  );
const RuntimeFailureSchema = Schema.Struct({ _tag: Schema.String, code: Schema.optionalKey(Schema.String) });
const asRefusal = <E extends object>(error: E) => {
  const failure = Schema.decodeUnknownOption(RuntimeFailureSchema)(error);
  const tag = Option.match(failure, { onNone: () => 'unknown', onSome: ({ _tag }) => _tag });
  const detail = Option.match(failure, { onNone: () => 'unknown', onSome: ({ _tag, code }) => code ?? _tag });
  const known = refusalByTag.get(tag);
  return refused(known === undefined ? { _tag: 'Unavailable', detail } : known(detail));
};

const allowedDecision = (): AccessDecision => ({
  evidence: [],
  outcome: 'ALLOWED',
  reasons: [{ code: 'allow.granted' }],
  selectors: [],
});
const grantKey = (scope: string, capabilityKey: string) => `${scope} ${capabilityKey}`;
const scopeOf = (input: GateInput | ListGateInput) => input.scope.legalEntityId ?? 'tenant';

/** The one access gate, scripted per company (or the Tenant) and capability; a revoked right is the engine's refusal. */
const makeCapabilityGate = (companyIds: readonly string[], grants: Set<string>) => {
  const answer = (input: GateInput | ListGateInput): AccessDecision =>
    grants.has(grantKey(scopeOf(input), input.carrier.accessDeclaration?.key ?? ''))
      ? allowedDecision()
      : seamRefusal('deny.insufficient_grant');
  const gate: AccessDecisionService = {
    decide: (input) => Effect.succeed(answer(input)),
    decideMany: (input) => Effect.succeed(input.map(answer)),
    list: (input) => {
      const decision = answer(input);
      return Effect.succeed(decision.outcome === 'ALLOWED' ? { decision, predicate: { groups: [] } } : { decision });
    },
    selectableLegalEntities: () => Effect.succeed(companyIds.map((id) => LegalEntityIdSchema.make(id))),
  };
  const ports = inertAccessEnforcementPorts();
  return {
    bound: bindAccessGate(gate, ports),
    layer: Layer.mergeAll(
      Layer.succeed(AccessDecisionGate, gate),
      Layer.succeed(AccessIntent, ports.intent),
      Layer.succeed(AccessDecisionLog, ports.decisionLog),
      Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
      Layer.succeed(DecisionCheck, ports.check),
      Layer.succeed(LegalEntityCandidates, ports.candidates),
    ),
  };
};

const AuthorityRowSchema = Schema.Struct({
  authority: Schema.Struct({
    durable_work_admission: Schema.String,
    phase: Schema.String,
    revision: Schema.String,
    subscriptions_json: Schema.Unknown,
    updated_at: Schema.String,
    valid_until: Schema.String,
  }),
});
const TableRowSchema = Schema.Struct({ table_name: Schema.String, table_schema: Schema.String });
const CountRowSchema = Schema.Struct({ count: Schema.String });
const StateRowSchema = Schema.Struct({ state: Schema.String });

const fixture = Effect.fn('TaxBaselineSeed.fixture')(function* fixtureEffect() {
  const adminUrl = yield* Config.String('DATABASE_ADMIN_URL');
  const runtimeUrl = yield* Config.String('DATABASE_URL');
  const addresses = yield* Effect.forEach([adminUrl, runtimeUrl], (address) =>
    Schema.decodeEffect(Schema.URLFromString)(address),
  );
  if (addresses.some((address) => !Schema.is(LocalHostSchema)(address.hostname))) {
    return yield* Effect.die('The tax baseline integration test runs only against a local database');
  }
  const admin: PgClient.PgClient = yield* makeTestPgClient(adminUrl);
  const query = (statement: string, values: readonly unknown[] = []) => admin.unsafe(statement, [...values]);
  const rows = <S extends Schema.Top>(schema: S, statement: string, values: readonly unknown[] = []) =>
    query(statement, values).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(schema))));
  // Share the publication lock Core's native suites use while this Tenant's composition authority is active.
  yield* Effect.acquireRelease(
    query("SELECT pg_advisory_lock(hashtextextended('ontos.search-test-authority', 0))"),
    () => query("SELECT pg_advisory_unlock(hashtextextended('ontos.search-test-authority', 0))").pipe(Effect.orDie),
  );
  const { deployment, snapshot } = yield* publishedTaxComposition;
  const previous = yield* rows(
    AuthorityRowSchema,
    'SELECT row_to_json(a) AS authority FROM core.application_composition_authority a',
  );
  const tenantId = randomUUID();
  const principalId = randomUUID();
  const authBindingId = randomUUID();
  const companies = [
    { legalEntityId: randomUUID(), name: 'Daňová firma A' },
    { legalEntityId: randomUUID(), name: 'Daňová firma B' },
    { legalEntityId: randomUUID(), name: 'Daňová firma C' },
  ] as const;
  const companyIds = companies.map(({ legalEntityId }) => legalEntityId);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* releaseTaxBaselineFixture() {
      yield* query('BEGIN');
      yield* query('SET LOCAL session_replication_role = replica');
      // Append-only and FK triggers are off only while this private Tenant's rows are removed, as Core's suites do.
      const tables = yield* rows(
        TableRowSchema,
        "SELECT table_schema, table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND table_schema IN ('core', 'tax')",
      );
      yield* Effect.forEach(
        tables,
        (table) =>
          query(`DELETE FROM "${table.table_schema}"."${table.table_name}" WHERE tenant_id = $1::uuid`, [tenantId]),
        { discard: true },
      );
      yield* query('DELETE FROM core.application_composition_authority WHERE revision = $1', [
        snapshot.composition.revision,
      ]);
      yield* Effect.forEach(
        previous,
        ({ authority }) =>
          query(
            'INSERT INTO core.application_composition_authority (revision, phase, durable_work_admission, valid_until, subscriptions_json, updated_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              authority.revision,
              authority.phase,
              authority.durable_work_admission,
              authority.valid_until,
              JSON.stringify(authority.subscriptions_json),
              authority.updated_at,
            ],
          ),
        { discard: true },
      );
      yield* query('COMMIT');
    }).pipe(Effect.orDie),
  );
  yield* query(
    "INSERT INTO core.application_composition_authority (revision,phase,valid_until,subscriptions_json) VALUES ($1,'active',now()+interval '1 hour','[]') ON CONFLICT (authority_key) DO UPDATE SET revision=EXCLUDED.revision,phase='active',durable_work_admission='open',valid_until=EXCLUDED.valid_until,subscriptions_json='[]'",
    [snapshot.composition.revision],
  );
  yield* query(
    "INSERT INTO core.tenants (tenant_id,slug,name,status,default_locale) VALUES ($1,$2,'Tax baseline fixture','active','cs')",
    [tenantId, `tax-baseline-${tenantId}`],
  );
  yield* query(
    "INSERT INTO core.principals (principal_id,tenant_id,kind,display_name,status) VALUES ($1,$2,'human','Tax baseline operator','active')",
    [principalId, tenantId],
  );
  yield* query(
    "INSERT INTO core.principal_auth_bindings (principal_auth_binding_id,tenant_id,principal_id,authentication_namespace_id,provider,subject_type,provider_subject_id,status) VALUES ($1::uuid,$2,$3,$4,'better-auth','user',$1::text,'active')",
    [authBindingId, tenantId, principalId, STAFF_AUTHENTICATION_NAMESPACE_ID],
  );
  for (const company of companies) {
    yield* query(
      "INSERT INTO core.legal_entities (legal_entity_id,tenant_id,legal_name,registration_country,registration_number,status) VALUES ($1::uuid,$2,$3,'CZ',$1::text,'active')",
      [company.legalEntityId, tenantId, company.name],
    );
  }
  // The runner re-decides every protected Action under its access scope's fence: seed each scope Ready, as bootstrap does.
  for (const legalEntityId of [null, ...companyIds]) {
    const scopeId = randomUUID();
    yield* query(
      'INSERT INTO core.access_scopes (scope_id,tenant_id,tenant_context_id,legal_entity_id) VALUES ($1,$2,$3,$4)',
      [scopeId, tenantId, legalEntityId === null ? tenantId : null, legalEntityId],
    );
    yield* query("INSERT INTO core.access_scope_fences (scope_id,tenant_id,state,revision) VALUES ($1,$2,'Ready',1)", [
      scopeId,
      tenantId,
    ]);
  }
  // The operator may install modules tenant-wide and holds the four tax rights in every company but C's rule creation.
  const grants = new Set<string>([
    grantKey('tenant', changeTenantModuleStateAction.descriptor.accessDeclaration?.key ?? ''),
  ]);
  for (const legalEntityId of companyIds) {
    for (const right of Object.values(taxBaselineRights)) {
      grants.add(grantKey(legalEntityId, right));
    }
  }
  const { 2: third } = companies;
  grants.delete(grantKey(third.legalEntityId, taxBaselineRights.createRule));
  const gate = makeCapabilityGate(companyIds, grants);

  const persistence = CorePersistenceLive;
  const contextAccess = Layer.succeed(ContextAccess, allowTenantPermissions);
  const stateGate = ModuleStateGateLive.pipe(
    Layer.provide(TenantModuleStateServiceLive.pipe(Layer.provide(persistence))),
  );
  const entrypoints = ModuleEntrypointGatewayLive.pipe(Layer.provide(stateGate));
  const resolver = OperationalScopeResolverLive.pipe(
    Layer.provide(Layer.mergeAll(persistence, contextAccess, gate.layer)),
  );
  const dependencies = Layer.mergeAll(persistence, contextAccess, entrypoints, stateGate, resolver, gate.layer);
  const compositionSource = Layer.succeed(ActiveApplicationCompositionService, { load: Effect.succeed(snapshot) });
  const runtimes = Layer.mergeAll(
    dependencies,
    makeReadRuntimeLive(deployment, taxRegistration).pipe(
      Layer.provide(dependencies),
      Layer.provide(compositionSource),
    ),
    ActionRepositoryLive,
    Layer.succeed(ActionPermission, allowedPermission),
    compositionSource,
  ).pipe(
    Layer.provide(Layer.succeed(DatabaseConfig, yield* parseDatabaseConfig({ DATABASE_URL: runtimeUrl }))),
    Layer.provideMerge(staffAuthenticationNamespaceRegistryLayer(['tax'])),
    Layer.provideMerge(makeDatabaseIdentityEnrollmentLive(defineDatabaseIdentityEnrollment([]))),
    Layer.provide(NodeServices.layer),
  );
  const context = yield* Layer.build(runtimes);
  const runtimeFor = (ownerDeployment: typeof deployment, owner?: typeof taxRegistration) => {
    const options = {
      // Keep the scripted gate bound: a live authority preparation cannot rebind a double. The runner still owns
      // module admission, composition locking, transactions, idempotency and access fences.
      accessDecision: gate.bound,
      applicationComposition: Context.get(context, ActiveApplicationCompositionService),
      contextAccess: Context.get(context, ContextAccess),
      databaseIdentities: Context.get(context, DatabaseIdentityEnrollmentContext),
      expectedDeployment: ownerDeployment,
      moduleEntrypointGateway: Context.get(context, ModuleEntrypointGateway),
      moduleStateGate: Context.get(context, ModuleStateGate),
    };
    return makeActionRuntime(
      Context.get(context, CoreDatabase),
      Context.get(context, ActionRepository),
      Context.get(context, ActionPermission),
      Context.get(context, OperationalScopeResolver),
      owner === undefined ? options : { ...options, ownerRegistration: owner },
    );
  };
  const coreActions = runtimeFor(snapshot.composition.shell.deployment);
  const taxActions = runtimeFor(deployment, taxRegistration);
  const reads = Context.get(context, ReadRuntime);
  const catalog = yield* buildApplicationCompositionCatalog(snapshot.composition);

  const operator = {
    authBindingId,
    authContextRef: `better-auth-session:${authBindingId}`,
    authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session' as const,
    principalId,
    tenantId,
  };
  const principalFor = (legalEntityId?: string) =>
    Schema.decodeEffect(TrustedPrincipalContextSchema)(
      legalEntityId === undefined ? operator : { ...operator, legalEntityId },
    ).pipe(
      // Fixture the already-authenticated gateway boundary; assertion redemption is covered by tax's own suites.
      Effect.map((principal) => trustVerifiedGatewayPrincipalContext(principal, snapshot.composition.revision)),
    );

  const installTax = principalFor().pipe(
    Effect.flatMap((principal) =>
      coreActions.runAction({
        payload: {
          expectedState: 'inactive',
          moduleKey: TAX_MODULE,
          newState: 'active',
          reason: 'Integration: commerce.tax for the private selling Tenant',
        },
        principal,
        registration: changeTenantModuleStateAction,
        transport: { ...transport(`tax-baseline-install:${tenantId}`), targetModuleKey: 'core.modules' },
      }),
    ),
    Effect.provideService(InstalledModuleCatalogService, { loadForRevision: () => Effect.succeed(catalog) }),
    Effect.provide(context),
  );
  const moduleState = rows(
    StateRowSchema,
    'SELECT state FROM core.tenant_module_states WHERE tenant_id=$1 AND module_key=$2',
    [tenantId, TAX_MODULE],
  ).pipe(Effect.map((found) => found.at(0)?.state ?? 'none'));
  const count = (table: string) =>
    rows(CountRowSchema, `SELECT count(*)::text AS count FROM tax.${table} WHERE tenant_id = $1::uuid`, [
      tenantId,
    ]).pipe(Effect.map((found) => Number(found.at(0)?.count ?? '0')));

  const companyPort = (legalEntityId: string): TaxBaselineCompanyPort => {
    const asCompany = principalFor(legalEntityId);
    const write = <A extends object>(run: (principal: Effect.Success<typeof asCompany>) => Effect.Effect<A, object>) =>
      asCompany.pipe(
        Effect.orDie,
        Effect.flatMap((principal) => run(principal).pipe(Effect.mapError(asRefusal))),
      );
    return {
      applicableRules: (taxClassificationCode, at) =>
        write((principal) =>
          reads
            .runRead({
              audience: 'tax',
              input: { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode, taxRelevantTime: at },
              principal,
              registration: applicableTaxRuleSetRead,
              transport: transport(randomUUID()),
            })
            .pipe(Effect.provide(context)),
        ).pipe(Effect.map(toRuleObservation)),
      checkRight: (capabilityKey) =>
        Effect.succeed<RightCheck>(
          grants.has(grantKey(legalEntityId, capabilityKey))
            ? { _tag: 'Allowed' }
            : { _tag: 'Denied', reasons: ['DENIED', 'deny.insufficient_grant'] },
        ),
      createRule: (payload, idempotencyKey) =>
        write((principal) =>
          taxActions
            .runAction({
              audience: 'tax',
              // The runner decodes the wire form, exactly as the HTTP handler receives it.
              payload: Schema.encodeSync(createTaxRuleAction.descriptor.payloadSchema)(payload),
              principal,
              registration: createTaxRuleAction,
              transport: transport(idempotencyKey),
            })
            .pipe(Effect.provide(context)),
        ).pipe(Effect.map(({ created }) => ({ created }))),
      declareRegime: (payload, idempotencyKey) =>
        write((principal) =>
          taxActions
            .runAction({
              audience: 'tax',
              payload: Schema.encodeSync(declareSellerVatRegimeAction.descriptor.payloadSchema)(payload),
              principal,
              registration: declareSellerVatRegimeAction,
              transport: transport(idempotencyKey),
            })
            .pipe(Effect.provide(context)),
        ).pipe(Effect.map(toDeclareAnswer)),
      regimeAt: (instant) =>
        write((principal) =>
          reads
            .runRead({
              audience: 'tax',
              input: { instant },
              principal,
              registration: sellerVatRegimeAtInstantRead,
              transport: transport(randomUUID()),
            })
            .pipe(Effect.provide(context)),
        ).pipe(Effect.map(toRegimeObservation)),
    };
  };
  const tenant: TaxBaselineTenantPort = {
    companies: companies.map(({ legalEntityId, name }) => ({
      legalEntityId: LegalEntityIdSchema.make(legalEntityId),
      name,
    })),
    company: (legalEntityId) => Effect.succeed(companyPort(legalEntityId)),
    operatorPrincipalId: PrincipalIdSchema.make(principalId),
    tenantId: TenantIdSchema.make(tenantId),
  };
  return {
    allowed: new Map([[tenantId, 'Integrační tenant']]),
    companyPort,
    count,
    grantCreate: () => grants.add(grantKey(third.legalEntityId, taxBaselineRights.createRule)),
    installTax,
    moduleState,
    tenant,
  };
});

it.layer(services, { excludeTestServices: true })('tax baseline seed on the local integration stack', (suite) => {
  suite.effect('installs commerce.tax through Core, seeds through tax Actions, and a second apply adds nothing', () =>
    Effect.scoped(
      Effect.gen(function* seedTwice() {
        const test = yield* fixture();
        const { allowed, tenant } = test;
        const run = (mode: 'apply' | 'dry-run' | 'verify', reviewed = Option.none<string>()) =>
          runTaxBaseline(mode, tenant, reviewed, { allowedTenants: allowed });

        // Before installation tax refuses every governed read: the module is not active in the Tenant.
        expect(yield* test.moduleState).toBe('none');
        expect(yield* reasonOf(run('dry-run'))).toContain('readRegime is unavailable');
        yield* test.installTax;
        expect(yield* test.moduleState).toBe('active');

        // First plan: three companies, each the regime and both rules; company C lacks the rule right.
        const first = yield* run('dry-run');
        expect(first.plan.writes).toHaveLength(9);
        expect(first.problems).toEqual([
          `Daňová firma C: the operator lacks the right ${taxBaselineRights.createRule} (DENIED, deny.insufficient_grant)`,
        ]);
        expect(yield* reasonOf(run('apply', Option.some(first.fingerprint)))).toContain(taxBaselineRights.createRule);
        expect(yield* test.count('tax_rules')).toBe(0);
        expect(yield* test.count('tax_seller_vat_regime_declarations')).toBe(0);

        // With the right granted, apply writes everything once through the real Actions.
        test.grantCreate();
        const reviewed = yield* run('dry-run');
        const applied = yield* run('apply', Option.some(reviewed.fingerprint));
        expect(applied.outcomes).toHaveLength(9);
        expect(applied.outcomes.every(({ created }) => created)).toBe(true);
        expect(
          applied.reports.flatMap(({ regime, rules }) => [regime.state, ...rules.map(({ state }) => state)]),
        ).toEqual(Array.from({ length: 9 }, () => 'present'));
        const counts = {
          declarations: yield* test.count('tax_seller_vat_regime_declarations'),
          revisions: yield* test.count('tax_rule_revisions'),
          rules: yield* test.count('tax_rules'),
        };
        expect(counts).toEqual({ declarations: 3, revisions: 6, rules: 6 });

        // Second run: nothing to plan, nothing sent, no new revision.
        const again = yield* run('dry-run');
        expect(again.plan.writes).toEqual([]);
        const reapplied = yield* run('apply', Option.some(again.fingerprint));
        expect(reapplied.outcomes).toEqual([]);
        // Re-sending the first run's writes under their keys answers "already committed" (created: false) from Core.
        for (const write of applied.plan.writes) {
          const port = test.companyPort(write.legalEntityId);
          const resent =
            write._tag === 'CreateRule'
              ? port.createRule(
                  {
                    initialRevision: {
                      compositionKind: 'EXCLUSIVE',
                      effectiveFrom: write.effectiveFrom,
                      jurisdiction: 'CZ_DOMESTIC',
                      ratePercent: write.ratePercent,
                      taxClassificationCode: write.classificationCode,
                      treatmentCategory: 'TAXABLE',
                    },
                    meaningKind: 'VAT_RATE',
                    provenanceRef: 'ontos-demo:tax-baseline:v1',
                    reason: 'Výchozí sazba DPH ukázkových dat (sazby zákona o DPH od 1. 1. 2024)',
                    stableCode: write.stableCode,
                  },
                  write.idempotencyKey,
                )
              : port.declareRegime(
                  {
                    effectiveFrom: write.effectiveFrom,
                    expectedCurrentRevision: 0,
                    reason: 'Výchozí stav ukázkových dat: plátce DPH od 1. 1. 2024',
                    regime: write.regime,
                  },
                  write.idempotencyKey,
                );
          const refusal = yield* resent.pipe(Effect.flip);
          expect(refusal).toMatchObject({ _tag: 'TaxCallRefused', refusal: { _tag: 'AlreadyCommitted' } });
        }
        expect({
          declarations: yield* test.count('tax_seller_vat_regime_declarations'),
          revisions: yield* test.count('tax_rule_revisions'),
          rules: yield* test.count('tax_rules'),
        }).toEqual(counts);

        const verified = yield* run('verify');
        expect(verified.problems).toEqual([]);
        expect(
          verified.reports
            .map(({ name, regime }) => `${name}: ${regime.detail}`)
            .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual([
          'Daňová firma A: plátce DPH od 2024-01-01',
          'Daňová firma B: plátce DPH od 2024-01-01',
          'Daňová firma C: plátce DPH od 2024-01-01',
        ]);
        expect(
          verified.reports.flatMap(({ rules }) =>
            rules.map(({ classificationCode, detail }) => `${classificationCode} ${detail}`),
          ),
        ).toEqual(
          Array.from({ length: 3 }, () => [
            'cz.vat.standard 21 % od 2024-01-01',
            'cz.vat.reduced 12 % od 2024-01-01',
          ]).flat(),
        );
      }),
    ),
  );
});
