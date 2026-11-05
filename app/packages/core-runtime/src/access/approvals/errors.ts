import type { ApprovalAuthorityUnavailableError } from './errors/approval-authority-unavailable-error.ts';
import type { ApprovalRefusedError } from './errors/approval-refused-error.ts';
import type { ApprovalStorageConflictError } from './errors/approval-storage-conflict-error.ts';
import type { ApprovalStorageUnavailableError } from './errors/approval-storage-unavailable-error.ts';
import type { CommandNotCanonicalError } from './errors/command-not-canonical-error.ts';
import type { MandateRefusedError } from './errors/mandate-refused-error.ts';
import type { ProposalIntegrityError } from './errors/proposal-integrity-error.ts';
import type { ProposalRefusedError } from './errors/proposal-refused-error.ts';

export { ApprovalAuthorityUnavailableError } from './errors/approval-authority-unavailable-error.ts';
export { ApprovalRefusedError } from './errors/approval-refused-error.ts';
export type { ApprovalRefusalCode } from './errors/approval-refused-error.ts';
export { ApprovalStorageConflictError } from './errors/approval-storage-conflict-error.ts';
export { ApprovalStorageUnavailableError } from './errors/approval-storage-unavailable-error.ts';
export { CommandNotCanonicalError } from './errors/command-not-canonical-error.ts';
export { MandateRefusedError } from './errors/mandate-refused-error.ts';
export type { MandateRefusalCode } from './errors/mandate-refused-error.ts';
export { ProposalIntegrityError } from './errors/proposal-integrity-error.ts';
export { ProposalRefusedError } from './errors/proposal-refused-error.ts';
export type { ProposalRefusalCode } from './errors/proposal-refused-error.ts';

/*
 * Expected failures of the proposal and mandate lifecycle. Every refusal keeps one stable code so a
 * BFF endpoint maps it exhaustively, and an unavailable authority check stays a retryable failure
 * that is never collapsed into a denial.
 */
export type ApprovalsError =
  | ApprovalAuthorityUnavailableError
  | ApprovalRefusedError
  | ApprovalStorageConflictError
  | ApprovalStorageUnavailableError
  | CommandNotCanonicalError
  | MandateRefusedError
  | ProposalIntegrityError
  | ProposalRefusedError;
