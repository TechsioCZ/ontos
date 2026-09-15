import { describe, expect, it } from 'effect-rstest';

import {
  canUseDeliveryAccess,
  getDeliveryAccessState,
  issueDeliveryAccess,
  isSuccessfulDelivery,
} from '../../shared/domain/dsr-delivery-access.ts';
import type { DsrDeliveryAccess } from '../../shared/domain/dsr-delivery-access.ts';

const base: DsrDeliveryAccess = {
  accessId: 'access-1',
  caseRef: 'case-1',
  channel: 'SECURE_PORTAL',
  controllerRef: 'controller-1',
  deliveryOutputRef: 'output-1',
  deliveryOutputRevision: 1,
  deliveryScopeRefs: ['scope-1'],
  effectiveFrom: '2026-09-14T10:00:00Z',
  expiresAt: '2026-09-14T11:00:00Z',
  idempotencyKey: 'request-1',
  issuedAt: '2026-09-14T09:00:00Z',
  policyRef: 'policy-1',
  recipientRef: 'recipient-1',
  representationRef: 'representation-1',
  revocationReason: null,
  revokedAt: null,
  supersedesAccessRef: null,
};

describe('DSR delivery access', () => {
  it('uses a half-open effective period and fail-closed revocation', () => {
    expect(getDeliveryAccessState(base, '2026-09-14T09:59:59Z')).toBe('NOT_YET_ACTIVE');
    expect(getDeliveryAccessState(base, '2026-09-14T10:00:00Z')).toBe('CURRENT');
    expect(getDeliveryAccessState(base, '2026-09-14T11:00:00Z')).toBe('EXPIRED');
    expect(
      canUseDeliveryAccess({
        access: base,
        at: '2026-09-14T10:30:00Z',
        caseRef: 'case-1',
        channel: 'SECURE_PORTAL',
        controllerRef: 'controller-1',
        deliveryOutputRef: 'output-1',
        deliveryOutputRevision: 1,
        deliveryScopeRefs: ['scope-1'],
        policyRef: 'policy-1',
        recipientRef: 'recipient-1',
        representationRef: 'representation-1',
      }),
    ).toBe(true);
    expect(
      canUseDeliveryAccess({
        access: { ...base, revokedAt: '2026-09-14T10:15:00Z' },
        at: '2026-09-14T10:30:00Z',
        caseRef: 'case-1',
        channel: 'SECURE_PORTAL',
        controllerRef: 'controller-1',
        deliveryOutputRef: 'output-1',
        deliveryOutputRevision: 1,
        deliveryScopeRefs: ['scope-1'],
        policyRef: 'policy-1',
        recipientRef: 'recipient-1',
        representationRef: 'representation-1',
      }),
    ).toBe(false);
  });

  it('reissue revokes every other active access for the exact output', () => {
    const result = issueDeliveryAccess(
      {
        ...base,
        accessId: 'access-2',
        caseRef: base.caseRef,
        controllerRef: base.controllerRef,
        idempotencyKey: 'request-2',
        issuedAt: '2026-09-14T10:05:00Z',
        supersedesAccessRef: 'access-1',
      },
      [base, { ...base, accessId: 'other-output', deliveryOutputRef: 'output-2' }],
    );
    expect(result.revokedAccessRefs).toEqual(['access-1']);
    expect(
      canUseDeliveryAccess({
        access: { ...base, revokedAt: '2026-09-14T10:05:00Z' },
        at: '2026-09-14T10:30:00Z',
        caseRef: 'case-1',
        channel: 'SECURE_PORTAL',
        controllerRef: 'controller-1',
        deliveryOutputRef: 'output-1',
        deliveryOutputRevision: 1,
        deliveryScopeRefs: ['scope-1'],
        policyRef: 'policy-1',
        recipientRef: 'recipient-1',
        representationRef: 'representation-1',
      }),
    ).toBe(false);
  });

  it('does not treat failure or queue acceptance as successful delivery', () => {
    expect(
      isSuccessfulDelivery({
        accessId: 'access-1',
        channel: 'SECURE_PORTAL',
        deliveryOutputRef: 'output-1',
        deliveryOutputRevision: 1,
        deliveryScopeRefs: ['scope-1'],
        evidenceId: 'e1',
        occurredAt: '2026-09-14T10:30:00Z',
        outcome: 'KNOWN_FAILURE',
        policyRef: 'policy-1',
        providerReference: null,
        reason: 'provider rejected handoff',
        recipientRef: 'recipient-1',
        recordedAt: '2026-09-14T10:30:01Z',
        representationRef: 'representation-1',
      }),
    ).toBe(false);
  });

  it('rejects forged case, controller, channel, policy, time, scope, recipient, and representation', () => {
    const valid = {
      access: base,
      at: '2026-09-14T10:30:00Z',
      caseRef: 'case-1',
      channel: 'SECURE_PORTAL',
      controllerRef: 'controller-1',
      deliveryOutputRef: 'output-1',
      deliveryOutputRevision: 1,
      deliveryScopeRefs: ['scope-1'],
      policyRef: 'policy-1',
      recipientRef: 'recipient-1',
      representationRef: 'representation-1',
    } as const;
    for (const forged of [
      { caseRef: 'case-other' },
      { controllerRef: 'controller-other' },
      { channel: 'EMAIL' },
      { policyRef: 'policy-other' },
      { at: '2026-09-14T11:00:00Z' },
      { deliveryScopeRefs: ['scope-other'] },
      { recipientRef: 'recipient-other' },
      { representationRef: 'representation-other' },
    ]) {
      expect(canUseDeliveryAccess({ ...valid, ...forged })).toBe(false);
    }
  });
});
