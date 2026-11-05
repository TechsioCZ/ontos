import { Context } from 'effect';
import type { Effect, Option } from 'effect';

import type { OperationalScope } from '@app/core-runtime';
import type { AccessAmount } from '@app/core-runtime/access/enforcement';

import type {
  ApprovalCommandFailure,
  ApprovalCommandPreview,
  ApprovalPortUnavailable,
  ApprovalRecord,
  ApprovalStatus,
  ApprovalWitness,
} from './approvals-contract.ts';

/**
 * The Core commands this surface drives. Every authority input is a live witness the gate just
 * resolved for this person, so Core re-checks exactly the authority the BFF observed, and a command
 * the caller cannot justify is refused by Core rather than by a flag here.
 */
export interface AccessApprovalsCommandsService {
  readonly approve: (
    scope: OperationalScope,
    input: {
      readonly approval: ApprovalWitness;
      readonly execution: ApprovalWitness;
      readonly parentRecordRead: readonly ApprovalWitness[];
      readonly proposalId: string;
      readonly revision: string;
    },
  ) => Effect.Effect<ApprovalRecord, ApprovalCommandFailure>;
  /**
   * The governed money value of the proposal's frozen command (O18), resolved server-side by Core with
   * the owner Action's own amount rule over the stored payload (`frozenCommandAmount`), so an approver
   * is asked about the amount the mandate will run with. `None` is a command that governs no amount;
   * the formatted preview fields are never a substitute for it.
   */
  readonly governedAmount: (
    scope: OperationalScope,
    input: { readonly proposalId: string; readonly scopeId: string },
  ) => Effect.Effect<Option.Option<AccessAmount>, ApprovalPortUnavailable>;
  readonly load: (
    scope: OperationalScope,
    proposalId: string,
  ) => Effect.Effect<Option.Option<ApprovalRecord>, ApprovalPortUnavailable>;
  readonly open: (
    scope: OperationalScope,
    input: { readonly status?: ApprovalStatus },
  ) => Effect.Effect<readonly ApprovalRecord[], ApprovalPortUnavailable>;
  readonly preview: (
    scope: OperationalScope,
    input: { readonly proposalId: string; readonly scopeId: string },
  ) => Effect.Effect<Option.Option<ApprovalCommandPreview>, ApprovalPortUnavailable>;
  readonly reject: (
    scope: OperationalScope,
    input: {
      readonly approveAuthority: readonly ApprovalWitness[];
      readonly proposalId: string;
      readonly reason?: string;
    },
  ) => Effect.Effect<ApprovalRecord, ApprovalCommandFailure>;
  readonly withdraw: (
    scope: OperationalScope,
    input: { readonly approveAuthority: readonly ApprovalWitness[]; readonly proposalId: string },
  ) => Effect.Effect<ApprovalRecord, ApprovalCommandFailure>;
}

export class AccessApprovalsCommands extends Context.Service<AccessApprovalsCommands, AccessApprovalsCommandsService>()(
  '@app/shell-super-app/api/access-admin/approvals-commands/AccessApprovalsCommands',
) {}
