import { describe, expect, it } from 'effect-rstest';
import { DateTime, Option } from 'effect';
import {
  applyingRevisions,
  classificationView,
  parseRatePercent,
  planRateChange,
  planWithdraw,
  regimeTimeline,
} from '../../src/routes/[lang]/finance/dph/vat-settings-model.ts';
import type { RuleHistory, RuleHistoryRevision } from '../../src/routes/[lang]/finance/dph/vat-settings-model.ts';
import { pragueDayStart } from '../../shared/domain/line-vat.ts';

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const at = (isoDate: string) => Option.getOrThrow(Option.fromUndefinedOr(pragueDayStart(isoDate)));
const ref = (id: string) => ({
  moduleId: 'commerce.tax' as const,
  resourceId: id,
  resourceType: 'commerce.tax.tax-rule-revision' as const,
  tenantId: TENANT,
});
const revision = (id: string, from: string, ratePercent: string, end?: string): RuleHistoryRevision => ({
  effectiveFrom: at(from),
  effectiveTo: Option.none(),
  endFact: end === undefined ? Option.none() : Option.some({ endedEffectiveTo: at(end) }),
  ratePercent,
  taxRuleRevisionRef: ref(id),
});
const history = (revisions: readonly RuleHistoryRevision[], wrong: readonly string[] = []): RuleHistory => ({
  basisFingerprint: 'a'.repeat(64),
  corrections: wrong.map((id) => ({ wrongRevisionRef: ref(id) })),
  revisions,
  taxRuleRef: {
    moduleId: 'commerce.tax',
    resourceId: 'rule-standard',
    resourceType: 'commerce.tax.tax-rule',
    tenantId: TENANT,
  },
});

const now = at('2026-11-12');
// 15 % until the end of 2023, 21 % since 2024 until 2027, then a planned 23 %.
const standard = history([
  revision('r1', '2020-01-01', '15', '2024-01-01'),
  revision('r2', '2024-01-01', '21', '2027-01-01'),
  revision('r3', '2027-01-01', '23'),
]);

describe('VAT settings model', () => {
  it('splits a classification into the rate in effect, planned rates and earlier rates', () => {
    const view = classificationView('cz.vat.standard', standard, now, false);
    expect(view.state).toBe('ready');
    if (view.state !== 'ready') {
      return;
    }
    expect(view.current?.ratePercent).toBe('21');
    expect(view.scheduled.map((entry) => entry.ratePercent)).toEqual(['23']);
    expect(view.past.map((entry) => entry.ratePercent)).toEqual(['15']);
  });

  it('never shows a withdrawn plan or a corrected revision as a rate', () => {
    const withdrawn = history([revision('r2', '2024-01-01', '21'), revision('r3', '2027-01-01', '23', '2027-01-01')]);
    expect(applyingRevisions(withdrawn).map((entry) => entry.ratePercent)).toEqual(['21']);
    const corrected = history([revision('r2', '2024-01-01', '20'), revision('r4', '2024-01-01', '21')], ['r2']);
    expect(applyingRevisions(corrected).map((entry) => entry.ratePercent)).toEqual(['21']);
  });

  it('plans a new rate by ending the rate that covers its first day, up to the next planned rate', () => {
    const view = classificationView('cz.vat.standard', standard, now, false);
    if (view.state !== 'ready') {
      return;
    }
    const plan = planRateChange(view, at('2026-07-01'), at('2026-01-15'));
    expect(plan).toMatchObject({ end: { revisionRef: ref('r2') } });
    if (plan === 'alreadyPlanned' || plan === 'notInFuture') {
      return;
    }
    expect(DateTime.formatIso(plan.create.effectiveFrom)).toBe(DateTime.formatIso(at('2026-07-01')));
    expect(plan.create.effectiveTo === undefined ? undefined : DateTime.formatIso(plan.create.effectiveTo)).toBe(
      DateTime.formatIso(at('2027-01-01')),
    );
    // After the last plan the new rate is open-ended and ends the plan it follows.
    const later = planRateChange(view, at('2028-01-01'), now);
    expect(later).toMatchObject({ end: { revisionRef: ref('r3') } });
    expect(later === 'alreadyPlanned' || later === 'notInFuture' ? later : later.create.effectiveTo).toBeUndefined();
  });

  it('refuses a change from today or the past, and a day that already starts a plan', () => {
    const view = classificationView('cz.vat.standard', standard, now, false);
    if (view.state !== 'ready') {
      return;
    }
    expect(planRateChange(view, now, now)).toBe('notInFuture');
    expect(planRateChange(view, at('2025-01-01'), now)).toBe('notInFuture');
    expect(planRateChange(view, at('2027-01-01'), now)).toBe('alreadyPlanned');
  });

  it('carries the earlier rate on over a withdrawn plan', () => {
    const view = classificationView('cz.vat.standard', standard, now, false);
    if (view.state !== 'ready') {
      return;
    }
    const [planned] = view.scheduled;
    if (planned === undefined) {
      return;
    }
    const plan = planWithdraw(view, planned);
    expect(plan).toMatchObject({ continueWith: { ratePercent: '21' }, withdraw: { revisionRef: ref('r3') } });
    // The withdrawn plan was open-ended, so the earlier rate carries on open-ended too.
    expect(plan.continueWith?.effectiveTo).toBeUndefined();
  });

  it('applies the highest-numbered regime revision in effect, so a replaced plan never applies', () => {
    const periods = regimeTimeline(
      [
        { effectiveFrom: at('2024-01-01'), regime: 'VAT_PAYER', revision: 1 },
        { effectiveFrom: at('2027-07-01'), regime: 'NON_PAYER', revision: 2 },
        { effectiveFrom: at('2027-03-01'), regime: 'VAT_PAYER', revision: 3 },
        { effectiveFrom: at('2028-01-01'), regime: 'NON_PAYER', revision: 4 },
      ],
      now,
    );
    expect(periods.map((period) => [period.regime, period.state])).toEqual([
      ['VAT_PAYER', 'current'],
      ['VAT_PAYER', 'scheduled'],
      ['NON_PAYER', 'scheduled'],
    ]);
  });

  it('accepts a whole percent from 1 to 100 only', () => {
    expect(parseRatePercent(' 23 ')).toBe(23);
    expect(parseRatePercent('12,0')).toBe(12);
    expect(parseRatePercent('0')).toBeUndefined();
    expect(parseRatePercent('12,5')).toBeUndefined();
    expect(parseRatePercent('sto')).toBeUndefined();
  });
});
