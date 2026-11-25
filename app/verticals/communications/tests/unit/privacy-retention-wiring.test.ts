import { readFileSync } from 'node:fs';
import { DateTime, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  PrivacyOwnerCoverageRequestSchema,
  PrivacyOwnerCoverageResponseSchema,
} from '../../shared/apis/privacy-owner-coverage.ts';
import { evaluateCommunicationsRetention } from '../../shared/privacy-owner/retention-evaluation.ts';
import { scopePartRefs } from '../../shared/privacy-owner/inventory.ts';
import { ownerScope, requestRef, tenantId } from './support/privacy-owner-fixtures.ts';

/**
 * [#1410 D.6, AC-03, AC-05, PRIV-COM-17; #1408 BDD "Retencni lhuta skoncila"; audit T2-12] The retention hook is reachable: Privacy
 * asks for it on the owner coverage Read, supplies the due instant ITS evaluation decided, and receives the owner's report. A
 * retention period ending yields an OPEN obligation for Privacy's decision and a human; nothing is deleted.
 */
const at = (iso: string) => DateTime.makeUnsafe(iso);
const encodeResponseRetention = Schema.encodeSync(PrivacyOwnerCoverageResponseSchema.fields.retention.schema);
const decodeRequest = Schema.decodeUnknownSync(PrivacyOwnerCoverageRequestSchema);
const decodeManifest = Schema.decodeUnknownSync(
  Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
);

const retentionRequest = {
  retentionEvaluation: {
    privacyEvaluatedDue: [
      {
        dueAt: '2027-01-01T00:00:00.000Z',
        evaluationRef: 'FICTIONAL-evaluation-1',
        ruleRef: 'FICTIONAL-rule',
        ruleVersion: 1,
      },
    ],
  },
  scope: { ...ownerScope(), requestedScopePartRefs: [...scopePartRefs], tenantId },
  trustedLookups: [
    {
      _tag: 'SUBJECT_REFERENCE',
      lookupRef: 'FICTIONAL-lookup-1',
      moduleId: 'FICTIONAL-module',
      resourceId: 'FICTIONAL-resource',
      resourceType: 'FICTIONAL-type',
    },
  ],
};

describe('The Retention Evaluation hook is reachable through the owner coverage Read', () => {
  it('lets Privacy supply its evaluated due instants on the request, decoded as exact instants', () => {
    const request = decodeRequest(retentionRequest);
    expect(request.retentionEvaluation?.privacyEvaluatedDue[0]).toMatchObject({
      dueAt: at('2027-01-01T00:00:00.000Z'),
      ruleRef: 'FICTIONAL-rule',
      ruleVersion: 1,
    });
  });

  it('refuses a due instant without the rule identity and version Privacy decided it for', () => {
    const [due] = retentionRequest.retentionEvaluation.privacyEvaluatedDue;
    expect(() =>
      decodeRequest({
        ...retentionRequest,
        retentionEvaluation: { privacyEvaluatedDue: [{ dueAt: due?.dueAt, evaluationRef: 'FICTIONAL-evaluation-1' }] },
      }),
    ).toThrow();
  });

  it('reports an ended retention period as an open obligation that performed nothing, in the published response shape', () => {
    const request = decodeRequest(retentionRequest);
    const report = evaluateCommunicationsRetention({
      businessStarts: [
        { category: 'REQUEST_DECISION_INTENT', contentRef: requestRef('r1'), startAt: at('2026-01-01T00:00:00.000Z') },
      ],
      evaluatedAt: at('2027-06-01T00:00:00.000Z'),
      privacyEvaluatedDue: request.retentionEvaluation?.privacyEvaluatedDue ?? [],
      supplied: {
        REQUEST_DECISION_INTENT: {
          businessStartConfirmationRef: 'FICTIONAL-start-confirmation',
          controllerRef: 'FICTIONAL-controller',
          controllerRole: 'CONTROLLER',
          dataCategoryRefs: ['FICTIONAL-data-category'],
          humanDispositionOwnerRef: 'FICTIONAL-human-owner',
          legalHoldApplicabilityRef: 'FICTIONAL-legal-hold-assessment',
          processingScopeRef: 'FICTIONAL-processing-scope',
          purposeRef: 'FICTIONAL-purpose',
          purposeVersion: 1,
          retentionRules: [{ applicabilityDecisionRef: 'FICTIONAL-app-1', ruleRef: 'FICTIONAL-rule', ruleVersion: 1 }],
        },
      },
    });
    const encoded = encodeResponseRetention(report);
    expect(encoded.destructiveActionPerformed).toBe(false);
    expect(encoded.findings.find(({ category }) => category === 'REQUEST_DECISION_INTENT')).toMatchObject({
      dueAt: '2027-01-01T00:00:00.000Z',
      kind: 'OBLIGATION_OPEN',
      nextStep: 'PRIVACY_DISPOSITION_DECISION_AND_HUMAN_CONFIRMED_OWNER_ACTION',
    });
    // the report can only identify and hand over: no finding or field of it names a performed action
    expect(JSON.stringify(encoded)).not.toMatch(/deleted|removed|anonymi[sz]ed|disposed/iu);
  });

  it('reports the missing Privacy inputs as a gap, pending review, when nothing is supplied (production default)', () => {
    const encoded = encodeResponseRetention(
      evaluateCommunicationsRetention({
        businessStarts: [],
        evaluatedAt: at('2027-06-01T00:00:00.000Z'),
        supplied: {},
      }),
    );
    expect(encoded.findings.some(({ kind }) => kind === 'CONFIGURATION_GAP')).toBe(true);
    expect(encoded.findings.every(({ kind }) => kind !== 'OBLIGATION_OPEN')).toBe(true);
  });

  it('exports the retention evaluation from the package', () => {
    const manifest = decodeManifest(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')));
    expect(manifest.exports['./privacy-owner/retention-evaluation']).toBe(
      './shared/privacy-owner/retention-evaluation.ts',
    );
  });
});
