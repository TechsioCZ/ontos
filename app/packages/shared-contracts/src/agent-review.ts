// Agent review read: the wire contract between the platform approval layer and a module that describes its own
// commands. A module declares the read in its MCP contribution (`approvalReview`); the platform posts the stored
// commands to it AS THE READING PERSON (agent at submission, person in the queue, approver, reverting person) and
// gets back what only the module knows: whether that person may see the proposal, whether they can carry out the
// command, the before -> after lines, how to undo it, whether the change is still in place and what to do after it
// was approved. The platform names no module and interprets no command.
import { Schema } from 'effect';

import { AgentCommandSchema, AgentDiffLineSchema, AgentRevertPlanSchema } from './agent-proposals.ts';

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

/**
 * `proposed`: a pending proposal, judged against the live record (submission, queue, approval).
 * `history`: a decided proposal shown in the queue; only visibility and the command's own lines (no live `before`).
 * `undo`: an applied proposal about to be reverted; is the change still in place?
 */
export const AgentReviewStageSchema = Schema.Literals(['proposed', 'history', 'undo']);
export type AgentReviewStage = typeof AgentReviewStageSchema.Type;

export const AgentReviewItemRequestSchema = Schema.Struct({
  actionSlug: ShortText,
  command: AgentCommandSchema,
  /** Echoed in the answer. */
  key: ShortText,
  /** Who proposed the change, given when it is about to be approved, so the module can record the provenance. */
  proposal: Schema.optionalKey(
    Schema.Struct({ agentLabel: ShortText, proposalId: ShortText, summary: Schema.String.check(Schema.isMaxLength(300)) }),
  ),
  stage: AgentReviewStageSchema,
});
export type AgentReviewItemRequest = typeof AgentReviewItemRequestSchema.Type;

export const AgentReviewRequestSchema = Schema.Struct({
  items: Schema.Array(AgentReviewItemRequestSchema).check(Schema.isMaxLength(300)),
});
export type AgentReviewRequest = typeof AgentReviewRequestSchema.Type;

/** Commands the platform runs as the approver right after the approved command applied (best effort). */
export const AgentFollowUpSchema = Schema.Struct({
  commands: Schema.Array(AgentCommandSchema).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  /** Dot path of the created record id in the approved command's answer; replaces `$createdId` in `commands`. */
  createdIdPath: Schema.optionalKey(ShortText),
  /** Extra audiences whose assertions the follow-up commands need. */
  referenceAudiences: Schema.Array(ShortText).check(Schema.isMaxLength(5)),
});
export type AgentFollowUp = typeof AgentFollowUpSchema.Type;

export const AgentReviewItemSchema = Schema.Struct({
  /** Why this person cannot carry out the command now (`proposed` only); absent when they can. */
  blockedReason: Schema.optionalKey(ShortText),
  /** Before -> after lines; absent when the module has no lines of its own for this command. */
  diff: Schema.optionalKey(Schema.Array(AgentDiffLineSchema).check(Schema.isMaxLength(60))),
  followUp: Schema.optionalKey(AgentFollowUpSchema),
  key: ShortText,
  /** Undo plan built from the live record (`proposed`); stored when the proposal is approved. */
  revert: Schema.optionalKey(AgentRevertPlanSchema),
  /** Why „Vrátit vše“ will not undo this change once approved (`proposed`); absent when it will. */
  revertUnavailableReason: Schema.optionalKey(ShortText),
  /** `undo`: false when the record changed since the approval, so undoing it would overwrite someone's edit. */
  stillInPlace: Schema.optionalKey(Schema.Boolean),
  /** Name of the record the command changes, read live. */
  targetName: Schema.optionalKey(ShortText),
  /**
   * May this person see the proposal at all. `false` hides it from them (also its history) and refuses it at
   * submission; for `proposed` and `undo` also when the record the command changes no longer exists for them.
   */
  visible: Schema.Boolean,
});
export type AgentReviewItem = typeof AgentReviewItemSchema.Type;

export const AgentReviewResponseSchema = Schema.Struct({
  items: Schema.Array(AgentReviewItemSchema),
  /** The person sees every record of the module (not only their own), so they also see all agent activity in it. */
  seesAllRecords: Schema.Boolean,
});
export type AgentReviewResponse = typeof AgentReviewResponseSchema.Type;
