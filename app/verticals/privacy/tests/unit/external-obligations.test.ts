import { describe, expect, it } from 'effect-rstest';
import {
  assessExternalObligations,
  createExternalObligation,
  updateExternalObligationDelivery,
} from '../../shared/domain/external-obligations.ts';

const base = {
  affectedScopeRefs: ['scope-a'],
  createdAt: '2026-09-14T10:00:00Z',
  evidenceRefs: ['evidence-a'],
  executionStatus: 'ACHIEVED',
  forwardingStatus: 'ACKNOWLEDGED',
  measureId: 'measure-1',
  notificationStatus: 'ACKNOWLEDGED',
  obligationId: 'obligation-a',
  processingRelationshipRef: 'disclosure-a',
  provenanceRefs: ['activity-a', 'transfer-a'],
  reason: null,
  requiredResult: 'downstream deletion',
  revision: 1,
  roleHolder: { holderKnown: true, holderRef: 'processor-a', role: 'PROCESSOR', unknownReason: null },
  sourceDecisionRef: 'decision-1',
  sourceDecisionRevision: 2,
  subjectRef: 'subject-1',
  tenantId: 'tenant-1',
  updatedAt: '2026-09-14T10:00:00Z',
} as const;

describe('Privacy external recipient and processor obligations', () => {
  it('keeps processor and known subprocessor obligations separate', () => {
    const a = createExternalObligation(base);
    const b = createExternalObligation({
      ...base,
      obligationId: 'obligation-b',
      processingRelationshipRef: 'disclosure-b',
      roleHolder: { holderKnown: true, holderRef: 'subprocessor-b', role: 'PROCESSOR', unknownReason: null },
    });
    expect(assessExternalObligations([a, b]).complete).toBe(true);
    expect(a.roleHolder.holderRef).not.toBe(b.roleHolder.holderRef);
  });

  it('does not treat forwarding or notification as execution', () => {
    const pending = createExternalObligation({
      ...base,
      executionStatus: 'PENDING',
      forwardingStatus: 'ACKNOWLEDGED',
      notificationStatus: 'ACKNOWLEDGED',
    });
    expect(assessExternalObligations([pending]).complete).toBe(false);
    const receipt = updateExternalObligationDelivery(pending, {
      evidenceRefs: ['receipt'],
      forwardingStatus: 'SENT',
      notificationStatus: 'SENT',
      reason: null,
      updatedAt: '2026-09-14T10:01:00Z',
    });
    expect(receipt.executionStatus).toBe('PENDING');
  });

  it('fails closed for unknown role holders', () => {
    const unknown = createExternalObligation({
      ...base,
      obligationId: 'unknown',
      roleHolder: {
        holderKnown: false,
        holderRef: null,
        role: 'RECIPIENT',
        unknownReason: 'historical transfer has no reliable holder identity',
      },
    });
    expect(assessExternalObligations([unknown]).complete).toBe(false);
    expect(assessExternalObligations([unknown]).unresolvedObligationIds).toEqual(['unknown']);
  });

  it('preserves the original relationship when delivery route changes', () => {
    const original = createExternalObligation(base);
    const updated = updateExternalObligationDelivery(original, {
      evidenceRefs: ['new-route-proof'],
      forwardingStatus: 'ACKNOWLEDGED',
      notificationStatus: 'ACKNOWLEDGED',
      reason: null,
      updatedAt: '2026-09-14T10:02:00Z',
    });
    expect(updated.processingRelationshipRef).toBe('disclosure-a');
    expect(updated.roleHolder).toEqual(original.roleHolder);
    expect(updated.revision).toBe(2);
  });
});
