import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { INPUT_OWNER, noSuppliedPrivacyReferences } from '../../shared/privacy-owner/inventory.ts';
import type { SuppliedCategoryPrivacyReference } from '../../shared/privacy-owner/inventory.ts';
import { evaluateCommunicationsRetention } from '../../shared/privacy-owner/retention-evaluation.ts';
import type { BusinessStartObservation, RetentionFinding } from '../../shared/privacy-owner/retention-evaluation.ts';
import { intentRef, requestRef } from './support/privacy-owner-fixtures.ts';

const at = (iso: string) => DateTime.makeUnsafe(iso);

/** Every value is FICTIONAL: a retention due instant comes from Privacy's own evaluation, never from this owner. */
const complete = (
  rules: NonNullable<SuppliedCategoryPrivacyReference['retentionRules']>,
): SuppliedCategoryPrivacyReference => ({
  businessStartConfirmationRef: 'FICTIONAL-start-confirmation',
  controllerRef: 'FICTIONAL-controller',
  controllerRole: 'CONTROLLER',
  dataCategoryRefs: ['FICTIONAL-data-category'],
  humanDispositionOwnerRef: 'FICTIONAL-human-owner',
  legalHoldApplicabilityRef: 'FICTIONAL-legal-hold-assessment',
  processingScopeRef: 'FICTIONAL-processing-scope',
  purposeRef: 'FICTIONAL-purpose',
  purposeVersion: 1,
  retentionRules: rules,
});

const rule1 = { applicabilityDecisionRef: 'FICTIONAL-app-1', ruleRef: 'FICTIONAL-rule', ruleVersion: 1 } as const;
const start = (
  category: BusinessStartObservation['category'],
  startAt: DateTime.Utc,
  contentRef: string,
): BusinessStartObservation => ({
  category,
  contentRef,
  startAt,
});
const finding = (findings: readonly RetentionFinding[], category: RetentionFinding['category']) =>
  findings.find((candidate) => candidate.category === category);

const evaluatedAt = at('2027-06-01T00:00:00.000Z');
const findingKeys = (findings: readonly RetentionFinding[]) => new Set(findings.flatMap((item) => Object.keys(item)));

/**
 * [#1410 PRIV-COM-05/06/09/15/17, AC-03/AC-05/AC-12, BDD "Retention vyzaduje exact schvalene pravidlo a nespousti destrukci"]
 * The hook identifies and hands over; it never executes and settles nothing.
 */
describe('Non-destructive Retention Evaluation hook (#588)', () => {
  it('records a CONFIGURATION GAP, pending review, for every persisted category while no Retention Rule is supplied', () => {
    const report = evaluateCommunicationsRetention({
      businessStarts: [start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1'))],
      evaluatedAt,
      supplied: noSuppliedPrivacyReferences,
    });
    expect(report.destructiveActionPerformed).toBe(false);
    for (const category of [
      'REQUEST_DECISION_INTENT',
      'ORIGINAL_RECIPIENT_ENDPOINT',
      'TYPE_LANGUAGE_TEMPLATE_REVISION',
      'ATTEMPTS_PROVIDER_OBSERVATIONS_SUPPRESSION',
      'PROVIDER_COPY_WORKING_COPY_PROTECTION',
      'ATTACHMENT_LINK_REFERENCES',
    ] as const) {
      const found = finding(report.findings, category);
      expect(found?.kind).toBe('CONFIGURATION_GAP');
      expect(found).toMatchObject({ nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS', pendingReview: true });
    }
    expect(finding(report.findings, 'TEMPORARY_RENDERED_CONTENT')).toMatchObject({ kind: 'NOT_APPLICABLE' });
  });

  it('names who has to supply the missing inputs, so the gap has a traceable owner', () => {
    const [gap] = evaluateCommunicationsRetention({
      businessStarts: [],
      evaluatedAt,
      supplied: noSuppliedPrivacyReferences,
    }).findings;
    expect(gap).toMatchObject({
      kind: 'CONFIGURATION_GAP',
      responsible: { gateOwners: ['LEGAL', 'PRIVACY_OWNER', 'PRODUCT_OWNER'] },
    });
  });

  it('hands a configured category to Privacy with its original business start and invents no due date or period', () => {
    const report = evaluateCommunicationsRetention({
      businessStarts: [
        start('REQUEST_DECISION_INTENT', at('2026-03-01T00:00:00.000Z'), requestRef('r2')),
        start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1')),
      ],
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: complete([rule1]) },
    });
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      earliestBusinessStartAt: at('2026-01-01T00:00:00.000Z'),
      kind: 'HANDED_TO_PRIVACY_EVALUATION',
      nextStep: 'PRIVACY_RETENTION_EVALUATION_DECIDES_DUE_DATE',
    });
  });

  it('keeps an elapsed retention boundary an OPEN obligation for the Privacy process: nothing is deleted, nothing is achieved', () => {
    const report = evaluateCommunicationsRetention({
      businessStarts: [start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1'))],
      evaluatedAt,
      privacyEvaluatedDue: [
        {
          dueAt: at('2027-01-01T00:00:00.000Z'),
          evaluationRef: 'FICTIONAL-evaluation-1',
          ruleRef: 'FICTIONAL-rule',
          ruleVersion: 1,
        },
      ],
      supplied: { REQUEST_DECISION_INTENT: complete([rule1]) },
    });
    expect(report.destructiveActionPerformed).toBe(false);
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      kind: 'OBLIGATION_OPEN',
      nextStep: 'PRIVACY_DISPOSITION_DECISION_AND_HUMAN_CONFIRMED_OWNER_ACTION',
      responsible: { gateOwners: ['PRIVACY_OWNER', 'PRODUCT_OWNER'] },
    });
    // the finding vocabulary has no state that means deleted, anonymized, retained forever or achieved
    const kinds: ReadonlySet<string> = new Set(report.findings.map(({ kind }) => kind));
    for (const forbidden of ['DELETED', 'ANONYMIZED', 'RETAIN_FOREVER', 'ACHIEVED', 'DONE']) {
      expect(kinds.has(forbidden)).toBe(false);
    }
  });

  it('is NOT_YET_DUE before Privacys due instant and the same obligation stays open when it is evaluated again', () => {
    const input = {
      businessStarts: [start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1'))],
      privacyEvaluatedDue: [
        {
          dueAt: at('2027-01-01T00:00:00.000Z'),
          evaluationRef: 'FICTIONAL-evaluation-1',
          ruleRef: 'FICTIONAL-rule',
          ruleVersion: 1,
        },
      ],
      supplied: { REQUEST_DECISION_INTENT: complete([rule1]) },
    } as const;
    expect(
      finding(
        evaluateCommunicationsRetention({ ...input, evaluatedAt: at('2026-06-01T00:00:00.000Z') }).findings,
        'REQUEST_DECISION_INTENT',
      )?.kind,
    ).toBe('NOT_YET_DUE');
    const first = evaluateCommunicationsRetention({ ...input, evaluatedAt });
    expect(evaluateCommunicationsRetention({ ...input, evaluatedAt })).toEqual(first);
  });

  it('does not restart the period on a technical reprocess: the start is the original business event, not the evaluation or retry date', () => {
    const original = start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1'));
    const input = { evaluatedAt, supplied: { REQUEST_DECISION_INTENT: complete([rule1]) } } as const;
    const once = evaluateCommunicationsRetention({ ...input, businessStarts: [original] });
    // the same intent processed again later still reports the same immutable start: nothing derives from "now"
    const again = evaluateCommunicationsRetention({
      ...input,
      businessStarts: [original, original],
      evaluatedAt: at('2028-01-01T00:00:00.000Z'),
    });
    expect(finding(once.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      earliestBusinessStartAt: original.startAt,
    });
    expect(finding(again.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      earliestBusinessStartAt: original.startAt,
    });
  });

  it('applies the rule version that held at the record start: a later version never rewrites an earlier record (PRIV-COM-15)', () => {
    const v2 = {
      applicabilityDecisionRef: 'FICTIONAL-app-2',
      applicableStartFrom: at('2026-06-01T00:00:00.000Z'),
      ruleRef: 'FICTIONAL-rule',
      ruleVersion: 2,
    } as const;
    const report = evaluateCommunicationsRetention({
      businessStarts: [start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1'))],
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: complete([rule1, v2]) },
    });
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      kind: 'HANDED_TO_PRIVACY_EVALUATION',
      rule: { ruleVersion: 1 },
    });
    const later = evaluateCommunicationsRetention({
      businessStarts: [start('REQUEST_DECISION_INTENT', at('2026-07-01T00:00:00.000Z'), requestRef('r9'))],
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: complete([rule1, v2]) },
    });
    expect(finding(later.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({ rule: { ruleVersion: 2 } });
  });

  it('evaluates EVERY rule version in use: a later record under a shorter-period version that is due first is not hidden', () => {
    const v2 = {
      applicabilityDecisionRef: 'FICTIONAL-app-2',
      applicableStartFrom: at('2026-06-01T00:00:00.000Z'),
      ruleRef: 'FICTIONAL-rule',
      ruleVersion: 2,
    } as const;
    const due = (ruleVersion: number, dueAt: string) => ({
      dueAt: at(dueAt),
      evaluationRef: `FICTIONAL-evaluation-${String(ruleVersion)}`,
      ruleRef: 'FICTIONAL-rule',
      ruleVersion,
    });
    const report = evaluateCommunicationsRetention({
      businessStarts: [
        // the earliest record starts under the long-period version 1 and is due far in the future
        start('REQUEST_DECISION_INTENT', at('2026-01-01T00:00:00.000Z'), requestRef('r1')),
        // two later records start under the shorter-period version 2; the earlier of them is already due
        start('REQUEST_DECISION_INTENT', at('2026-08-01T00:00:00.000Z'), requestRef('r3')),
        start('REQUEST_DECISION_INTENT', at('2026-07-01T00:00:00.000Z'), requestRef('r2')),
      ],
      evaluatedAt: at('2027-01-01T00:00:00.000Z'),
      privacyEvaluatedDue: [due(1, '2036-01-01T00:00:00.000Z'), due(2, '2026-12-01T00:00:00.000Z')],
      supplied: { REQUEST_DECISION_INTENT: complete([rule1, v2]) },
    });
    const own = report.findings.filter(({ category }) => category === 'REQUEST_DECISION_INTENT');
    expect(own.map(({ kind }) => kind)).toEqual(['NOT_YET_DUE', 'OBLIGATION_OPEN']);
    expect(own[0]).toMatchObject({ earliestBusinessStartAt: at('2026-01-01T00:00:00.000Z'), rule: { ruleVersion: 1 } });
    // version 2 reports its OWN earliest record, not the earliest record of the category
    expect(own[1]).toMatchObject({
      dueAt: at('2026-12-01T00:00:00.000Z'),
      earliestBusinessStartAt: at('2026-07-01T00:00:00.000Z'),
      kind: 'OBLIGATION_OPEN',
      rule: { ruleVersion: 2 },
    });
    expect(report.destructiveActionPerformed).toBe(false);
  });

  it('reports a conflicting rule configuration for the Privacy owner instead of choosing, deleting or retaining', () => {
    const other = {
      applicabilityDecisionRef: 'FICTIONAL-app-3',
      ruleRef: 'FICTIONAL-other-rule',
      ruleVersion: 1,
    } as const;
    const report = evaluateCommunicationsRetention({
      businessStarts: [start('ORIGINAL_RECIPIENT_ENDPOINT', at('2026-01-01T00:00:00.000Z'), intentRef('i1'))],
      evaluatedAt,
      supplied: { ORIGINAL_RECIPIENT_ENDPOINT: complete([rule1, other]) },
    });
    expect(finding(report.findings, 'ORIGINAL_RECIPIENT_ENDPOINT')).toMatchObject({
      kind: 'CONFLICTING_CONFIGURATION',
      nextStep: 'PRIVACY_OWNER_DECIDES_WHICH_RULE_APPLIES',
      pendingReview: true,
    });
  });

  it('needs the Legal Hold applicability like any other input: an unassessed hold is a gap, not a free pass', () => {
    const missingHold = { ...complete([rule1]), legalHoldApplicabilityRef: ' ' };
    const report = evaluateCommunicationsRetention({
      businessStarts: [],
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: missingHold },
    });
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toMatchObject({
      gaps: [{ input: 'LEGAL_HOLD_APPLICABILITY', owner: 'LEGAL' }],
      kind: 'CONFIGURATION_GAP',
    });
  });
});

/**
 * [#1408 S07] "The retention period has ended, keep it honest." Every instant, rule and reference below is FICTIONAL: the
 * business start is placed so far in the past that ANY plausible period would have ended, without this owner ever
 * knowing or inventing a period. The hook must neither pretend the data is gone nor dispose of it: it records the gap or
 * hands an open obligation to Privacy with a traceable owner and next step, and the observed records stay untouched.
 */
describe('[#1408 S07] Retention period ended: the evaluation stays honest and non-destructive', () => {
  /** FICTIONAL business start, far in the past on purpose; it is not a real record or a real retention boundary. */
  const FICTIONAL_ANCIENT_START = at('1970-01-01T00:00:00.000Z');
  /** FICTIONAL TEST RULE: a reference shape only; no period is known here, Privacy alone evaluates a due instant. */
  const FICTIONAL_TEST_RULE = {
    applicabilityDecisionRef: 'FICTIONAL TEST RULE applicability',
    ruleRef: 'FICTIONAL TEST RULE',
    ruleVersion: 1,
  } as const;
  /** FICTIONAL due instant as Privacy's own evaluation would report it; already passed at `evaluatedAt`. */
  const FICTIONAL_PRIVACY_DUE = {
    dueAt: at('1971-01-01T00:00:00.000Z'),
    evaluationRef: 'FICTIONAL TEST RULE evaluation',
    ruleRef: FICTIONAL_TEST_RULE.ruleRef,
    ruleVersion: FICTIONAL_TEST_RULE.ruleVersion,
  } as const;
  const persistedWithRecords = ['REQUEST_DECISION_INTENT', 'ORIGINAL_RECIPIENT_ENDPOINT'] as const;
  /** Frozen observations: any attempt by the hook to change, drop or reorder a stored record throws. */
  const ancientStarts = (): readonly BusinessStartObservation[] =>
    Object.freeze(
      persistedWithRecords.map((category, index) =>
        Object.freeze(start(category, FICTIONAL_ANCIENT_START, requestRef(`fictional-ancient-${String(index)}`))),
      ),
    );
  /** Nothing in a report may claim an executed, scheduled or achieved disposal, or that no data exists. */
  const settledVocabulary = /DELETE|ANONYMI[SZ]|PURGE|ERASE|REMOVED|NO_DATA|ACHIEVED|DONE|SCHEDULED|EXECUTED/u;

  it('[#1408 S07] with no approved Retention Rule an ended-looking period is a CONFIGURATION GAP with owners and a next step, never deleted or NO_DATA', () => {
    const businessStarts = ancientStarts();
    const before = JSON.stringify(businessStarts);
    const report = evaluateCommunicationsRetention({
      businessStarts,
      evaluatedAt,
      supplied: noSuppliedPrivacyReferences,
    });

    expect(report.destructiveActionPerformed).toBe(false);
    expect(Object.keys(report).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'destructiveActionPerformed',
      'evaluatedAt',
      'findings',
    ]);
    for (const category of persistedWithRecords) {
      const found = finding(report.findings, category);
      expect(found).toMatchObject({
        kind: 'CONFIGURATION_GAP',
        nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS',
        pendingReview: true,
        responsible: { gateOwners: ['LEGAL', 'PRIVACY_OWNER', 'PRODUCT_OWNER'] },
      });
      // the gap names the missing approved rule and who owes it, so the obligation is traceable
      expect(found).toMatchObject({
        gaps: expect.arrayContaining([
          { input: 'RETENTION_RULE_IDENTITY_VERSION', owner: INPUT_OWNER.RETENTION_RULE_IDENTITY_VERSION },
        ]),
      });
    }
    expect(JSON.stringify(report)).not.toMatch(settledVocabulary);
    expect(
      [...findingKeys(report.findings)].filter((key) => /schedul|execut|perform|measure|action/iu.test(key)),
    ).toEqual([]);
    // the observed records are exactly what they were: nothing was changed, dropped or reordered
    expect(JSON.stringify(businessStarts)).toBe(before);
  });

  it('[#1408 S07] every other input supplied but the Retention Rule: the only gap is the rule, owned by its approver', () => {
    const everythingButTheRule = { ...complete([FICTIONAL_TEST_RULE]), retentionRules: [] };
    const report = evaluateCommunicationsRetention({
      businessStarts: ancientStarts(),
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: everythingButTheRule },
    });
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toEqual({
      category: 'REQUEST_DECISION_INTENT',
      gaps: [{ input: 'RETENTION_RULE_IDENTITY_VERSION', owner: INPUT_OWNER.RETENTION_RULE_IDENTITY_VERSION }],
      kind: 'CONFIGURATION_GAP',
      nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS',
      pendingReview: true,
      responsible: { gateOwners: [INPUT_OWNER.RETENTION_RULE_IDENTITY_VERSION] },
    });
    expect(report.destructiveActionPerformed).toBe(false);
  });

  it('[#1408 S07] with a FICTIONAL TEST RULE but no Privacy due instant, Communications concludes nothing ended: it hands the ancient start to Privacy', () => {
    const report = evaluateCommunicationsRetention({
      businessStarts: ancientStarts(),
      evaluatedAt,
      supplied: { REQUEST_DECISION_INTENT: complete([FICTIONAL_TEST_RULE]) },
    });
    const found = finding(report.findings, 'REQUEST_DECISION_INTENT');
    expect(found).toEqual({
      category: 'REQUEST_DECISION_INTENT',
      earliestBusinessStartAt: FICTIONAL_ANCIENT_START,
      kind: 'HANDED_TO_PRIVACY_EVALUATION',
      nextStep: 'PRIVACY_RETENTION_EVALUATION_DECIDES_DUE_DATE',
      responsible: { gateOwners: ['PRIVACY_OWNER'] },
      rule: FICTIONAL_TEST_RULE,
    });
    // no period and no due instant is computed or defaulted here, however old the start is
    expect(Object.keys(found ?? {})).not.toContain('dueAt');
    expect(JSON.stringify(report)).not.toMatch(settledVocabulary);
  });

  it('[#1408 S07] a FICTIONAL TEST RULE whose Privacy due instant has passed is an OPEN obligation awaiting human disposition, never an executed measure', () => {
    const businessStarts = ancientStarts();
    const before = JSON.stringify(businessStarts);
    const input = {
      businessStarts,
      privacyEvaluatedDue: [FICTIONAL_PRIVACY_DUE],
      supplied: { REQUEST_DECISION_INTENT: complete([FICTIONAL_TEST_RULE]) },
    } as const;
    const report = evaluateCommunicationsRetention({ ...input, evaluatedAt });
    const open = {
      category: 'REQUEST_DECISION_INTENT',
      dueAt: FICTIONAL_PRIVACY_DUE.dueAt,
      earliestBusinessStartAt: FICTIONAL_ANCIENT_START,
      kind: 'OBLIGATION_OPEN',
      nextStep: 'PRIVACY_DISPOSITION_DECISION_AND_HUMAN_CONFIRMED_OWNER_ACTION',
      responsible: { gateOwners: ['PRIVACY_OWNER', 'PRODUCT_OWNER'] },
      rule: FICTIONAL_TEST_RULE,
    } as const;
    expect(finding(report.findings, 'REQUEST_DECISION_INTENT')).toEqual(open);
    expect(report.destructiveActionPerformed).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(settledVocabulary);
    // decades later the same obligation is still open: an elapsed boundary never settles itself
    const muchLater = evaluateCommunicationsRetention({ ...input, evaluatedAt: at('2099-01-01T00:00:00.000Z') });
    expect(finding(muchLater.findings, 'REQUEST_DECISION_INTENT')).toEqual(open);
    expect(muchLater.destructiveActionPerformed).toBe(false);
    // the category without a supplied rule stays a gap beside it; one category's obligation settles no other
    expect(finding(report.findings, 'ORIGINAL_RECIPIENT_ENDPOINT')?.kind).toBe('CONFIGURATION_GAP');
    expect(JSON.stringify(businessStarts)).toBe(before);
  });
});
