import { Context, DateTime, Result, Schema } from 'effect';
import type { Effect } from 'effect';

import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { OperationalScopeRequest } from '../operations/context.ts';
import type { ReadHandlerUnavailable } from '../reads/errors.ts';
import {
  AgentProposalCommandPayloadSchema,
  AgentProposalCommandResultSchema,
} from './agent-proposal-command-contract.ts';

const Uuid = Schema.String.check(Schema.isUUID());
const PrincipalId = Uuid.pipe(Schema.brand('PrincipalId'));
const ModuleKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(Schema.brand('ModuleKey'));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const BatchId = Uuid.pipe(Schema.brand('AgentProposalBatchId'));
const BatchKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(
  Schema.brand('AgentProposalBatchKey'),
);
const RunId = Text.pipe(Schema.brand('AgentProposalRunId'));
const CommandValue: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(CommandValue),
    Schema.Record(Schema.String, CommandValue),
  ]),
);
const Command = Schema.Record(Schema.String, CommandValue);
const DiffLine = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  field: Text,
  label: Text,
});
const RevertPlan = Schema.Union([
  Schema.Struct({
    commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    createdIdPath: Schema.optionalKey(Text),
    kind: Schema.Literal('commands'),
  }),
  Schema.Struct({ kind: Schema.Literal('none'), reason: Text }),
]);
export const AGENT_PROPOSAL_QUEUE_CANDIDATE_LIMIT = 31;
export const AgentProposalQueueRiskSchema = Schema.Literals(['low', 'medium', 'high']);
export const AgentProposalQueueStatusSchema = Schema.Literals([
  'pending',
  'applied',
  'rejected',
  'failed',
  'reverted',
  'revert_failed',
]);

/** Native domain projection, not an audit envelope or a Shell wire contract. */
export const AgentProposalQueueRowSchema = Schema.Struct({
  actionSlug: Schema.String,
  agentLabel: Schema.String,
  agentPrincipalId: PrincipalId,
  appId: Schema.String.pipe(Schema.brand('DeploymentAppId')),
  appliedAt: Schema.OptionFromNullOr(Schema.Date),
  applyResult: Schema.Unknown,
  batchId: BatchId,
  batchInstruction: Schema.String,
  batchRevertedAt: Schema.OptionFromNullOr(Schema.Date),
  batchRevertedByPrincipalId: Schema.OptionFromNullOr(PrincipalId),
  batchRevertNote: Schema.OptionFromNullOr(Schema.String),
  command: Command,
  createdAt: Schema.Date,
  decidedAt: Schema.OptionFromNullOr(Schema.Date),
  decidedByPrincipalId: Schema.OptionFromNullOr(PrincipalId),
  decisionNote: Schema.OptionFromNullOr(Schema.String),
  diff: Schema.Array(DiffLine),
  failure: Schema.OptionFromNullOr(Schema.String),
  legalEntityId: Uuid.pipe(Schema.brand('LegalEntityId')),
  moduleKey: ModuleKey,
  position: Schema.Int,
  proposalId: Uuid.pipe(Schema.brand('AgentProposalId')),
  reason: Schema.String,
  referenceAudiences: Schema.Array(Schema.String),
  revert: Schema.OptionFromNullOr(RevertPlan),
  revertedAt: Schema.OptionFromNullOr(Schema.Date),
  revertedByPrincipalId: Schema.OptionFromNullOr(PrincipalId),
  risk: AgentProposalQueueRiskSchema,
  runId: Schema.OptionFromNullOr(Schema.String.pipe(Schema.brand('AgentProposalRunId'))),
  status: AgentProposalQueueStatusSchema,
  summary: Schema.String,
  targetLabel: Schema.String,
  tenantId: Uuid.pipe(Schema.brand('TenantId')),
});
export type AgentProposalQueueRow = typeof AgentProposalQueueRowSchema.Type;

export const AgentProposalQueueRequestSchema = Schema.Struct({
  batchKey: Schema.optionalKey(Schema.toEncoded(BatchKey)),
  cursor: Schema.optionalKey(
    Schema.Struct({
      at: Schema.String.check(
        Schema.makeFilter((value) =>
          Result.match(Schema.decodeResult(Schema.DateTimeUtcFromString)(value), {
            onFailure: () => 'Invalid UTC cursor',
            onSuccess: (date) =>
              DateTime.formatIso(date) === value ? undefined : 'Cursor must use canonical UTC milliseconds',
          }),
        ),
      ),
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
    }),
  ),
  moduleKey: Schema.optionalKey(Schema.toEncoded(ModuleKey)),
  pendingOnly: Schema.optionalKey(Schema.Boolean),
});

export const AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT = 31;
export const AGENT_PROPOSAL_COMMAND_RECOVERY_MODE = 'command-recovery';
const InvocationId = Uuid.pipe(Schema.brand('ActionInvocationId'), Schema.decodeTo(Schema.String));
const IdempotencyKey = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('IdempotencyKey'),
  Schema.decodeTo(Schema.String),
);
export const AgentProposalCommandRecoverySchema = Schema.Union([
  Schema.Struct({ retryCommand: Schema.Literal(true), state: Schema.Literal('NOT_STARTED') }),
  Schema.Struct({ invocationId: InvocationId, retryCommand: Schema.Literal(true), state: Schema.Literal('RETRYABLE') }),
  Schema.Struct({
    invocationId: InvocationId,
    retryCommand: Schema.Literal(false),
    state: Schema.Literals(['RUNNING', 'REJECTED']),
  }),
  Schema.Struct({
    invocationId: InvocationId,
    result: AgentProposalCommandResultSchema,
    retryCommand: Schema.Literal(false),
    state: Schema.Literal('COMMITTED'),
  }),
]);
export type AgentProposalCommandRecovery = typeof AgentProposalCommandRecoverySchema.Type;
export const AgentProposalReservationSchema = Schema.Struct({
  operation: Schema.Literals(['claim-approval', 'claim-batch-revert']),
  proposalIds: Schema.Array(Schema.toEncoded(Uuid.pipe(Schema.brand('AgentProposalId')))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  reservationId: InvocationId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});
export type AgentProposalReservation = typeof AgentProposalReservationSchema.Type;

/** No caller-selected scope, row limit, authority list or arbitrary SQL predicates. */
export const AgentProposalQueueInputSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('own-run'), runId: Schema.toEncoded(RunId) }),
  Schema.Struct({ mode: Schema.Literal('own-recent') }),
  Schema.Struct({ mode: Schema.Literal('queue'), request: AgentProposalQueueRequestSchema }),
  Schema.Struct({ batchId: Schema.toEncoded(BatchId), mode: Schema.Literal('batch') }),
  Schema.Struct({ batchId: Schema.toEncoded(BatchId), mode: Schema.Literal('batch-state') }),
  Schema.Struct({
    idempotencyKey: IdempotencyKey,
    mode: Schema.Literal('command-recovery'),
    payload: AgentProposalCommandPayloadSchema,
  }),
  // The target is data, never the deciding identity. Only a current human administrator may enumerate it.
  Schema.Struct({
    afterBatchId: Schema.optionalKey(Schema.toEncoded(BatchId)),
    agentPrincipalId: Schema.toEncoded(PrincipalId),
    mode: Schema.Literal('withdrawal-batches'),
  }),
]);
export type AgentProposalQueueInput = typeof AgentProposalQueueInputSchema.Type;

export const AgentProposalQueueResultSchema = Schema.Struct({
  approvalInProgress: Schema.Boolean,
  batchReverted: Schema.Boolean,
  /** Candidate identities survive private-record filtering, preserving the Shell's 31-candidate cursor. */
  candidates: Schema.Array(Schema.Struct({ at: Schema.String, id: Schema.String })),
  commandRecovery: Schema.optionalKey(AgentProposalCommandRecoverySchema),
  proposals: Schema.Array(AgentProposalQueueRowSchema),
  /** Only currently held reservations of the admitted caller, never another person's execution capability. */
  reservations: Schema.optionalKey(Schema.Array(AgentProposalReservationSchema).check(Schema.isMaxLength(51))),
  withdrawalBatches: Schema.optionalKey(
    Schema.Struct({
      batchIds: Schema.Array(Schema.toEncoded(BatchId)).check(
        Schema.isMaxLength(AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT),
      ),
      nextAfterBatchId: Schema.optionalKey(Schema.toEncoded(BatchId)),
    }),
  ),
});

/**
 * Owning-module visibility only. The adapter must run the declared review Read as this original principal,
 * forwarding transport and the pinned composition revision. This is never a permission-granting callback:
 * Core already checked the exact module/Action; unavailable private reviews hide their subjects.
 */
export const AgentProposalQueueVisibilitySchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ key: Schema.String, visible: Schema.Boolean })),
  state: Schema.Literals(['ok', 'unavailable']),
});
export interface AgentProposalQueueModuleReviewService {
  readonly review: (input: {
    readonly appId: string;
    readonly compositionRevision: string;
    readonly path: string;
    readonly principal: TrustedPrincipalContext;
    readonly subjects: readonly {
      readonly actionSlug: string;
      readonly command: Readonly<Record<string, Schema.Json>>;
      readonly key: string;
      readonly stage: 'proposed' | 'history';
    }[];
    readonly transport: OperationalScopeRequest;
  }) => Effect.Effect<typeof AgentProposalQueueVisibilitySchema.Type, ReadHandlerUnavailable>;
}
export class AgentProposalQueueModuleReview extends Context.Service<
  AgentProposalQueueModuleReview,
  AgentProposalQueueModuleReviewService
>()('@app/core-runtime/auth/agent-proposal-queue-contract/AgentProposalQueueModuleReview') {}
