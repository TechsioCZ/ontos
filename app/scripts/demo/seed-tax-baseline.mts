/// <reference types="node" />
/**
 * The VAT baseline of every company in a selling stage Tenant, created only through `commerce.tax`'s own Actions.
 *
 *   node scripts/demo/seed-tax-baseline.mts --mode dry-run [--json]
 *   node scripts/demo/seed-tax-baseline.mts --mode apply --companies-expected <n> --reviewed-plan-sha256 <sha> [--json]
 *   node scripts/demo/seed-tax-baseline.mts --mode verify --companies-expected <n> [--json]
 *
 * The operator's session lists only the companies it can select, and no product endpoint proves the Tenant has no
 * others, so apply and verify need the Tenant's company count (`--companies-expected`) and refuse, naming how many
 * companies the operator cannot act for, when the session selects a different number; nothing is skipped silently.
 *
 * Per company (each one the operator can select in the Tenant), from a company-scoped session: the seller is a VAT
 * payer from 1 January 2024, and the two Czech domestic VAT rules exist (`cz.vat.standard` 21 %, `cz.vat.reduced` 12 %,
 * both from 1 January 2024). The day starts at Prague midnight. Nothing in the repository's company fixtures marks a company as a non-payer.
 *
 * The run first reads the current state through tax's governed reads and plans only what is missing. A regime or
 * rule somebody already set differently is never overwritten: the plan stops and names it. A re-run plans no write,
 * so `apply` twice adds no revision. Before a write it asks the Shell's "Proč?" explain endpoint whether the operator
 * holds each needed right in that company and refuses with the missing right's key; an Action refusal is mapped to
 * the same message. Apply needs the dry-run's plan fingerprint, which covers every write.
 *
 * Environment: ONTOS_DEMO_SEED_URL, ONTOS_DEMO_SEED_EMAIL, ONTOS_DEMO_SEED_PASSWORD, ONTOS_DEMO_SEED_TENANT_ID.
 * The password is never printed. Any Tenant that serves people is accepted (the release installs Tax wherever Finance
 * Billing or Merchandise is active); the platform's own Tenant never is.
 */
import { createHash, randomUUID } from 'node:crypto';

import { NodeServices } from '@effect/platform-node';
import {
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Redacted,
  Schedule,
  Schema,
} from 'effect';
import type { Scope } from 'effect';
import { Command, Flag } from 'effect/cli';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import {
  ExplainAccessPayloadSchema,
  ExplainAccessResponseSchema,
} from '../../apps/shell-super-app/shared/access-admin-api.ts';
import { AvailableLegalEntitiesResponseSchema, SignInPayloadSchema } from '../../apps/shell-super-app/shared/api.ts';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '../../packages/core-runtime/src/access/ids.ts';
import { tenantServesPeople } from '../../packages/core-runtime/src/auth/module-credentials.ts';
import type { CreateTaxRulePayload } from '../../verticals/tax/shared/actions/create-tax-rule.ts';
import type { DeclareSellerVatRegimePayload } from '../../verticals/tax/shared/actions/declare-seller-vat-regime.ts';
import { executeApplicableTaxRuleSetWithAuthorization } from '../../verticals/tax/src/api/applicable-tax-rule-set-client.ts';
import { executeCreateTaxRuleWithAuthorization } from '../../verticals/tax/src/api/create-tax-rule-action-client.ts';
import { executeDeclareSellerVatRegimeWithAuthorization } from '../../verticals/tax/src/api/declare-seller-vat-regime-action-client.ts';
import { executeSellerVatRegimeAtInstantWithAuthorization } from '../../verticals/tax/src/api/seller-vat-regime-at-instant-client.ts';
import { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';

import { AKROS_PLAYGROUND_TENANT_ID } from './stage-tenant-modules.mts';
import { demoTenantId } from './fixture-ids.mts';
import { N1_TENANT_ID } from './n1-stage-grants.mts';

type LegalEntityId = typeof LegalEntityIdSchema.Type;
type PrincipalId = typeof PrincipalIdSchema.Type;
type TenantId = typeof TenantIdSchema.Type;

// --- the baseline -------------------------------------------------------------------------------------

/** The two Czech VAT classifications, as the shared contract names them (re-exported for the tests). */
export { CZ_VAT_REDUCED, CZ_VAT_STANDARD } from '@app/shared-contracts/cz-vat-classifications';

/**
 * The day both rates and the payer regime start: 1 January 2024. VAT effective dates are Czech calendar dates, so
 * the day starts at Prague midnight, the instant 2023-12-31T23:00:00Z (CET, UTC+1). Finance writes and looks up its
 * rules with Prague day starts: under a UTC-midnight start an invoice dated 1 January 2024 would find no rate. No
 * Prague day helper exists outside the verticals, so the instant is a constant; a test pins it to Prague midnight.
 */
export const TAX_BASELINE_EFFECTIVE_FROM = '2023-12-31T23:00:00.000Z';
const baselineEffectiveFrom = DateTime.makeUnsafe(TAX_BASELINE_EFFECTIVE_FROM);
const PRAGUE = DateTime.zoneMakeNamedUnsafe('Europe/Prague');

/** The Czech calendar date an instant falls on in Prague, written the Czech way: `1. 1. 2024`. */
export const czechCalendarDate = (instant: DateTime.DateTime): string => {
  const { day, month, year } = DateTime.toParts(DateTime.setZone(instant, PRAGUE));
  return `${String(day)}. ${String(month)}. ${String(year)}`;
};

export interface BaselineRule {
  readonly classificationCode: string;
  readonly ratePercent: string;
  /** Creation is keyed by this code inside the company; tax refuses a second rule with it. */
  readonly stableCode: string;
}
export const taxBaselineRules: readonly BaselineRule[] = [
  { classificationCode: CZ_VAT_STANDARD, ratePercent: '21', stableCode: CZ_VAT_STANDARD },
  { classificationCode: CZ_VAT_REDUCED, ratePercent: '12', stableCode: CZ_VAT_REDUCED },
];
export const TAX_BASELINE_REGIME = 'VAT_PAYER';
const PROVENANCE = 'ontos-demo:tax-baseline:v1';
const RULE_REASON = 'Výchozí sazba DPH ukázkových dat (sazby zákona o DPH od 1. 1. 2024)';
const REGIME_REASON = 'Výchozí stav ukázkových dat: plátce DPH od 1. 1. 2024';

/** The selling stage Tenants this seed may write to, with the label the human output uses instead of an id. */
/** The names the summary gives the stage Tenants it knows; any other Tenant is named by the operator's session. */
export const taxBaselineTenants: ReadonlyMap<string, string> = new Map([
  [demoTenantId, 'Prodejní demo'],
  [N1_TENANT_ID, 'N1 demo'],
  [AKROS_PLAYGROUND_TENANT_ID, 'AKROS playground'],
]);

/** Every tax call the seed makes, and the right `commerce.tax` declares for it (the unit test pins them). */
export const TaxCallSchema = Schema.Literals(['createRule', 'declareRegime', 'readRegime', 'readRules']);
export type TaxCall = typeof TaxCallSchema.Type;
export const taxBaselineRights = {
  createRule: 'commerce.tax.tax-rule.create',
  declareRegime: 'commerce.tax.seller-vat-regime-declaration.declare',
  readRegime: 'commerce.tax.seller-vat-regime.read-at-instant',
  readRules: 'commerce.tax.tax-rule-set.read',
} as const satisfies Record<TaxCall, string>;
const allRights: readonly string[] = Object.values(taxBaselineRights);

// --- what a port answers --------------------------------------------------------------------------------

export class TaxBaselineFailure extends Schema.TaggedError<TaxBaselineFailure>()('TaxBaselineFailure', {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}
const fail = (reason: string) => new TaxBaselineFailure({ reason });

/** Why one tax call was refused; a port maps its transport's problems onto these. */
export const TaxCallRefusalSchema = Schema.Union([
  Schema.TaggedStruct('AlreadyCommitted', {}),
  Schema.TaggedStruct('Conflict', { detail: Schema.String }),
  Schema.TaggedStruct('MissingRight', { detail: Schema.String }),
  Schema.TaggedStruct('Unavailable', { detail: Schema.String }),
]);
export type TaxCallRefusal = typeof TaxCallRefusalSchema.Type;
/** A refused tax call in a port's error channel, beside `TaxBaselineFailure`. */
export const TaxCallRefusedSchema = Schema.TaggedStruct('TaxCallRefused', { refusal: TaxCallRefusalSchema });
export type TaxCallRefused = typeof TaxCallRefusedSchema.Type;
export const refused = (refusal: TaxCallRefusal): TaxCallRefused => TaxCallRefusedSchema.make({ refusal });

/** The explain answer for one right: allowed, denied with its reason codes, or not checkable by this operator. */
export const RightCheckSchema = Schema.Union([
  Schema.TaggedStruct('Allowed', {}),
  Schema.TaggedStruct('Denied', { reasons: Schema.Array(Schema.String) }),
  Schema.TaggedStruct('Unchecked', { detail: Schema.String }),
]);
export type RightCheck = typeof RightCheckSchema.Type;

export const RegimeSelectionSchema = Schema.Union([
  Schema.TaggedStruct('DECLARED', { effectiveFrom: Schema.DateTimeUtc, regime: Schema.String }),
  Schema.TaggedStruct('NOT_DECLARED', {}),
]);
export const RegimeObservationSchema = Schema.Struct({
  headRevision: Schema.Int,
  selection: RegimeSelectionSchema,
});
export type RegimeObservation = typeof RegimeObservationSchema.Type;
export const RuleObservationSchema = Schema.Struct({
  applicable: Schema.Array(
    Schema.Struct({
      effectiveFrom: Schema.DateTimeUtc,
      effectiveTo: Schema.Option(Schema.DateTimeUtc),
      ratePercent: Schema.String,
      revisionNumber: Schema.Int,
    }),
  ),
  outcome: Schema.String,
});
export type RuleObservation = typeof RuleObservationSchema.Type;

export interface DeclareRegimeAnswer {
  readonly created: boolean;
  readonly declared: boolean;
}
export interface CreateRuleAnswer {
  readonly created: boolean;
}

/** One company-scoped session of the operator. */
export interface TaxBaselineCompanyPort {
  readonly applicableRules: (
    classificationCode: string,
    at: DateTime.Utc,
  ) => Effect.Effect<RuleObservation, TaxCallRefused | TaxBaselineFailure>;
  readonly checkRight: (capabilityKey: string) => Effect.Effect<RightCheck, TaxBaselineFailure>;
  readonly createRule: (
    payload: CreateTaxRulePayload,
    idempotencyKey: string,
  ) => Effect.Effect<CreateRuleAnswer, TaxCallRefused | TaxBaselineFailure>;
  readonly declareRegime: (
    payload: DeclareSellerVatRegimePayload,
    idempotencyKey: string,
  ) => Effect.Effect<DeclareRegimeAnswer, TaxCallRefused | TaxBaselineFailure>;
  readonly regimeAt: (at: DateTime.Utc) => Effect.Effect<RegimeObservation, TaxCallRefused | TaxBaselineFailure>;
}
export interface TaxBaselineCompany {
  readonly legalEntityId: LegalEntityId;
  readonly name: string;
}
/** The operator signed in to one Tenant. */
export interface TaxBaselineTenantPort {
  readonly companies: readonly TaxBaselineCompany[];
  readonly company: (
    legalEntityId: LegalEntityId,
  ) => Effect.Effect<TaxBaselineCompanyPort, TaxBaselineFailure, Scope.Scope>;
  readonly operatorPrincipalId: PrincipalId;
  readonly tenantId: TenantId;
}

// --- observation, plan, fingerprint ------------------------------------------------------------------

export interface CompanyObservation extends TaxBaselineCompany {
  readonly regime: RegimeObservation;
  readonly rights: ReadonlyMap<string, RightCheck>;
  readonly rules: ReadonlyMap<string, RuleObservation>;
}

export const ItemStateSchema = Schema.Literals(['differs', 'missing', 'present']);
export type ItemState = typeof ItemStateSchema.Type;
export interface ItemVerdict {
  readonly detail: string;
  readonly state: ItemState;
}

export const TaxBaselineIdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('TaxBaselineIdempotencyKey'),
);
export type TaxBaselineIdempotencyKey = typeof TaxBaselineIdempotencyKeySchema.Type;

export const DeclareRegimeWriteSchema = Schema.TaggedStruct('DeclareRegime', {
  effectiveFrom: Schema.DateTimeUtcFromString,
  expectedCurrentRevision: Schema.Int,
  idempotencyKey: TaxBaselineIdempotencyKeySchema,
  legalEntityId: LegalEntityIdSchema,
  regime: Schema.Literal(TAX_BASELINE_REGIME),
});
export const CreateRuleWriteSchema = Schema.TaggedStruct('CreateRule', {
  classificationCode: Schema.String,
  effectiveFrom: Schema.DateTimeUtcFromString,
  idempotencyKey: TaxBaselineIdempotencyKeySchema,
  legalEntityId: LegalEntityIdSchema,
  ratePercent: Schema.String,
  stableCode: Schema.String,
});
export const PlannedWriteSchema = Schema.Union([DeclareRegimeWriteSchema, CreateRuleWriteSchema]);
export type PlannedWrite = typeof PlannedWriteSchema.Type;

/** The plan a reviewer signs: exactly the writes, for exactly this operator and Tenant. */
export const TaxBaselinePlanSchema = Schema.Struct({
  operatorPrincipalId: PrincipalIdSchema,
  schemaVersion: Schema.Literal(1),
  tenantId: TenantIdSchema,
  writes: Schema.Array(PlannedWriteSchema),
});
export type TaxBaselinePlan = typeof TaxBaselinePlanSchema.Type;

export interface MissingRight {
  readonly reasons: readonly string[];
  /** The capability key of the right. */
  readonly right: string;
}
export interface RuleVerdict extends ItemVerdict {
  readonly classificationCode: string;
}
export interface CompanyReport {
  readonly legalEntityId: LegalEntityId;
  readonly missingRights: readonly MissingRight[];
  readonly name: string;
  readonly regime: ItemVerdict;
  readonly rightsChecked: boolean;
  readonly rules: readonly RuleVerdict[];
}
export interface CompanyPlan {
  readonly report: CompanyReport;
  readonly writes: readonly PlannedWrite[];
}
export interface TaxBaselinePlanning {
  readonly plan: TaxBaselinePlan;
  /** Why apply would refuse: a differing item or a missing right, by company name. */
  readonly problems: readonly string[];
  readonly reports: readonly CompanyReport[];
}

const keyPrefix = 'ontos-demo-tax-baseline:v1';
/** Fixed per Tenant, company and item, so a retry after an uncertain answer re-sends the same Action request. */
export const regimeIdempotencyKey = (tenantId: TenantId, legalEntityId: LegalEntityId) =>
  TaxBaselineIdempotencyKeySchema.make(`${keyPrefix}:${tenantId}:${legalEntityId}:regime`);
export const ruleIdempotencyKey = (tenantId: TenantId, legalEntityId: LegalEntityId, stableCode: string) =>
  TaxBaselineIdempotencyKeySchema.make(`${keyPrefix}:${tenantId}:${legalEntityId}:rule:${stableCode}`);

/** `21`, `21.0` and `21.00` are one rate; the tax module stores exact decimals as text. */
const normalizedRate = (value: string) => (value.includes('.') ? value.replace(/\.?0+$/u, '') : value);
export const sameRate = (left: string, right: string): boolean => normalizedRate(left) === normalizedRate(right);
const isBaselineStart = (instant: DateTime.Utc) =>
  DateTime.toEpochMillis(instant) === DateTime.toEpochMillis(baselineEffectiveFrom);
const day = (instant: DateTime.Utc) => czechCalendarDate(instant);

export const regimeVerdict = (regime: RegimeObservation): ItemVerdict =>
  regime.headRevision === 0
    ? { detail: 'nic nevyhlášeno', state: 'missing' }
    : Match.valueTags(regime.selection, {
        DECLARED: ({ effectiveFrom, regime: declared }): ItemVerdict =>
          declared === TAX_BASELINE_REGIME && isBaselineStart(effectiveFrom)
            ? { detail: `plátce DPH od ${day(effectiveFrom)}`, state: 'present' }
            : { detail: `nyní ${declared} od ${day(effectiveFrom)}, revize ${regime.headRevision}`, state: 'differs' },
        NOT_DECLARED: (): ItemVerdict => ({
          detail: `revize ${regime.headRevision} existuje, ale dnes neplatí žádný režim`,
          state: 'differs',
        }),
      });

const revisionText = (revision: RuleObservation['applicable'][number]) =>
  `${revision.ratePercent} % od ${day(revision.effectiveFrom)}`;

export const ruleVerdict = (rule: BaselineRule, observed: RuleObservation | undefined): ItemVerdict => {
  if (observed === undefined || observed.outcome === 'TAX_RULE_MISSING') {
    return { detail: 'pravidlo chybí', state: 'missing' };
  }
  const [only, ...rest] = observed.applicable;
  if (
    observed.outcome === 'SELECTED' &&
    only !== undefined &&
    rest.length === 0 &&
    sameRate(only.ratePercent, rule.ratePercent) &&
    isBaselineStart(only.effectiveFrom) &&
    Option.isNone(only.effectiveTo)
  ) {
    return { detail: revisionText(only), state: 'present' };
  }
  const found = observed.applicable.map(revisionText).join(', ');
  return { detail: found === '' ? observed.outcome : `${observed.outcome}: ${found}`, state: 'differs' };
};

const rightOfWrite = (write: PlannedWrite): string =>
  Match.valueTags(write, {
    CreateRule: () => taxBaselineRights.createRule,
    DeclareRegime: () => taxBaselineRights.declareRegime,
  });

const deniedRights = (rights: ReadonlyMap<string, RightCheck>): readonly MissingRight[] =>
  [...rights.entries()].flatMap(([capabilityKey, check]) =>
    Match.valueTags(check, {
      Allowed: () => [],
      Denied: ({ reasons }) => [{ reasons, right: capabilityKey }],
      Unchecked: () => [],
    }),
  );
const allRightsChecked = (rights: ReadonlyMap<string, RightCheck>): boolean =>
  [...rights.values()].every((check) => !Schema.is(RightCheckSchema.members[2])(check));

/** The writes one company still needs, and its report. Pure: everything comes from the observation. */
export const planCompany = (tenantId: TenantId, observed: CompanyObservation): CompanyPlan => {
  const writes: PlannedWrite[] = [];
  const regime = regimeVerdict(observed.regime);
  if (regime.state === 'missing') {
    writes.push(
      DeclareRegimeWriteSchema.make({
        effectiveFrom: baselineEffectiveFrom,
        expectedCurrentRevision: 0,
        idempotencyKey: regimeIdempotencyKey(tenantId, observed.legalEntityId),
        legalEntityId: observed.legalEntityId,
        regime: TAX_BASELINE_REGIME,
      }),
    );
  }
  const rules = taxBaselineRules.map((rule): RuleVerdict => {
    const verdict = ruleVerdict(rule, observed.rules.get(rule.classificationCode));
    if (verdict.state === 'missing') {
      writes.push(
        CreateRuleWriteSchema.make({
          classificationCode: rule.classificationCode,
          effectiveFrom: baselineEffectiveFrom,
          idempotencyKey: ruleIdempotencyKey(tenantId, observed.legalEntityId, rule.stableCode),
          legalEntityId: observed.legalEntityId,
          ratePercent: rule.ratePercent,
          stableCode: rule.stableCode,
        }),
      );
    }
    return { classificationCode: rule.classificationCode, ...verdict };
  });
  return {
    report: {
      legalEntityId: observed.legalEntityId,
      missingRights: deniedRights(observed.rights),
      name: observed.name,
      regime,
      rightsChecked: allRightsChecked(observed.rights),
      rules,
    },
    writes,
  };
};

const companyProblems = ({ report, writes }: CompanyPlan): readonly string[] => [
  ...(report.regime.state === 'differs'
    ? [`${report.name}: VAT regime differs from the baseline (${report.regime.detail}); change it in the product`]
    : []),
  ...report.rules.flatMap((rule) =>
    rule.state === 'differs'
      ? [
          `${report.name}: ${rule.classificationCode} differs from the baseline (${rule.detail}); change it in the product`,
        ]
      : [],
  ),
  ...[...new Set(writes.map(rightOfWrite))].flatMap((right) =>
    report.missingRights
      .filter((missing) => missing.right === right)
      .map(({ reasons }) => `${report.name}: the operator lacks the right ${right} (${reasons.join(', ')})`),
  ),
];

/**
 * The whole Tenant's plan, or why it must stop: a regime or rule set differently than the baseline is never
 * overwritten, and a write the operator has no right to is refused before anything is sent, naming the right.
 */
export const planTaxBaseline = (
  tenantId: TenantId,
  operatorPrincipalId: PrincipalId,
  companies: readonly CompanyObservation[],
): TaxBaselinePlanning => {
  const planned = companies
    .toSorted((left, right) => left.legalEntityId.localeCompare(right.legalEntityId))
    .map((company) => planCompany(tenantId, company));
  return {
    plan: { operatorPrincipalId, schemaVersion: 1, tenantId, writes: planned.flatMap(({ writes }) => writes) },
    problems: planned.flatMap(companyProblems),
    reports: planned.map(({ report }) => report),
  };
};

export const taxBaselinePlanFingerprint = (plan: TaxBaselinePlan) =>
  Schema.encodeEffect(Schema.fromJsonString(TaxBaselinePlanSchema))(plan).pipe(
    Effect.map((text) => createHash('sha256').update(text).digest('hex')),
    Effect.mapError(() => fail('The plan could not be encoded for its fingerprint')),
  );

const stateMark = { differs: 'LIŠÍ SE', missing: 'chybí', present: 'ok' } as const satisfies Record<ItemState, string>;

/** The human table: display names only, never an id. */
export const renderTaxBaseline = (tenantId: string, reports: readonly CompanyReport[]): string => {
  const lines = [`Tenant: ${taxBaselineTenants.get(tenantId) ?? 'Tenant operátora'}`];
  for (const report of reports.toSorted((left, right) => left.name.localeCompare(right.name, 'cs'))) {
    lines.push(`  ${report.name}`, `    režim DPH: ${report.regime.detail} [${stateMark[report.regime.state]}]`);
    for (const rule of report.rules) {
      lines.push(`    ${rule.classificationCode}: ${rule.detail} [${stateMark[rule.state]}]`);
    }
    for (const missing of report.missingRights) {
      lines.push(`    chybí právo: ${missing.right}`);
    }
    if (!report.rightsChecked) {
      lines.push('    práva nešlo předem ověřit (vysvětlení „Proč?“ není dostupné); rozhodne až Akce');
    }
  }
  return lines.join('\n');
};

// --- the engine ---------------------------------------------------------------------------------------

/** A refused call, as the operator reads it: which company, which right or which conflict. */
export const explainRefusal = (company: TaxBaselineCompany, call: TaxCall, refusal: TaxCallRefusal) =>
  fail(
    Match.valueTags(refusal, {
      AlreadyCommitted: () => `${company.name}: ${call} was already committed under its key; re-run verify`,
      Conflict: ({ detail }) => `${company.name}: tax refused ${call} as conflicting with existing data (${detail})`,
      MissingRight: ({ detail }) =>
        `${company.name}: the operator lacks the right ${taxBaselineRights[call]} (${detail})`,
      Unavailable: ({ detail }) => `${company.name}: ${call} is unavailable (${detail}); nothing else was sent`,
    }),
  );

const refusalAsFailure =
  (company: TaxBaselineCompany, call: TaxCall) =>
  <A extends object>(effect: Effect.Effect<A, TaxCallRefused | TaxBaselineFailure>) =>
    effect.pipe(
      Effect.catchTag('TaxCallRefused', ({ refusal }) => Effect.fail(explainRefusal(company, call, refusal))),
    );

/** Observe one company through tax's governed reads at one instant, plus the operator's rights there. */
export const observeCompany = Effect.fn('TaxBaseline.observeCompany')(function* observeCompany(
  company: TaxBaselineCompany,
  port: TaxBaselineCompanyPort,
  at: DateTime.Utc,
) {
  const rights = new Map<string, RightCheck>();
  for (const right of allRights) {
    rights.set(right, yield* port.checkRight(right));
  }
  const regime = yield* port.regimeAt(at).pipe(refusalAsFailure(company, 'readRegime'));
  const rules = new Map<string, RuleObservation>();
  for (const rule of taxBaselineRules) {
    rules.set(
      rule.classificationCode,
      yield* port.applicableRules(rule.classificationCode, at).pipe(refusalAsFailure(company, 'readRules')),
    );
  }
  return { ...company, regime, rights, rules } satisfies CompanyObservation;
});

const observeOne = (tenant: TaxBaselineTenantPort, company: TaxBaselineCompany, at: DateTime.Utc) =>
  Effect.scoped(
    tenant.company(company.legalEntityId).pipe(Effect.flatMap((port) => observeCompany(company, port, at))),
  );

const observeTenant = (tenant: TaxBaselineTenantPort) =>
  DateTime.now.pipe(
    // Never earlier than the baseline itself: a clock before 2024 would read nothing as applicable.
    Effect.map((now) => DateTime.max(now, baselineEffectiveFrom)),
    Effect.flatMap((at) =>
      Effect.forEach(tenant.companies, (company) => observeOne(tenant, company, at), { concurrency: 1 }),
    ),
  );

const createPayload = (write: typeof CreateRuleWriteSchema.Type): CreateTaxRulePayload => ({
  initialRevision: {
    compositionKind: 'EXCLUSIVE',
    effectiveFrom: write.effectiveFrom,
    jurisdiction: 'CZ_DOMESTIC',
    ratePercent: write.ratePercent,
    taxClassificationCode: write.classificationCode,
    treatmentCategory: 'TAXABLE',
  },
  meaningKind: 'VAT_RATE',
  provenanceRef: PROVENANCE,
  reason: RULE_REASON,
  stableCode: write.stableCode,
});
const declarePayload = (write: typeof DeclareRegimeWriteSchema.Type): DeclareSellerVatRegimePayload => ({
  effectiveFrom: write.effectiveFrom,
  expectedCurrentRevision: write.expectedCurrentRevision,
  // 2024 lies in the past, and tax requires a reason for a backdated effect.
  reason: REGIME_REASON,
  regime: write.regime,
});

export interface WriteOutcome {
  readonly created: boolean;
  readonly idempotencyKey: TaxBaselineIdempotencyKey;
  readonly kind: PlannedWrite['_tag'];
  readonly legalEntityId: LegalEntityId;
}

const declared = (company: TaxBaselineCompany) => (answer: DeclareRegimeAnswer) =>
  answer.declared
    ? Effect.succeed<CreateRuleAnswer>({ created: answer.created })
    : Effect.fail(fail(`${company.name}: tax rejected the regime declaration; nothing was stored`));

/** One planned write. A key that already committed is a finished write (created: false), never a retry. */
const sendWrite = (company: TaxBaselineCompany, port: TaxBaselineCompanyPort, write: PlannedWrite) => {
  const [call, sent] = Match.valueTags(write, {
    CreateRule: (rule) => ['createRule', port.createRule(createPayload(rule), rule.idempotencyKey)] as const,
    DeclareRegime: (regime) =>
      [
        'declareRegime',
        port.declareRegime(declarePayload(regime), regime.idempotencyKey).pipe(Effect.flatMap(declared(company))),
      ] as const,
  });
  return sent.pipe(
    Effect.catchTag('TaxCallRefused', ({ refusal }) =>
      Schema.is(TaxCallRefusalSchema.members[0])(refusal)
        ? Effect.succeed<CreateRuleAnswer>({ created: false })
        : Effect.fail(explainRefusal(company, call, refusal)),
    ),
    Effect.map(({ created }): WriteOutcome => ({
      created,
      idempotencyKey: write.idempotencyKey,
      kind: write._tag,
      legalEntityId: write.legalEntityId,
    })),
  );
};

const applyCompany = (tenant: TaxBaselineTenantPort, company: TaxBaselineCompany, writes: readonly PlannedWrite[]) =>
  Effect.scoped(
    tenant
      .company(company.legalEntityId)
      .pipe(
        Effect.flatMap((port) =>
          Effect.forEach(writes, (write) => sendWrite(company, port, write), { concurrency: 1 }),
        ),
      ),
  );

/** `--wait-seconds` at most: half an hour covers a deploy with room to spare, and no run waits forever. */
export const MAX_WAIT_SECONDS = 1800;
const WAIT_SPACING = Duration.seconds(10);

/** How a `--wait-seconds` value becomes re-observations: every 10 s, never below zero, never past the cap. */
export const waitForRightsOf = (waitSeconds: number): NonNullable<TaxBaselineRunOptions['waitForRights']> => ({
  attempts: Math.ceil(Math.min(Math.max(waitSeconds, 0), MAX_WAIT_SECONDS) / Duration.toSeconds(WAIT_SPACING)),
  spacing: WAIT_SPACING,
});

export const TaxBaselineModeSchema = Schema.Literals(['dry-run', 'apply', 'verify']);
export type TaxBaselineMode = typeof TaxBaselineModeSchema.Type;
export interface TaxBaselineRun extends TaxBaselinePlanning {
  readonly fingerprint: string;
  readonly mode: TaxBaselineMode;
  readonly outcomes: readonly WriteOutcome[];
}

export interface TaxBaselineRunOptions {
  /** The Tenants this run may write to; only the integration test names its private Tenant here. */
  readonly allowedTenants?: ReadonlyMap<string, string>;
  /**
   * apply and verify: how many companies the Tenant has, as the operator knows it. The session lists only the
   * companies it can select, so a run that selects a different number refuses instead of passing with a gap.
   */
  readonly companiesExpected?: number | undefined;
  /**
   * Right after a deploy the module and the operator's tax rights may not be effective yet. Re-observe until every
   * read answers and the explain check finds no missing right, at most `attempts` more times `spacing` apart; then
   * the run goes on with what it last saw, so a right that never arrives is still reported by name.
   */
  readonly waitForRights?: { readonly attempts: number; readonly spacing: Duration.Duration };
}

/** Why apply or verify cannot vouch for every company of the Tenant, or nothing when the counts agree. */
export const companyCoverageIssue = (
  mode: Exclude<TaxBaselineMode, 'dry-run'>,
  selectable: number,
  expected: number | undefined,
): string | undefined => {
  if (expected === undefined) {
    return `${mode} needs --companies-expected <n>: the operator can select ${selectable} companies, and nothing the session can read proves the Tenant has no others`;
  }
  if (expected > selectable) {
    return `The operator can act for ${selectable} of the Tenant's ${expected} companies and cannot act for ${expected - selectable}; run it from a session that can select every company`;
  }
  return expected < selectable
    ? `The operator can select ${selectable} companies, more than the ${expected} expected; check --companies-expected`
    : undefined;
};

/** Observed and planned, but not yet effective: a read refused, or a right explain still denies. */
const RightsPendingSchema = Schema.TaggedStruct('RightsPending', { reason: Schema.String });
const rightsPending = (reason: string) => RightsPendingSchema.make({ reason });

const observedPlanning = (tenant: TaxBaselineTenantPort) =>
  observeTenant(tenant).pipe(
    Effect.map((observed) => planTaxBaseline(tenant.tenantId, tenant.operatorPrincipalId, observed)),
  );

const settledPlanning = (tenant: TaxBaselineTenantPort, wait: TaxBaselineRunOptions['waitForRights']) => {
  if (wait === undefined || wait.attempts <= 0) {
    return observedPlanning(tenant);
  }
  const effective = observedPlanning(tenant).pipe(
    Effect.mapError(({ reason }) => rightsPending(reason)),
    Effect.flatMap((planning) =>
      planning.reports.every(({ missingRights }) => missingRights.length === 0)
        ? Effect.succeed(planning)
        : Effect.fail(rightsPending('a tax right is not effective yet')),
    ),
  );
  return effective.pipe(
    Effect.retry({ schedule: Schedule.spaced(wait.spacing), times: wait.attempts }),
    // Out of patience: one last plain observation reports exactly what is still missing.
    Effect.catchTag('RightsPending', () => observedPlanning(tenant)),
  );
};

/**
 * dry-run: observe and plan, write nothing. apply: re-plan, require the reviewed fingerprint of exactly that plan,
 * send the writes one at a time, then re-observe and require the baseline. verify: observe and require the baseline.
 */
export const runTaxBaseline = Effect.fn('TaxBaseline.run')(function* runTaxBaseline(
  mode: TaxBaselineMode,
  tenant: TaxBaselineTenantPort,
  reviewed: Option.Option<string>,
  options: TaxBaselineRunOptions = {},
) {
  const allowed =
    options.allowedTenants === undefined
      ? tenantServesPeople(tenant.tenantId)
      : options.allowedTenants.has(tenant.tenantId);
  if (!allowed) {
    return yield* fail('The tax baseline is seeded only in a Tenant that serves people, never the platform Tenant');
  }
  if (tenant.companies.length === 0) {
    return yield* fail('The operator can select no company in this Tenant');
  }
  const planning = yield* settledPlanning(tenant, options.waitForRights);
  const fingerprint = yield* taxBaselinePlanFingerprint(planning.plan);
  const run: TaxBaselineRun = { ...planning, fingerprint, mode, outcomes: [] };
  if (mode === 'dry-run') {
    return run;
  }
  const coverage = companyCoverageIssue(mode, tenant.companies.length, options.companiesExpected);
  if (coverage !== undefined) {
    return yield* fail(coverage);
  }
  if (planning.problems.length > 0) {
    return yield* fail(planning.problems.join('\n'));
  }
  if (mode === 'verify') {
    return planning.plan.writes.length === 0
      ? run
      : yield* fail(`${planning.plan.writes.length} baseline item(s) are missing; run dry-run and apply`);
  }
  if (Option.isNone(reviewed) || reviewed.value !== fingerprint) {
    return yield* fail(
      'apply needs --reviewed-plan-sha256 with the fingerprint of the current dry-run plan; none was given or the state changed',
    );
  }
  const outcomes: WriteOutcome[] = [];
  for (const company of tenant.companies) {
    const writes = planning.plan.writes.filter((write) => write.legalEntityId === company.legalEntityId);
    if (writes.length > 0) {
      outcomes.push(...(yield* applyCompany(tenant, company, writes)));
    }
  }
  const after = planTaxBaseline(tenant.tenantId, tenant.operatorPrincipalId, yield* observeTenant(tenant));
  if (after.problems.length > 0 || after.plan.writes.length > 0) {
    return yield* fail(['The governed writes did not leave the baseline in place:', ...after.problems].join('\n'));
  }
  return { ...run, outcomes, reports: after.reports } satisfies TaxBaselineRun;
});

// --- the HTTP port: the operator's own Shell session and tax's generated clients ---------------------------

const API = '/shell-super-app-api';
const GATEWAY_OPERATION = 'Tax gateway assertion';
const SessionSchema = Schema.Struct({
  identity: Schema.Struct({
    legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
    principalId: PrincipalIdSchema,
    tenantId: TenantIdSchema,
  }),
});
const CompositionSchema = Schema.Struct({ compositionRevision: Schema.String, state: Schema.Literal('available') });
const TenantSwitchSchema = Schema.Struct({ tenantId: TenantIdSchema });
const CompanySwitchSchema = Schema.Struct({ legalEntityId: LegalEntityIdSchema });
const GatewayRequestSchema = Schema.Struct({
  audience: Schema.Literal('tax'),
  compositionRevision: Schema.String,
  legalEntityId: LegalEntityIdSchema,
});
const GatewaySchema = Schema.Struct({
  apiBaseUrl: Schema.String,
  compositionRevision: Schema.String,
  token: Schema.Redacted(Schema.String),
});
const EmptySchema = Schema.Struct({});

/** The Problem Details fields every tax endpoint error carries. */
export const TaxProblemDetailsSchema = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  status: Schema.Number,
});
export type TaxProblemDetails = typeof TaxProblemDetailsSchema.Type;

/** A tax client failure onto the seed's refusal vocabulary; anything that is not Problem Details is transport. */
export const refusalOfProblem = (problem: Option.Option<TaxProblemDetails>): TaxCallRefusal =>
  Option.match(problem, {
    onNone: () => TaxCallRefusalSchema.members[3].make({ detail: 'transport failure' }),
    onSome: ({ code, detail, status }) => {
      const text = code ?? detail ?? `HTTP ${status}`;
      if (code === 'action_already_committed') {
        return TaxCallRefusalSchema.members[0].make({});
      }
      if (status === 403) {
        return TaxCallRefusalSchema.members[2].make({ detail: text });
      }
      return status === 409
        ? TaxCallRefusalSchema.members[1].make({ detail: text })
        : TaxCallRefusalSchema.members[3].make({ detail: text });
    },
  });
const asRefusal = <E extends object>(error: E) =>
  refused(refusalOfProblem(Schema.decodeUnknownOption(TaxProblemDetailsSchema)(error)));

export const validateSeedOrigin = (shellUrl: string, tenantId: string) =>
  Effect.gen(function* validateOrigin() {
    const url = yield* Schema.decodeUnknownEffect(Schema.URLFromString)(shellUrl).pipe(
      Effect.mapError(() => fail('ONTOS_DEMO_SEED_URL is not a URL')),
    );
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const bare =
      url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname === '/';
    if (!bare || !(url.protocol === 'https:' || loopback)) {
      return yield* fail('Use an HTTPS Shell origin, or HTTP on loopback, without credentials or a path');
    }
    const tenant = yield* Schema.decodeUnknownEffect(TenantIdSchema)(tenantId).pipe(
      Effect.mapError(() => fail('ONTOS_DEMO_SEED_TENANT_ID is not a Tenant id')),
    );
    if (!tenantServesPeople(tenant)) {
      return yield* fail('ONTOS_DEMO_SEED_TENANT_ID names the platform Tenant, which serves no people');
    }
    return { origin: url.origin, tenantId: tenant };
  });

const readAnswer =
  <S extends Schema.Top>(schema: S, operation: string) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => fail(`${operation}: unexpected answer`)),
    );

const statusOk = (operation: string) => (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300
    ? Effect.succeed(response)
    : Effect.fail(fail(`${operation}: HTTP ${response.status}`));

/** One cookie-carrying Shell session, sending the Shell's own JSON endpoints. */
const makeShellSession = (origin: string) =>
  Effect.gen(function* shellSession() {
    const http = yield* HttpClient.HttpClient;
    let cookies = Cookies.empty;
    const remember = (response: HttpClientResponse.HttpClientResponse) =>
      Effect.sync(() => {
        cookies = Cookies.merge(cookies, response.cookies);
      });
    const send = (request: HttpClientRequest.HttpClientRequest, operation: string) =>
      http
        .execute(
          HttpClientRequest.setHeaders(request, {
            cookie: Cookies.toCookieHeader(cookies),
            origin,
            'x-correlation-id': randomUUID(),
          }),
        )
        .pipe(
          Effect.timeout('30 seconds'),
          Effect.mapError(() => fail(`${operation}: no answer from the Shell`)),
          Effect.tap(remember),
        );
    const post = <S extends Schema.Top>(path: string, schema: S, body: S['Type'], operation: string) =>
      HttpClientRequest.schemaBodyJson(schema)(HttpClientRequest.post(`${origin}${API}${path}`), body).pipe(
        Effect.mapError(() => fail(`${operation}: the request could not be encoded`)),
        Effect.flatMap((request) => send(request, operation)),
      );
    const get = <S extends Schema.Top>(path: string, schema: S, operation: string) =>
      send(HttpClientRequest.get(`${origin}${API}${path}`), operation).pipe(
        Effect.flatMap(statusOk(operation)),
        Effect.flatMap(readAnswer(schema, operation)),
      );
    return { get, origin, post };
  });
type ShellSession = Effect.Success<ReturnType<typeof makeShellSession>>;

interface TaxAuthorization {
  readonly credential: Redacted.Redacted;
  readonly options: { readonly baseUrl: string; readonly compositionRevision: string };
}

/** A fresh single-use gateway assertion for tax, per call. */
const authorizeTax = (shell: ShellSession, compositionRevision: string, legalEntityId: LegalEntityId) =>
  shell
    .post(
      '/auth/gateway-context',
      GatewayRequestSchema,
      { audience: 'tax', compositionRevision, legalEntityId },
      GATEWAY_OPERATION,
    )
    .pipe(
      Effect.flatMap(statusOk(GATEWAY_OPERATION)),
      Effect.flatMap(readAnswer(GatewaySchema, GATEWAY_OPERATION)),
      Effect.flatMap((assertion) =>
        assertion.apiBaseUrl.startsWith('/') && !assertion.apiBaseUrl.startsWith('//')
          ? Effect.succeed<TaxAuthorization>({
              credential: Redacted.make(`Bearer ${Redacted.value(assertion.token)}`),
              options: {
                baseUrl: new URL(assertion.apiBaseUrl, shell.origin).toString(),
                compositionRevision: assertion.compositionRevision,
              },
            })
          : Effect.fail(fail('The gateway published no origin-relative tax API route')),
      ),
    );

export const toRuleObservation = (
  answer: Effect.Success<ReturnType<typeof executeApplicableTaxRuleSetWithAuthorization>>,
) =>
  RuleObservationSchema.make({
    applicable: answer.applicable.map(({ effectiveFrom, effectiveTo, ratePercent, revisionNumber }) => ({
      effectiveFrom,
      effectiveTo,
      ratePercent,
      revisionNumber,
    })),
    outcome: answer.outcome,
  });
export const toRegimeObservation = (
  answer: Effect.Success<ReturnType<typeof executeSellerVatRegimeAtInstantWithAuthorization>>,
): RegimeObservation => ({
  headRevision: answer.headRevision,
  selection: Match.valueTags(answer.selection, {
    DECLARED: ({ effectiveFrom, regime }) => RegimeSelectionSchema.members[0].make({ effectiveFrom, regime }),
    NOT_DECLARED: () => RegimeSelectionSchema.members[1].make({}),
  }),
});
export const toDeclareAnswer = (
  answer: Effect.Success<ReturnType<typeof executeDeclareSellerVatRegimeWithAuthorization>>,
): DeclareRegimeAnswer =>
  Match.valueTags(answer, {
    DECLARATION_REJECTED: () => ({ created: false, declared: false }),
    DECLARED: ({ created }) => ({ created, declared: true }),
  });

const explainRight = (shell: ShellSession, legalEntityId: LegalEntityId, capabilityKey: string) =>
  Schema.decodeUnknownEffect(ExplainAccessPayloadSchema)({
    capabilityKey,
    mode: 'run',
    scope: { kind: 'company', legalEntityId },
  }).pipe(
    Effect.mapError(() => fail(`${capabilityKey} is not a capability key`)),
    Effect.flatMap((payload) => shell.post('/shell/access/explain', ExplainAccessPayloadSchema, payload, 'Explain')),
    Effect.flatMap((response) =>
      response.status === 200
        ? readAnswer(
            ExplainAccessResponseSchema,
            'Explain',
          )(response).pipe(
            Effect.map(({ outcome, reasonCodes }): RightCheck =>
              outcome === 'ALLOWED'
                ? RightCheckSchema.members[0].make({})
                : RightCheckSchema.members[1].make({ reasons: [outcome, ...reasonCodes] }),
            ),
          )
        : Effect.succeed(RightCheckSchema.members[2].make({ detail: `explain answered HTTP ${response.status}` })),
    ),
  );

/** One company selected in the operator's session; every tax call goes through a fresh gateway assertion. */
const httpCompanyPort = (shell: ShellSession, compositionRevision: string, legalEntityId: LegalEntityId) =>
  Effect.gen(function* selectCompany() {
    yield* shell
      .post('/auth/legal-entity/switch', CompanySwitchSchema, { legalEntityId }, 'Company switch')
      .pipe(Effect.flatMap(statusOk('Company switch')));
    const selected = yield* shell.get('/auth/session', SessionSchema, 'Session');
    if (selected.identity.legalEntityId !== legalEntityId) {
      return yield* fail('The company-scoped session does not match the company being seeded');
    }
    const tax = <A, E extends object>(run: (authorization: TaxAuthorization) => Effect.Effect<A, E>) =>
      authorizeTax(shell, compositionRevision, legalEntityId).pipe(
        Effect.flatMap((authorization) => run(authorization).pipe(Effect.mapError(asRefusal))),
      );
    const port: TaxBaselineCompanyPort = {
      applicableRules: (taxClassificationCode, at) =>
        tax(({ credential, options }) =>
          executeApplicableTaxRuleSetWithAuthorization(
            { jurisdiction: 'CZ_DOMESTIC', taxClassificationCode, taxRelevantTime: at },
            Redacted.value(credential),
            randomUUID(),
            options,
          ),
        ).pipe(Effect.map(toRuleObservation)),
      checkRight: (capabilityKey) => explainRight(shell, legalEntityId, capabilityKey),
      createRule: (payload, idempotencyKey) =>
        tax(({ credential, options }) =>
          executeCreateTaxRuleWithAuthorization(payload, Redacted.value(credential), randomUUID(), {
            ...options,
            idempotencyKey,
          }),
        ).pipe(Effect.map(({ created }) => ({ created }))),
      declareRegime: (payload, idempotencyKey) =>
        tax(({ credential, options }) =>
          executeDeclareSellerVatRegimeWithAuthorization(payload, Redacted.value(credential), randomUUID(), {
            ...options,
            idempotencyKey,
          }),
        ).pipe(Effect.map(toDeclareAnswer)),
      regimeAt: (instant) =>
        tax(({ credential, options }) =>
          executeSellerVatRegimeAtInstantWithAuthorization(
            { instant },
            Redacted.value(credential),
            randomUUID(),
            options,
          ),
        ).pipe(Effect.map(toRegimeObservation)),
    };
    return port;
  });

/** The operator signed in through the Shell's own endpoints, in exactly the requested Tenant. */
export const connectHttpTenant = (origin: string, tenantId: TenantId, email: string, password: Redacted.Redacted) =>
  Effect.gen(function* connectTenant() {
    const shell = yield* makeShellSession(origin);
    const signIn = yield* Schema.decodeUnknownEffect(SignInPayloadSchema)({ email, password }).pipe(
      Effect.mapError(() => fail('ONTOS_DEMO_SEED_EMAIL and ONTOS_DEMO_SEED_PASSWORD must be set')),
    );
    yield* shell
      .post('/auth/sign-in', SignInPayloadSchema, signIn, 'Sign-in')
      .pipe(Effect.flatMap(statusOk('Sign-in (credentials withheld)')));
    yield* Effect.addFinalizer(() => shell.post('/auth/sign-out', EmptySchema, {}, 'Sign-out').pipe(Effect.ignore));
    yield* shell
      .post('/auth/tenant/switch', TenantSwitchSchema, { tenantId }, 'Tenant switch')
      .pipe(Effect.flatMap(statusOk('Tenant switch')));
    const choices = yield* shell.get('/auth/legal-entities', AvailableLegalEntitiesResponseSchema, 'Company list');
    const session = yield* shell.get('/auth/session', SessionSchema, 'Session');
    if (session.identity.tenantId !== tenantId) {
      return yield* fail('The signed-in session is not in the requested Tenant');
    }
    const { compositionRevision } = yield* shell.get('/shell/composition', CompositionSchema, 'Composition');
    return {
      companies: choices.legalEntities.map(({ legalEntityId, legalName }) => ({
        legalEntityId: LegalEntityIdSchema.make(legalEntityId),
        name: legalName,
      })),
      company: (legalEntityId) => httpCompanyPort(shell, compositionRevision, legalEntityId),
      operatorPrincipalId: session.identity.principalId,
      tenantId,
    } satisfies TaxBaselineTenantPort;
  });

// --- the command --------------------------------------------------------------------------------------

const declarations = (writes: readonly PlannedWrite[]) => writes.filter(Schema.is(DeclareRegimeWriteSchema)).length;
const ruleCreations = (writes: readonly PlannedWrite[]) => writes.filter(Schema.is(CreateRuleWriteSchema)).length;

const summaryLines = (run: TaxBaselineRun): readonly string[] =>
  Match.value(run.mode).pipe(
    Match.when('dry-run', () => [
      `Plánované zápisy: ${run.plan.writes.length} (režim DPH ${declarations(run.plan.writes)}, pravidla ${ruleCreations(run.plan.writes)})`,
      `Otisk plánu (--reviewed-plan-sha256): ${run.fingerprint}`,
    ]),
    Match.when('apply', () => [
      `Odesláno: ${run.outcomes.length}, nově vytvořeno ${run.outcomes.filter(({ created }) => created).length}, již existovalo ${run.outcomes.filter(({ created }) => !created).length}`,
    ]),
    Match.when('verify', () => [
      `Ověřeno: výchozí stav DPH je na místě ve všech ${run.reports.length} firmách Tenantu (tolik jich operátor vybere i očekává).`,
    ]),
    Match.exhaustive,
  );

/** `--json` keeps ids; the human table names companies only. */
export const TaxBaselineJsonSchema = Schema.Struct({
  fingerprint: Schema.String,
  mode: TaxBaselineModeSchema,
  outcomes: Schema.Array(
    Schema.Struct({
      created: Schema.Boolean,
      idempotencyKey: TaxBaselineIdempotencyKeySchema,
      kind: Schema.Literals(['CreateRule', 'DeclareRegime']),
      legalEntityId: LegalEntityIdSchema,
    }),
  ),
  plan: TaxBaselinePlanSchema,
  problems: Schema.Array(Schema.String),
  reports: Schema.Array(
    Schema.Struct({
      legalEntityId: LegalEntityIdSchema,
      missingRights: Schema.Array(Schema.Struct({ reasons: Schema.Array(Schema.String), right: Schema.String })),
      name: Schema.String,
      regime: Schema.Struct({ detail: Schema.String, state: ItemStateSchema }),
      rightsChecked: Schema.Boolean,
      rules: Schema.Array(
        Schema.Struct({ classificationCode: Schema.String, detail: Schema.String, state: ItemStateSchema }),
      ),
    }),
  ),
});

export const printTaxBaselineRun = (run: TaxBaselineRun, json: boolean) =>
  json
    ? Schema.encodeEffect(Schema.fromJsonString(TaxBaselineJsonSchema))(run).pipe(
        Effect.mapError(() => fail('The run could not be encoded as JSON')),
        Effect.flatMap((text) => Console.log(text)),
      )
    : Console.log(
        [
          renderTaxBaseline(run.plan.tenantId, run.reports),
          ...run.problems.map((problem) => `NELZE POUŽÍT: ${problem}`),
          ...summaryLines(run),
        ].join('\n'),
      );

const reportFailure = (failure: { readonly _tag: string }) =>
  Console.error(
    Schema.is(TaxBaselineFailure)(failure)
      ? `Tax baseline stopped:\n${failure.reason}`
      : `Tax baseline stopped (${failure._tag}); credentials and response bodies withheld`,
  );

const command = Command.make(
  'seed-tax-baseline',
  {
    companiesExpected: Flag.Int('companies-expected').pipe(Flag.optional),
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    mode: Flag.Literals('mode', TaxBaselineModeSchema.literals).pipe(Flag.withDefault('dry-run')),
    reviewed: Flag.String('reviewed-plan-sha256').pipe(Flag.optional),
    waitSeconds: Flag.Int('wait-seconds').pipe(Flag.withDefault(0)),
  },
  ({ companiesExpected, json, mode, reviewed, waitSeconds }) =>
    Effect.gen(function* seedTaxBaseline() {
      const target = yield* validateSeedOrigin(
        yield* Config.String('ONTOS_DEMO_SEED_URL'),
        yield* Config.String('ONTOS_DEMO_SEED_TENANT_ID'),
      );
      const tenant = yield* connectHttpTenant(
        target.origin,
        target.tenantId,
        yield* Config.String('ONTOS_DEMO_SEED_EMAIL'),
        yield* Config.Redacted('ONTOS_DEMO_SEED_PASSWORD'),
      );
      const run = yield* runTaxBaseline(mode, tenant, reviewed, {
        companiesExpected: Option.getOrUndefined(companiesExpected),
        waitForRights: waitForRightsOf(waitSeconds),
      });
      yield* printTaxBaselineRun(run, json);
      if (run.problems.length > 0) {
        yield* Console.error('apply will refuse until every problem above is resolved.');
      }
    }).pipe(Effect.scoped, Effect.tapError(reportFailure)),
);

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Command.run(command, { version: '1.0.0' }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  process.exitCode = Exit.isFailure(result) ? 1 : 0;
}
