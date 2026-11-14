import { Option, Schema } from 'effect';

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
const AgentCommandSchema = Schema.Record(Schema.String, CommandValue);
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const AgentDiffLineSchema = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  field: ShortText,
  label: ShortText,
});
const AgentRevertPlanSchema = Schema.Union([
  Schema.Struct({
    commands: Schema.Array(AgentCommandSchema).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    createdIdPath: Schema.optionalKey(ShortText),
    kind: Schema.Literal('commands'),
  }),
  Schema.Struct({ kind: Schema.Literal('none'), reason: ShortText }),
]);

export const agentProposalCommandActionKey = 'core.identity.mutate-agent-proposals';
const Id = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AgentProposalCommandId'),
  Schema.decodeTo(Schema.String),
);
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const Note = Schema.String.check(Schema.isMaxLength(1000));
const Slug = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/u));
const AppId = ShortText.pipe(Schema.brand('AgentProposalAppId'), Schema.decodeTo(Schema.String));
const ModuleKey = ShortText.pipe(Schema.brand('AgentProposalModuleKey'), Schema.decodeTo(Schema.String));
const RunId = ShortText.pipe(Schema.brand('AgentProposalRunId'), Schema.decodeTo(Schema.String));
const Target = { batchId: Id, proposalId: Id };
const Reservation = { ...Target, reservationId: Id };
const Proposal = Schema.Struct({
  actionSlug: Slug,
  appId: AppId,
  command: AgentCommandSchema,
  diff: Schema.Array(AgentDiffLineSchema).check(Schema.isMaxLength(60)),
  moduleKey: ModuleKey,
  proposalId: Id,
  reason: Text,
  referenceAudiences: Schema.optionalKey(Schema.Array(ShortText).check(Schema.isMaxLength(5))),
  risk: Schema.Literals(['low', 'medium', 'high']),
  summary: ShortText,
  targetLabel: ShortText,
  // Undo is rebuilt by the governed dispatcher at approval, never supplied by the proposing agent.
  revert: Schema.optionalKey(Schema.Never),
});

/** Finite owner commands. Scope and deciding identity are exclusively native ingress facts. */
export const AgentProposalCommandPayloadSchema = Schema.Union([
  Schema.Struct({
    agentLabel: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
    batchId: Id,
    instruction: Text,
    operation: Schema.Literal('insert'),
    proposals: Schema.Array(Proposal).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
    runId: Schema.optionalKey(RunId),
  }),
  Schema.Struct({ ...Target, operation: Schema.Literal('claim-approval') }),
  Schema.Struct({ ...Reservation, operation: Schema.Literal('release-approval') }),
  Schema.Struct({
    ...Reservation,
    applyResult: CommandValue,
    diff: Schema.optionalKey(Schema.Array(AgentDiffLineSchema).check(Schema.isMaxLength(60))),
    operation: Schema.Literal('mark-applied'),
    revert: Schema.optionalKey(AgentRevertPlanSchema),
  }),
  Schema.Struct({ ...Target, note: Schema.optionalKey(Note), operation: Schema.Literal('mark-rejected') }),
  Schema.Struct({ ...Reservation, failure: Text, operation: Schema.Literal('mark-failed') }),
  Schema.Struct({ ...Reservation, operation: Schema.Literal('mark-reverted') }),
  Schema.Struct({ ...Reservation, failure: Text, operation: Schema.Literal('mark-revert-failed') }),
  Schema.Struct({ batchId: Id, note: Schema.optionalKey(Note), operation: Schema.Literal('claim-batch-revert') }),
  Schema.Struct({ batchId: Id, note: Text, operation: Schema.Literal('close-pending-in-batch'), reservationId: Id }),
  // Withdrawal is one complete, bounded batch of a no-longer-active proposer. Call once per batch.
  Schema.Struct({ batchId: Id, note: Text, operation: Schema.Literal('withdraw-pending-of-agent') }),
]);
export type AgentProposalCommandPayload = typeof AgentProposalCommandPayloadSchema.Type;
export const AgentProposalCommandResultSchema = Schema.Struct({
  affectedProposalIds: Schema.Array(Id).check(Schema.isMaxLength(50)),
  batchId: Id,
  outcome: Schema.Literals(['changed', 'unchanged', 'replayed']),
  proposalIds: Schema.Array(Id).check(Schema.isMaxLength(50)),
  // Native invocation IDs are durable reservation identities, not an alternate permission grant.
  reservationId: Schema.optionalKey(Id),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type AgentProposalCommandResult = typeof AgentProposalCommandResultSchema.Type;
export const AgentProposalCommandAuditSchema = Schema.Struct({
  ...AgentProposalCommandResultSchema.fields,
  operation: Schema.Literals([
    'insert',
    'claim-approval',
    'release-approval',
    'mark-applied',
    'mark-rejected',
    'mark-failed',
    'mark-reverted',
    'mark-revert-failed',
    'claim-batch-revert',
    'close-pending-in-batch',
    'withdraw-pending-of-agent',
  ]),
  proposerPrincipalId: Id,
});
export type AgentProposalCommandAudit = typeof AgentProposalCommandAuditSchema.Type;
const SingleTarget = Schema.Struct({ proposalId: Id });
export const proposalCommandTargetId = (payload: AgentProposalCommandPayload) =>
  Schema.is(SingleTarget)(payload) ? Option.some(payload.proposalId) : Option.none<string>();
export const encodeAgentProposalCommand = Schema.encodeEffect(Schema.fromJsonString(AgentCommandSchema));
