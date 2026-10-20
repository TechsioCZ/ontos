// AREA: AI level C (specs AGENT.md) — owned by the ai-level-c lane.
// An AI agent (service principal with an API key) may only PROPOSE changes of client data, contact persons,
// order pairing, assignment and the contact plan. All proposals wait for a human decision.
// No business data changes until a person approves the batch on /crm/schvalovani-ai. Every applied change
// keeps entity snapshots (before -> after), so a human can revert a whole batch ("Vrátit vše"). A readable log of
// every step lives next to the Core audit record of each invocation.
// Adding fields: make them Schema.optionalKey (persisted JSON from older revisions must still decode).
import { Schema } from 'effect';
import { clientsCommandSchemas } from '../commands/clients.ts';
import { importsCommandSchemas } from '../commands/imports.ts';
import { visitsCommandSchemas } from '../commands/visits.ts';
import type { CrmViewer } from './access.ts';
import { canSeeEverything } from './access.ts';
import { EntityIdSchema, IsoTimeSchema, LongTextSchema, PrincipalIdSchema, ShortTextSchema } from './common.ts';

const [CreateClient, UpdateClient, , , AddContactPerson, UpdateContactPerson, , AssignClient] = clientsCommandSchemas;
const [, , PairOrder, UnpairOrder] = importsCommandSchemas;
const [, , PlanContact] = visitsCommandSchemas;

/** The only CRM operations an AI agent may propose. Anything else (archive, import...) is refused. */
export const aiOperationSchemas = [
  CreateClient,
  AssignClient,
  UpdateClient,
  AddContactPerson,
  UpdateContactPerson,
  PairOrder,
  UnpairOrder,
  PlanContact,
] as const;
export const AiOperationSchema = Schema.Union(aiOperationSchemas);
export type AiOperation = typeof AiOperationSchema.Type;
export const aiOperationTags: ReadonlySet<string> = new Set([
  'CreateClient',
  'AssignClient',
  'UpdateClient',
  'AddContactPerson',
  'UpdateContactPerson',
  'PairOrder',
  'UnpairOrder',
  'PlanContact',
]);

export const AiRiskSchema = Schema.Literals(['low', 'medium', 'high']);
export type AiRisk = typeof AiRiskSchema.Type;

export const AiChangeStatusSchema = Schema.Literals(['pending', 'applied', 'rejected', 'reverted', 'failed']);
export type AiChangeStatus = typeof AiChangeStatusSchema.Type;

export const AiEntityKindSchema = Schema.Literals(['client', 'contact', 'order', 'plan']);
export type AiEntityKind = typeof AiEntityKindSchema.Type;

/** One readable line of the before -> after diff. Absent before = new value, absent after = cleared. */
export const AiDiffLineSchema = Schema.Struct({
  after: Schema.optionalKey(LongTextSchema),
  before: Schema.optionalKey(LongTextSchema),
  field: ShortTextSchema,
  label: ShortTextSchema,
});
export type AiDiffLine = typeof AiDiffLineSchema.Type;

/** Exact entity state before/after applying the change; absent before = the change created the entity. */
export const AiSnapshotSchema = Schema.Struct({
  after: Schema.optionalKey(Schema.Unknown),
  before: Schema.optionalKey(Schema.Unknown),
  id: EntityIdSchema,
  kind: AiEntityKindSchema,
});
export type AiSnapshot = typeof AiSnapshotSchema.Type;

export const AiChangeSchema = Schema.Struct({
  appliedAt: Schema.optionalKey(IsoTimeSchema),
  applySequence: Schema.optionalKey(Schema.Int),
  /** Entity snapshots from the dry run; approval refuses stale proposals. */
  proposedSnapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
  /** Applied immediately because the change is low risk (additive, revertible). */
  autoApplied: Schema.optionalKey(Schema.Boolean),
  batchId: EntityIdSchema,
  decidedAt: Schema.optionalKey(IsoTimeSchema),
  decidedBy: Schema.optionalKey(PrincipalIdSchema),
  decisionNote: Schema.optionalKey(LongTextSchema),
  diff: Schema.Array(AiDiffLineSchema),
  failure: Schema.optionalKey(LongTextSchema),
  id: EntityIdSchema,
  operation: AiOperationSchema,
  proposedAt: IsoTimeSchema,
  /** The agent's justification. */
  reason: LongTextSchema,
  revertedAt: Schema.optionalKey(IsoTimeSchema),
  revertedBy: Schema.optionalKey(PrincipalIdSchema),
  risk: AiRiskSchema,
  snapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
  status: AiChangeStatusSchema,
  /** Short Czech summary, e.g. "Úprava údajů klienta". */
  summary: ShortTextSchema,
  target: Schema.Struct({
    id: Schema.optionalKey(EntityIdSchema),
    kind: AiEntityKindSchema,
    label: ShortTextSchema,
  }),
});
export type AiChange = typeof AiChangeSchema.Type;

/** One agent run: everything proposed by one instruction. */
export const AiBatchSchema = Schema.Struct({
  agentLabel: ShortTextSchema,
  agentPrincipalId: PrincipalIdSchema,
  createdAt: IsoTimeSchema,
  id: EntityIdSchema,
  /** What the agent was asked to do (the user's instruction / run summary). */
  instruction: LongTextSchema,
  revertedAt: Schema.optionalKey(IsoTimeSchema),
  revertedBy: Schema.optionalKey(PrincipalIdSchema),
  revertNote: Schema.optionalKey(LongTextSchema),
  /** Agent-side run id; a repeated run id returns the existing batch (no duplicates). */
  runId: Schema.optionalKey(ShortTextSchema),
});
export type AiBatch = typeof AiBatchSchema.Type;

export const AiLogActionSchema = Schema.Literals([
  'proposed',
  'auto_applied',
  'approved',
  'rejected',
  'apply_failed',
  'reverted',
  'revert_conflict',
  'batch_reverted',
]);
export type AiLogAction = typeof AiLogActionSchema.Type;

export const AiLogEntrySchema = Schema.Struct({
  action: AiLogActionSchema,
  actorKind: Schema.Literals(['agent', 'human']),
  actorPrincipalId: PrincipalIdSchema,
  at: IsoTimeSchema,
  batchId: EntityIdSchema,
  changeId: Schema.optionalKey(EntityIdSchema),
  id: EntityIdSchema,
  /** Core action invocation of the step (link to the Core audit record). */
  invocationId: Schema.optionalKey(ShortTextSchema),
  message: LongTextSchema,
});
export type AiLogEntry = typeof AiLogEntrySchema.Type;

export const AiChangesSliceSchema = Schema.Struct({
  batches: Schema.Array(AiBatchSchema),
  changes: Schema.Array(AiChangeSchema),
  log: Schema.Array(AiLogEntrySchema),
});
export type AiChangesSlice = typeof AiChangesSliceSchema.Type;

export const initialAiChangesSlice: AiChangesSlice = { batches: [], changes: [], log: [] };

/** Only read_all viewers (vedení, správce, the agent itself) see the AI approval queue; salespeople do not. */
export const projectAiChangesSlice = (slice: AiChangesSlice | undefined, viewer: CrmViewer): AiChangesSlice =>
  slice !== undefined && canSeeEverything(viewer) ? slice : initialAiChangesSlice;

export const aiRiskLabel: Record<AiRisk, string> = { high: 'Vysoké riziko', low: 'Nízké riziko', medium: 'Střední riziko' };

export const aiStatusLabel: Record<AiChangeStatus, string> = {
  applied: 'Provedeno',
  failed: 'Nelze provést',
  pending: 'Čeká na schválení',
  rejected: 'Zamítnuto',
  reverted: 'Vráceno',
};
