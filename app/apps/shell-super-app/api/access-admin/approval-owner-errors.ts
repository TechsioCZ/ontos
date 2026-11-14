import type { ApprovalCommandFailure, ApprovalPortUnavailable } from './approvals-contract.ts';

export const approvalOwnerUnavailable = (cause?: unknown): ApprovalPortUnavailable =>
  Object.defineProperty(
    {
      _tag: 'ApprovalPortUnavailable',
      reason: 'The original owner approval service is temporarily unavailable',
    },
    'cause',
    { value: cause },
  );

export const approvalOwnerRefused = (cause?: unknown): ApprovalCommandFailure =>
  Object.defineProperty(
    {
      _tag: 'ApprovalCommandRefused',
      code: 'approval_authority_missing',
      reason: 'The original owner refused this approval',
      retryable: false,
    },
    'cause',
    { value: cause },
  );

export const approvalOwnerConflict = (): ApprovalCommandFailure => ({
  _tag: 'ApprovalCommandRefused',
  code: 'revision_stale',
  reason: 'The proposal changed before owner approval',
  retryable: false,
});
