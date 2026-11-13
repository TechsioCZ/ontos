import { DateTime, Duration, Effect, Option, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { PLATFORM_TENANT } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import { createTaxRuleAction } from '../../verticals/tax/src/actions/create-tax-rule.action.ts';
import { declareSellerVatRegimeAction } from '../../verticals/tax/src/actions/declare-seller-vat-regime.action.ts';
import { applicableTaxRuleSetRead } from '../../verticals/tax/src/api/applicable-tax-rule-set.read.ts';
import { sellerVatRegimeAtInstantRead } from '../../verticals/tax/src/api/seller-vat-regime-at-instant.read.ts';
import { AKROS_PLAYGROUND_TENANT_ID } from './stage-tenant-modules.mts';
import { demoTenantId } from './fixture-ids.mts';
import {
  CZ_VAT_REDUCED,
  CZ_VAT_STANDARD,
  refusalOfProblem,
  refused,
  regimeIdempotencyKey,
  renderTaxBaseline,
  ruleIdempotencyKey,
  runTaxBaseline,
  sameRate,
  TAX_BASELINE_EFFECTIVE_FROM,
  czechCalendarDate,
  TaxBaselineFailure,
  taxBaselineRights,
  validateSeedOrigin,
  waitForRightsOf,
} from './seed-tax-baseline.mts';
import type {
  RegimeObservation,
  RightCheck,
  RuleObservation,
  TaxBaselineCompanyPort,
  TaxBaselineTenantPort,
  TaxCallRefusal,
} from './seed-tax-baseline.mts';

const tenantId = TenantIdSchema.make(demoTenantId);
const operatorPrincipalId = PrincipalIdSchema.make('72000000-0000-4000-8000-000000000021');
const tradingId = LegalEntityIdSchema.make('71000000-0000-4000-8000-000000000020');
const shopId = LegalEntityIdSchema.make('71000000-0000-4000-8000-000000000024');
const companies = [
  { legalEntityId: tradingId, name: 'Obchodní firma' },
  { legalEntityId: shopId, name: 'Šroubárna Vysočina s.r.o.' },
];
const baseline = DateTime.makeUnsafe(TAX_BASELINE_EFFECTIVE_FROM);
const createRight = taxBaselineRights.createRule;
const declareRight = taxBaselineRights.declareRegime;
const insufficientGrant = ['DENIED', 'deny.insufficient_grant'];

interface FakeRule {
  readonly classificationCode: string;
  readonly effectiveFrom: DateTime.Utc;
  readonly ratePercent: string;
  readonly stableCode: string;
}
interface FakeCompany {
  readonly committed: Set<string>;
  /** Calls whose write another run already committed under the same key: applied, but answered "committed". */
  readonly committedElsewhere: Set<string>;
  readonly denied: Map<string, readonly string[]>;
  /** A denied right becomes effective after this many explain checks, as a release reconcile would land. */
  readonly grantAfter: Map<string, number>;
  /** A runtime refusal the next matching write answers with, as the Action runner would. */
  readonly refuseNext: Map<string, TaxCallRefusal>;
  readonly regimes: { readonly effectiveFrom: DateTime.Utc; readonly regime: string }[];
  readonly rules: FakeRule[];
  unchecked: boolean;
}

const rightCheckOf = (company: FakeCompany, capabilityKey: string): RightCheck => {
  if (company.unchecked) {
    return { _tag: 'Unchecked', detail: 'explain answered HTTP 403' };
  }
  const reasons = company.denied.get(capabilityKey);
  return reasons === undefined ? { _tag: 'Allowed' } : { _tag: 'Denied', reasons };
};

/** An in-memory tax module with tax's own idempotency and stable-code rules, one per company. */
const makeFakeTax = () => {
  const state = new Map<string, FakeCompany>(
    companies.map(({ legalEntityId }) => [
      legalEntityId,
      {
        committed: new Set(),
        committedElsewhere: new Set(),
        denied: new Map(),
        grantAfter: new Map(),
        refuseNext: new Map(),
        regimes: [],
        rules: [],
        unchecked: false,
      },
    ]),
  );
  const sent: string[] = [];
  const checks: string[] = [];
  const of = (legalEntityId: string) => {
    const company = state.get(legalEntityId);
    if (company === undefined) {
      throw new Error(`unknown company ${legalEntityId}`);
    }
    return company;
  };
  const companyPort = (legalEntityId: string): TaxBaselineCompanyPort => {
    const company = of(legalEntityId);
    const refusal = (call: string, key: string) => {
      const next = company.refuseNext.get(call);
      company.refuseNext.delete(call);
      return next ?? (company.committed.has(key) ? refused({ _tag: 'AlreadyCommitted' }).refusal : undefined);
    };
    return {
      applicableRules: (classificationCode, at) =>
        Effect.succeed<RuleObservation>({
          applicable: company.rules
            .filter(
              (rule) =>
                rule.classificationCode === classificationCode && !DateTime.isGreaterThan(rule.effectiveFrom, at),
            )
            .map((rule) => ({
              effectiveFrom: rule.effectiveFrom,
              effectiveTo: Option.none(),
              ratePercent: rule.ratePercent,
              revisionNumber: 1,
            })),
          outcome: company.rules.some((rule) => rule.classificationCode === classificationCode)
            ? 'SELECTED'
            : 'TAX_RULE_MISSING',
        }),
      checkRight: (capabilityKey) =>
        Effect.sync(() => {
          checks.push(`${legalEntityId} ${capabilityKey}`);
          const left = company.grantAfter.get(capabilityKey);
          if (left !== undefined) {
            company.grantAfter.set(capabilityKey, left - 1);
            if (left <= 1) {
              company.denied.delete(capabilityKey);
            }
          }
          return rightCheckOf(company, capabilityKey);
        }),
      createRule: (payload, key) => {
        sent.push(key);
        const refusedWith = refusal('createRule', key);
        if (refusedWith !== undefined) {
          return Effect.fail(refused(refusedWith));
        }
        if (company.rules.some((rule) => rule.stableCode === payload.stableCode)) {
          return Effect.fail(refused({ _tag: 'Conflict', detail: 'tax_governance_conflict' }));
        }
        company.committed.add(key);
        company.rules.push({
          classificationCode: payload.initialRevision.taxClassificationCode,
          effectiveFrom: payload.initialRevision.effectiveFrom,
          ratePercent: payload.initialRevision.ratePercent,
          stableCode: payload.stableCode,
        });
        return company.committedElsewhere.delete('createRule')
          ? Effect.fail(refused({ _tag: 'AlreadyCommitted' }))
          : Effect.succeed({ created: true });
      },
      declareRegime: (payload, key) => {
        sent.push(key);
        const refusedWith = refusal('declareRegime', key);
        if (refusedWith !== undefined) {
          return Effect.fail(refused(refusedWith));
        }
        if (payload.expectedCurrentRevision !== company.regimes.length) {
          return Effect.fail(refused({ _tag: 'Conflict', detail: 'tax_governance_stale_basis' }));
        }
        expect(payload.reason).toBeDefined();
        company.committed.add(key);
        company.regimes.push({ effectiveFrom: payload.effectiveFrom, regime: payload.regime });
        return company.committedElsewhere.delete('declareRegime')
          ? Effect.fail(refused({ _tag: 'AlreadyCommitted' }))
          : Effect.succeed({ created: true, declared: true });
      },
      regimeAt: (at) => {
        const live = company.regimes.findLast(({ effectiveFrom }) => !DateTime.isGreaterThan(effectiveFrom, at));
        return Effect.succeed<RegimeObservation>({
          headRevision: company.regimes.length,
          selection:
            live === undefined
              ? { _tag: 'NOT_DECLARED' }
              : { _tag: 'DECLARED', effectiveFrom: live.effectiveFrom, regime: live.regime },
        });
      },
    };
  };
  const tenant: TaxBaselineTenantPort = {
    companies,
    company: (legalEntityId) => Effect.succeed(companyPort(legalEntityId)),
    operatorPrincipalId,
    tenantId,
  };
  return { checks, of, sent, tenant };
};

/** The operator selects every company of the Tenant: the count apply and verify are told to expect. */
const everyCompany = (tenant: TaxBaselineTenantPort) => ({ companiesExpected: tenant.companies.length });
const dryRun = (tenant: TaxBaselineTenantPort) => runTaxBaseline('dry-run', tenant, Option.none());
const applyReviewed = (tenant: TaxBaselineTenantPort) =>
  dryRun(tenant).pipe(
    Effect.flatMap(({ fingerprint }) =>
      runTaxBaseline('apply', tenant, Option.some(fingerprint), everyCompany(tenant)),
    ),
  );
const failureReason = <A extends object>(effect: Effect.Effect<A, { readonly _tag: string }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((failure) => (Schema.is(TaxBaselineFailure)(failure) ? failure.reason : failure._tag)),
  );

it('names exactly the rights commerce.tax declares for the four calls it makes', () => {
  expect(taxBaselineRights).toEqual({
    createRule: createTaxRuleAction.descriptor.accessDeclaration?.key,
    declareRegime: declareSellerVatRegimeAction.descriptor.accessDeclaration?.key,
    readRegime: sellerVatRegimeAtInstantRead.descriptor.accessDeclaration?.key,
    readRules: applicableTaxRuleSetRead.descriptor.accessDeclaration?.key,
  });
  expect([CZ_VAT_STANDARD, CZ_VAT_REDUCED]).toEqual(['cz.vat.standard', 'cz.vat.reduced']);
});

it('starts the baseline at Prague midnight of 1 January 2024, the Czech calendar day, not at UTC midnight', () => {
  const prague = DateTime.toParts(DateTime.setZone(baseline, DateTime.zoneMakeNamedUnsafe('Europe/Prague')));
  expect([prague.year, prague.month, prague.day, prague.hour, prague.minute, prague.second]).toEqual([
    2024, 1, 1, 0, 0, 0,
  ]);
  expect(DateTime.formatIso(baseline)).toBe('2023-12-31T23:00:00.000Z');
  expect(czechCalendarDate(baseline)).toBe('1. 1. 2024');
  // One millisecond earlier is still the last day of 2023 in Prague.
  expect(czechCalendarDate(DateTime.subtract(baseline, { milliseconds: 1 }))).toBe('31. 12. 2023');
});

it.effect('plans the regime and both rules for an empty company, with fixed keys and a stable fingerprint', () =>
  Effect.gen(function* emptyPlan() {
    const { sent, tenant } = makeFakeTax();
    const first = yield* dryRun(tenant);
    expect(first.problems).toEqual([]);
    expect(first.plan.writes).toHaveLength(6);
    expect(first.plan.writes.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      regimeIdempotencyKey(tenantId, tradingId),
      ruleIdempotencyKey(tenantId, tradingId, CZ_VAT_STANDARD),
      ruleIdempotencyKey(tenantId, tradingId, CZ_VAT_REDUCED),
      regimeIdempotencyKey(tenantId, shopId),
      ruleIdempotencyKey(tenantId, shopId, CZ_VAT_STANDARD),
      ruleIdempotencyKey(tenantId, shopId, CZ_VAT_REDUCED),
    ]);
    expect(first.plan.writes[1]).toMatchObject({
      _tag: 'CreateRule',
      classificationCode: CZ_VAT_STANDARD,
      ratePercent: '21',
    });
    expect(first.plan.writes[2]).toMatchObject({
      _tag: 'CreateRule',
      classificationCode: CZ_VAT_REDUCED,
      ratePercent: '12',
    });
    expect(first.plan.writes[0]).toMatchObject({
      _tag: 'DeclareRegime',
      expectedCurrentRevision: 0,
      regime: 'VAT_PAYER',
    });
    // Every write starts on the Prague day start of 1 January 2024, and the fingerprint covers that instant.
    expect(first.plan.writes.map(({ effectiveFrom }) => DateTime.formatIso(effectiveFrom))).toEqual(
      Array.from({ length: 6 }, () => '2023-12-31T23:00:00.000Z'),
    );
    expect((yield* dryRun(tenant)).fingerprint).toBe(first.fingerprint);
    // A dry run sends nothing.
    expect(sent).toEqual([]);
  }),
);

it.effect('apply writes once; a second apply plans nothing, sends nothing and adds no revision', () =>
  Effect.gen(function* idempotentApply() {
    const { of, sent, tenant } = makeFakeTax();
    const applied = yield* applyReviewed(tenant);
    expect(applied.outcomes).toHaveLength(6);
    expect(applied.outcomes.every(({ created }) => created)).toBe(true);
    expect(applied.reports.every((report) => report.regime.state === 'present')).toBe(true);
    expect(applied.reports.flatMap(({ rules }) => rules.map(({ state }) => state))).toEqual([
      'present',
      'present',
      'present',
      'present',
    ]);
    expect(of(tradingId).regimes).toHaveLength(1);
    expect(of(tradingId).regimes[0]?.effectiveFrom).toEqual(baseline);
    const again = yield* applyReviewed(tenant);
    expect(again.plan.writes).toEqual([]);
    expect(again.outcomes).toEqual([]);
    expect(sent).toHaveLength(6);
    expect(of(tradingId).regimes).toHaveLength(1);
    expect(of(shopId).rules).toHaveLength(2);
    const verified = yield* runTaxBaseline('verify', tenant, Option.none(), everyCompany(tenant));
    expect(verified.problems).toEqual([]);
  }),
);

it.effect('apply and verify refuse, naming the gap, unless the operator selects every company expected', () =>
  Effect.gen(function* companyCoverage() {
    const { tenant } = makeFakeTax();
    yield* applyReviewed(tenant);
    const selectable = tenant.companies.length;
    // Nothing proves the Tenant has no other company: without the expected count neither mode vouches for it.
    expect(yield* failureReason(runTaxBaseline('verify', tenant, Option.none()))).toContain(
      `verify needs --companies-expected <n>: the operator can select ${selectable} companies`,
    );
    const planned = yield* runTaxBaseline('dry-run', tenant, Option.none());
    expect(yield* failureReason(runTaxBaseline('apply', tenant, Option.some(planned.fingerprint)))).toContain(
      'apply needs --companies-expected',
    );
    // The Tenant has one company more than the operator can select: refused, never passed with the gap.
    expect(
      yield* failureReason(runTaxBaseline('verify', tenant, Option.none(), { companiesExpected: selectable + 1 })),
    ).toBe(
      `The operator can act for ${selectable} of the Tenant's ${selectable + 1} companies and cannot act for 1; run it from a session that can select every company`,
    );
    expect(
      yield* failureReason(runTaxBaseline('verify', tenant, Option.none(), { companiesExpected: selectable - 1 })),
    ).toContain('more than the');
    const verified = yield* runTaxBaseline('verify', tenant, Option.none(), everyCompany(tenant));
    expect(verified.reports).toHaveLength(selectable);
  }),
);

it.effect('a write whose key already committed counts as done (created: false), never as a retry', () =>
  Effect.gen(function* alreadyCommitted() {
    const { of, tenant } = makeFakeTax();
    // An earlier run committed the regime under the same key after this run read the state; its answer was lost.
    of(tradingId).committedElsewhere.add('declareRegime');
    const applied = yield* applyReviewed(tenant);
    expect(
      applied.outcomes.find(({ kind, legalEntityId }) => kind === 'DeclareRegime' && legalEntityId === tradingId),
    ).toMatchObject({ created: false, idempotencyKey: regimeIdempotencyKey(tenantId, tradingId) });
    expect(of(tradingId).regimes).toHaveLength(1);
  }),
);

it.effect('an Action that answers "committed" while the read still shows nothing fails apply instead of passing', () =>
  Effect.gen(function* committedButAbsent() {
    const { of, tenant } = makeFakeTax();
    of(tradingId).refuseNext.set('declareRegime', { _tag: 'AlreadyCommitted' });
    expect(yield* failureReason(applyReviewed(tenant))).toContain('did not leave the baseline in place');
  }),
);

it.effect('refuses apply without the reviewed fingerprint, or with a stale one', () =>
  Effect.gen(function* fingerprintGate() {
    const { sent, tenant } = makeFakeTax();
    expect(yield* failureReason(runTaxBaseline('apply', tenant, Option.none(), everyCompany(tenant)))).toContain(
      '--reviewed-plan-sha256',
    );
    expect(
      yield* failureReason(runTaxBaseline('apply', tenant, Option.some('0'.repeat(64)), everyCompany(tenant))),
    ).toContain('--reviewed-plan-sha256');
    expect(sent).toEqual([]);
  }),
);

it.effect('never overwrites a regime or rule set differently, and names it', () =>
  Effect.gen(function* differing() {
    const { of, sent, tenant } = makeFakeTax();
    of(tradingId).rules.push({
      classificationCode: CZ_VAT_STANDARD,
      effectiveFrom: baseline,
      ratePercent: '20',
      stableCode: 'legacy.standard',
    });
    of(shopId).regimes.push({ effectiveFrom: baseline, regime: 'NON_PAYER' });
    const planned = yield* dryRun(tenant);
    expect(planned.problems).toEqual([
      'Obchodní firma: cz.vat.standard differs from the baseline (SELECTED: 20 % od 1. 1. 2024); change it in the product',
      'Šroubárna Vysočina s.r.o.: VAT regime differs from the baseline (nyní NON_PAYER od 1. 1. 2024, revize 1); change it in the product',
    ]);
    const reason = yield* failureReason(
      runTaxBaseline('apply', tenant, Option.some(planned.fingerprint), everyCompany(tenant)),
    );
    expect(reason).toContain('cz.vat.standard differs');
    expect(sent).toEqual([]);
    expect(yield* failureReason(runTaxBaseline('verify', tenant, Option.none(), everyCompany(tenant)))).toContain(
      'differs',
    );
  }),
);

it.effect('stops before any write when explain shows the operator lacks a needed right, naming it', () =>
  Effect.gen(function* missingRight() {
    const { of, sent, tenant } = makeFakeTax();
    of(shopId).denied.set(declareRight, insufficientGrant);
    const planned = yield* dryRun(tenant);
    expect(planned.problems).toEqual([
      `Šroubárna Vysočina s.r.o.: the operator lacks the right ${declareRight} (DENIED, deny.insufficient_grant)`,
    ]);
    expect(renderTaxBaseline(tenantId, planned.reports)).toContain(`chybí právo: ${declareRight}`);
    const reason = yield* failureReason(
      runTaxBaseline('apply', tenant, Option.some(planned.fingerprint), everyCompany(tenant)),
    );
    expect(reason).toContain(declareRight);
    expect(sent).toEqual([]);
  }),
);

it.effect('a right explain could not check is decided by the Action, and its refusal names the right', () =>
  Effect.gen(function* runtimeDenial() {
    const { of, tenant } = makeFakeTax();
    of(tradingId).unchecked = true;
    of(tradingId).refuseNext.set('createRule', { _tag: 'MissingRight', detail: 'action_permission_denied' });
    const planned = yield* dryRun(tenant);
    expect(planned.problems).toEqual([]);
    expect(renderTaxBaseline(tenantId, planned.reports)).toContain('práva nešlo předem ověřit');
    const reason = yield* failureReason(
      runTaxBaseline('apply', tenant, Option.some(planned.fingerprint), everyCompany(tenant)),
    );
    expect(reason).toBe(`Obchodní firma: the operator lacks the right ${createRight} (action_permission_denied)`);
  }),
);

it.live('waits for rights that become effective after a deploy, then plans with them', () =>
  Effect.gen(function* waitForRights() {
    const { checks, of, tenant } = makeFakeTax();
    const shop = of(shopId);
    shop.denied.set(declareRight, insufficientGrant);
    // The release reconcile lands while the seed waits: the third check of the right finds it effective.
    shop.grantAfter.set(declareRight, 3);
    const planned = yield* runTaxBaseline('dry-run', tenant, Option.none(), {
      waitForRights: { attempts: 5, spacing: Duration.millis(1) },
    });
    expect(planned.problems).toEqual([]);
    expect(planned.plan.writes).toHaveLength(6);
    expect(checks.filter((check) => check === `${shopId} ${declareRight}`)).toHaveLength(3);
    // A right that never arrives is reported by name once the patience is spent.
    shop.grantAfter.delete(declareRight);
    shop.denied.set(declareRight, insufficientGrant);
    const impatient = yield* runTaxBaseline('dry-run', tenant, Option.none(), {
      waitForRights: { attempts: 2, spacing: Duration.millis(1) },
    });
    expect(impatient.problems).toEqual([
      `Šroubárna Vysočina s.r.o.: the operator lacks the right ${declareRight} (DENIED, deny.insufficient_grant)`,
    ]);
  }),
);

it.effect('the human table names companies only; ids appear in the JSON plan alone', () =>
  Effect.gen(function* humanTable() {
    const { tenant } = makeFakeTax();
    const applied = yield* applyReviewed(tenant);
    const table = renderTaxBaseline(tenantId, applied.reports);
    expect(table).toContain('Tenant: Prodejní demo');
    expect(table).toContain('Obchodní firma');
    expect(table).toContain('režim DPH: plátce DPH od 1. 1. 2024 [ok]');
    expect(table).toContain('cz.vat.standard: 21 % od 1. 1. 2024 [ok]');
    expect(table).toContain('cz.vat.reduced: 12 % od 1. 1. 2024 [ok]');
    expect(table).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  }),
);

it.effect(
  'accepts any Tenant that serves people, never the platform Tenant, and only a bare HTTPS or loopback origin',
  () =>
    Effect.gen(function* targets() {
      const stage = 'https://ontos-stage.web-revolution.cz';
      // The release installs Tax wherever Finance Billing or Merchandise is active, so any such Tenant is seeded.
      for (const accepted of [AKROS_PLAYGROUND_TENANT_ID, '70000000-0000-4000-8000-000000000010']) {
        expect((yield* validateSeedOrigin(stage, accepted)).origin).toBe(stage);
      }
      for (const [url, tenant] of [
        [stage, PLATFORM_TENANT.tenantId],
        [`${stage}/cs`, demoTenantId],
        ['https://user:secret@ontos-stage.web-revolution.cz', demoTenantId],
      ] as const) {
        expect(yield* failureReason(validateSeedOrigin(url, tenant))).not.toBe('');
      }
      const { tenant } = makeFakeTax();
      const platform = { ...tenant, tenantId: TenantIdSchema.make(PLATFORM_TENANT.tenantId) };
      expect(yield* failureReason(dryRun(platform))).toContain('never the platform Tenant');
      const other = { ...tenant, tenantId: TenantIdSchema.make('70000000-0000-4000-8000-000000000090') };
      expect(Result.isSuccess(yield* dryRun(other).pipe(Effect.result))).toBe(true);
    }),
);

const problem = (status: number, code?: string) =>
  refusalOfProblem(Option.some(code === undefined ? { detail: 'x', status } : { code, detail: 'x', status }));

it('maps tax Problem Details onto the seed refusals and compares exact decimal rates', () => {
  expect(problem(409, 'action_already_committed')).toEqual({ _tag: 'AlreadyCommitted' });
  expect(problem(403, 'action_permission_denied')).toEqual({
    _tag: 'MissingRight',
    detail: 'action_permission_denied',
  });
  expect(problem(403)).toEqual({ _tag: 'MissingRight', detail: 'x' });
  expect(problem(409, 'tax_governance_conflict')).toEqual({ _tag: 'Conflict', detail: 'tax_governance_conflict' });
  expect(problem(503, 'module_state_check_unavailable')).toEqual({
    _tag: 'Unavailable',
    detail: 'module_state_check_unavailable',
  });
  expect(refusalOfProblem(Option.none())).toEqual({ _tag: 'Unavailable', detail: 'transport failure' });
  expect(sameRate('21', '21.00')).toBe(true);
  expect(sameRate('12.0', '12')).toBe(true);
  expect(sameRate('21', '2.1')).toBe(false);
});

it('caps --wait-seconds at half an hour and never waits for a negative time', () => {
  expect(waitForRightsOf(600).attempts).toBe(60);
  expect(waitForRightsOf(5).attempts).toBe(1);
  expect(waitForRightsOf(0).attempts).toBe(0);
  expect(waitForRightsOf(-30).attempts).toBe(0);
  expect(waitForRightsOf(1_000_000).attempts).toBe(180);
  expect(Duration.toSeconds(waitForRightsOf(600).spacing)).toBe(10);
});
