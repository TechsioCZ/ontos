import { describe, expect, it } from 'effect-rstest';
import { Effect } from 'effect';

import {
  isProofOfProvision,
  materializePrivacyNoticeProvision,
  PrivacyNoticeProvisionInvariantError,
  validatePrivacyNoticeProvision,
} from '../../shared/domain/privacy-notice-provision.ts';
import type {
  PrivacyNoticeChannelProof,
  PrivacyNoticeProvisionDraft,
  RecordPrivacyNoticeProvisionInput,
  TrustedPrivacyNoticeProvisionContext,
} from '../../shared/domain/privacy-notice-provision.ts';

const proof: PrivacyNoticeChannelProof = {
  anonymousContextRef: null,
  authorityRef: 'channel-owner:web',
  businessInteractionRef: 'checkout:1',
  channel: 'web',
  controllerRef: 'controller:1',
  evidenceRef: 'evidence:provision:1',
  noticeVersionRef: 'privacy-notice-version:1',
  observedAt: '2026-01-01T10:00:00Z',
  privacySubjectRef: 'subject:1',
  processingPurposeRef: 'purpose:account',
  processingScopeRef: 'scope:account',
  proofKind: 'INTERACTIVE_ACKNOWLEDGEMENT',
  providedLanguage: 'en-US',
};

const draft: PrivacyNoticeProvisionDraft = {
  actionRef: 'action:notice-provision:1',
  anonymousContextRef: null,
  businessInteractionRef: 'checkout:1',
  channel: 'web',
  controllerRef: 'controller:1',
  evidenceRef: 'evidence:provision:1',
  failureReason: null,
  noticeVersionRef: 'privacy-notice-version:1',
  outcome: 'PROVEN_PROVISION',
  privacySubjectRef: 'subject:1',
  processingPurposeRef: 'purpose:account',
  processingScopeRef: 'scope:account',
  providedLanguage: 'en-US',
  provisionedAt: '2026-01-01T10:00:00Z',
  provisionId: 'provision:1',
  supersedesProvisionRef: null,
};

const trusted: TrustedPrivacyNoticeProvisionContext = {
  authoritativeProof: proof,
  recordedAt: '2026-01-01T10:00:01Z',
};

const base: RecordPrivacyNoticeProvisionInput = {
  ...draft,
  channelProof: proof,
  recordedAt: trusted.recordedAt,
};

describe('Privacy Notice Provision', () => {
  it('accepts only channel-specific proof from a trusted recording context', () => {
    expect(validatePrivacyNoticeProvision(base, trusted)).toBeUndefined();
    expect(validatePrivacyNoticeProvision(base)).toContain('trusted recording context');
    expect(isProofOfProvision('REPEATED_PROVISION')).toBe(true);
  });

  it('requires exactly one subject context and matching authoritative channel evidence', () => {
    expect(validatePrivacyNoticeProvision({ ...base, anonymousContextRef: 'anonymous:1' }, trusted)).toContain(
      'Exactly one',
    );
    expect(validatePrivacyNoticeProvision({ ...base, channelProof: null, evidenceRef: null }, trusted)).toContain(
      'channel-specific authoritative proof',
    );
    expect(
      validatePrivacyNoticeProvision(
        { ...base, channelProof: { ...proof, channel: 'email' } },
        { ...trusted, authoritativeProof: { ...proof, channel: 'email' } },
      ),
    ).toContain('match the provision channel');
  });

  it.effect('materializes proof evidence and recorded time only from trusted inputs', () =>
    Effect.gen(function* materializesTrustedNoticeProof() {
      const materialized = yield* materializePrivacyNoticeProvision(
        { ...draft, evidenceRef: 'client-claimed:evidence', provisionedAt: '2025-01-01T00:00:00Z' },
        trusted,
      );
      expect(materialized).toMatchObject({
        channelProof: proof,
        evidenceRef: proof.evidenceRef,
        provisionedAt: proof.observedAt,
        recordedAt: trusted.recordedAt,
      });
      const error = yield* Effect.flip(
        materializePrivacyNoticeProvision(draft, {
          authoritativeProof: null,
          recordedAt: trusted.recordedAt,
        }),
      );
      expect(error).toBeInstanceOf(PrivacyNoticeProvisionInvariantError);
    }),
  );

  it('does not promote publication, rendering, or attempts to provision proof', () => {
    expect(isProofOfProvision('DISPLAYED_WITHOUT_ACKNOWLEDGEMENT')).toBe(false);
    expect(isProofOfProvision('PROVISION_FAILED')).toBe(false);
    expect(isProofOfProvision('PROVISION_INDETERMINATE')).toBe(false);
    expect(
      validatePrivacyNoticeProvision({
        ...base,
        channelProof: null,
        evidenceRef: null,
        outcome: 'DISPLAYED_WITHOUT_ACKNOWLEDGEMENT',
      }),
    ).toBeUndefined();
    expect(
      validatePrivacyNoticeProvision({
        ...base,
        channelProof: null,
        evidenceRef: null,
        failureReason: 'transport-failed',
        outcome: 'PROVISION_FAILED',
      }),
    ).toBeUndefined();
    expect(
      validatePrivacyNoticeProvision({
        ...base,
        channelProof: null,
        evidenceRef: null,
        failureReason: 'provider-timeout',
        outcome: 'PROVISION_INDETERMINATE',
      }),
    ).toBeUndefined();
  });

  it('rejects impossible timestamps and incomplete authoritative non-proof facts', () => {
    expect(validatePrivacyNoticeProvision({ ...base, recordedAt: '2026-01-01T09:59:59Z' }, trusted)).toContain(
      'precede',
    );
    expect(
      validatePrivacyNoticeProvision({
        ...base,
        channelProof: null,
        failureReason: 'unexpected',
        outcome: 'DISPLAYED_WITHOUT_ACKNOWLEDGEMENT',
      }),
    ).toContain('cannot carry a failure reason');
    expect(
      validatePrivacyNoticeProvision({
        ...base,
        channelProof: null,
        failureReason: null,
        outcome: 'PROVISION_FAILED',
      }),
    ).toContain('requires an authoritative reason');
    expect(validatePrivacyNoticeProvision(base, { ...trusted, recordedAt: '2026-01-01T10:00:02Z' })).toContain(
      'trusted recording context',
    );
  });
});
