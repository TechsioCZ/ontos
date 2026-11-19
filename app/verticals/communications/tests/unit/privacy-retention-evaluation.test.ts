import { DateTime } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { noSuppliedPrivacyReferences } from '../../shared/privacy-owner/inventory.ts';
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
    ] as const) {
      const found = finding(report.findings, category);
      expect(found?.kind).toBe('CONFIGURATION_GAP');
      expect(found).toMatchObject({ nextStep: 'SUPPLY_MISSING_PRIVACY_INPUTS', pendingReview: true });
    }
    expect(finding(report.findings, 'TEMPORARY_RENDERED_CONTENT')).toMatchObject({ kind: 'NOT_APPLICABLE' });
    expect(finding(report.findings, 'ATTACHMENT_LINK_REFERENCES')).toMatchObject({ kind: 'NOT_APPLICABLE' });
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
