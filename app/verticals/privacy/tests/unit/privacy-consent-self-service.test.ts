import { describe, expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  authorizeConsentSelfService,
  ConsentSelfServiceAuthorizationError,
  ConsentSelfServicePathSchema,
  consentDecisionFromSelfService,
  isAccountFreeConsentWithdrawal,
} from '../../shared/domain/privacy-consent-self-service.ts';
import type { ConsentDecision } from '../../shared/domain/privacy-consent-decision.ts';
import type { ConsentScope } from '../../shared/domain/privacy-consent-scope.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const consentScope: ConsentScope = {
  controllerRef: 'controller:one',
  materialDimensions: [],
  privacySubjectRef: {
    moduleId: 'privacy.core',
    resourceId: 'subject:one',
    resourceType: 'privacy.core.privacy-subject',
    tenantId,
  },
  processingPurposeRef: {
    moduleId: 'privacy.core',
    resourceId: 'purpose:one',
    resourceType: 'privacy.core.processing-purpose',
    tenantId,
  },
  purposeMeaning: 'Remember the selected privacy choice',
  purposeVersionRef: 'purpose-version:one',
  scopeRef: 'scope:one',
};
const consentDecision: ConsentDecision = {
  actorEvidence: {
    actor: { principalId: '00000000-0000-4000-8000-000000000002', tenantId },
    attributedAt: '2026-09-14T11:00:00Z',
    authMethod: 'session',
    impersonatedBy: null,
  },
  decision: 'WITHDRAWN',
  decisionId: 'decision:withdrawal',
  effectiveAt: '2026-09-14T11:00:00Z',
  flowEvidenceRefs: ['flow:self-service'],
  noticeEvidenceRefs: ['notice:one'],
  provenanceRefs: ['operation:one'],
  recordedAt: '2026-09-14T11:00:00Z',
  scope: consentScope,
};

const profilePath = {
  bindingRef: 'binding:one',
  bindingState: 'ACTIVE' as const,
  kind: 'CURRENT_PROFILE_BINDING' as const,
  permission: 'retail.consent.manage' as const,
  permissionGranted: true,
  profileRef: 'profile:one',
};

const operationPath = {
  contextRef: 'anonymous:cookie:one',
  expiresAt: '2026-09-14T12:00:00Z',
  kind: 'OPERATION_SCOPED' as const,
  operationRef: 'consent-operation:one',
  proofRef: 'proof:one',
};

describe('Consent self-service', () => {
  it('requires the current profile binding and exact retail consent Permission', () => {
    expect(authorizeConsentSelfService({ now: '2026-09-14T11:00:00Z', path: profilePath })).toEqual({
      allowed: true,
      authority: 'RETAIL_PROFILE_CONSENT',
      outcome: 'ALLOWED_PROFILE',
    });
    expect(
      authorizeConsentSelfService({
        now: '2026-09-14T11:00:00Z',
        path: { ...profilePath, permissionGranted: false },
      }).outcome,
    ).toBe('PROFILE_PERMISSION_REQUIRED');
    expect(
      authorizeConsentSelfService({
        now: '2026-09-14T11:00:00Z',
        path: { ...profilePath, bindingState: 'REVOKED' },
      }).outcome,
    ).toBe('PROFILE_BINDING_REQUIRED');
  });

  it('allows a temporary operation-scoped path without creating account authority', () => {
    const decoded = Schema.decodeUnknownSync(ConsentSelfServicePathSchema)(operationPath);
    expect(authorizeConsentSelfService({ now: '2026-09-14T11:00:00Z', path: decoded })).toEqual({
      allowed: true,
      authority: 'CONSENT_ONLY',
      outcome: 'ALLOWED_OPERATION_SCOPED',
    });
  });

  it('expires operation-scoped access and keeps withdrawal account-free', () => {
    expect(authorizeConsentSelfService({ now: '2026-09-14T12:00:00Z', path: operationPath }).outcome).toBe(
      'OPERATION_CONTEXT_EXPIRED',
    );
    expect(isAccountFreeConsentWithdrawal({ decision: 'WITHDRAWN', path: operationPath, scope: consentScope })).toBe(
      true,
    );
    expect(isAccountFreeConsentWithdrawal({ decision: 'WITHDRAWN', path: profilePath, scope: consentScope })).toBe(
      false,
    );
  });

  it('keeps profile changes and operation-scoped consent behind independent gates', () => {
    const profilePermissionRemoved = authorizeConsentSelfService({
      now: '2026-09-14T11:00:00Z',
      path: { ...profilePath, permissionGranted: false, profileRef: 'profile:changed' },
    });
    expect(profilePermissionRemoved).toMatchObject({ allowed: false, outcome: 'PROFILE_PERMISSION_REQUIRED' });
    expect(authorizeConsentSelfService({ now: '2026-09-14T11:00:00Z', path: operationPath })).toMatchObject({
      allowed: true,
      authority: 'CONSENT_ONLY',
    });
    expect(authorizeConsentSelfService({ now: '2026-09-14T11:00:00Z', path: operationPath }).authority).not.toBe(
      'RETAIL_PROFILE_CONSENT',
    );
  });

  it.effect('permits account-free withdrawal only after an authorized operation gate', () =>
    Effect.gen(function* gatesAccountFreeWithdrawal() {
      const withdrawal = { decision: 'WITHDRAWN' as const, path: operationPath, scope: consentScope };
      const authorization = authorizeConsentSelfService({ now: '2026-09-14T11:00:00Z', path: operationPath });
      expect(isAccountFreeConsentWithdrawal(withdrawal)).toBe(true);
      expect(yield* consentDecisionFromSelfService({ authorization, decision: consentDecision })).toBe(consentDecision);
      const error = yield* Effect.flip(
        consentDecisionFromSelfService({
          authorization: authorizeConsentSelfService({ now: '2026-09-14T12:00:00Z', path: operationPath }),
          decision: consentDecision,
        }),
      );
      expect(error).toBeInstanceOf(ConsentSelfServiceAuthorizationError);
    }),
  );
});
