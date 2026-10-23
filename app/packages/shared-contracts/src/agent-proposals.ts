// Platform approval layer for AI agents (any module). Shared wire contract of the shell endpoints
//   POST /shell-super-app-api/agent-platform/proposals        agent (x-api-key)  -> AgentProposalSubmitResponse
//   POST /shell-super-app-api/agent-platform/proposals/list   agent (x-api-key)  -> AgentQueueResponse (own batches)
//   POST /shell-super-app-api/agent-platform/queue            human (session)    -> AgentQueueResponse
//   POST /shell-super-app-api/agent-platform/decide           human (session)    -> AgentDecideResponse
//   POST /shell-super-app-api/agent-platform/revert           human (session)    -> AgentRevertResponse
//   POST /shell-super-app-api/agent-platform/activity         human (session)    -> AgentActivityResponse
// Core-queue proposals live in `core.agent_proposals`; approval runs the stored module command (governed Action
// `<appId>/actions/<actionSlug>`) AS THE APPROVING PERSON, so the module's own permissions and Core audit apply.
// Modules that keep their own AI change engine (`aiChanges`, declared in their MCP contribution) appear in the same queue.
import { DateTime, Result, Schema } from 'effect';

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const LongText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const OptionalNote = Schema.String.check(Schema.isMaxLength(1000));

/** One JSON value of a stored module command; the module's own command schema validates it when the command runs. */
const AgentCommandValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(AgentCommandValueSchema),
    Schema.Record(Schema.String, AgentCommandValueSchema),
  ]),
);

/** A module command as JSON (`_tag` names the command), e.g. `{ _tag: 'ChangePrice', id, priceMinor }`. */
export const AgentCommandSchema = Schema.Record(Schema.String, AgentCommandValueSchema);
export type AgentCommand = typeof AgentCommandSchema.Type;

const agentJsonOf = (value: unknown): Schema.Json | undefined => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => agentJsonOf(item) ?? null);
  }
  return typeof value === 'object' ? agentCommandOf(value) : undefined;
};

/**
 * A command a module builds from its own records (e.g. an undo command from the record read before), as the JSON it
 * is stored and sent as: entries without a JSON value (undefined) are left out, as `JSON.stringify` would.
 */
export const agentCommandOf = (record: object): AgentCommand =>
  Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      const json = agentJsonOf(item);
      return json === undefined ? [] : [[key, json] as const];
    }),
  );

export const AgentRiskSchema = Schema.Literals(['low', 'medium', 'high']);
export type AgentRisk = typeof AgentRiskSchema.Type;

/** One readable line of the before -> after diff. Absent before = new value, absent after = cleared. */
export const AgentDiffLineSchema = Schema.Struct({
  after: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  field: ShortText,
  label: ShortText,
});
export type AgentDiffLine = typeof AgentDiffLineSchema.Type;

/**
 * How to undo one approved command. `commands` run in order as the reverting person. Any string value exactly
 * equal to `$createdId` is replaced by the value at `createdIdPath` (dot path, numeric segments index arrays)
 * of the approved command's response, e.g. `task.ref.resourceId`, `entityIds.0`, `resourceRef.resourceId`.
 */
export const AgentRevertPlanSchema = Schema.Union([
  Schema.Struct({
    commands: Schema.Array(AgentCommandSchema).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    createdIdPath: Schema.optionalKey(ShortText),
    kind: Schema.Literal('commands'),
  }),
  Schema.Struct({ kind: Schema.Literal('none'), reason: ShortText }),
]);
export type AgentRevertPlan = typeof AgentRevertPlanSchema.Type;

export const AGENT_CREATED_ID_PLACEHOLDER = '$createdId';

export const AgentProposalInputSchema = Schema.Struct({
  /** Stable deployment app id of the module (from the composition). */
  appId: ShortText,
  /** Module action slug: `apply-command` (default, body `{ command, expectedRevision }`) or a named Action such as `update-party` whose body is `command` itself (no `_tag`). */
  actionSlug: Schema.optionalKey(ShortText),
  command: AgentCommandSchema,
  diff: Schema.Array(AgentDiffLineSchema).check(Schema.isMaxLength(60)),
  reason: LongText,
  /** Extra audiences whose assertions the module needs (the MCP tool contribution declares them). */
  referenceAudiences: Schema.optionalKey(Schema.Array(ShortText).check(Schema.isMaxLength(5))),
  revert: Schema.optionalKey(AgentRevertPlanSchema),
  risk: AgentRiskSchema,
  /** Short Czech summary, e.g. „Změna ceny produktu“. */
  summary: ShortText,
  /** Readable target, e.g. „Káva Brazil 1 kg (SKU KAV-001)“. */
  targetLabel: ShortText,
});
export type AgentProposalInput = typeof AgentProposalInputSchema.Type;

export const AgentProposalSubmitRequestSchema = Schema.Struct({
  /** Defaults to the agent principal's display name. */
  agentLabel: Schema.optionalKey(ShortText),
  /** What the agent was asked to do. */
  instruction: LongText,
  legalEntityId: Schema.String.check(Schema.isUUID()),
  proposals: Schema.Array(AgentProposalInputSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  /** Agent-side run id; repeating it returns the existing batch (`replayed: true`) instead of a duplicate. */
  runId: Schema.optionalKey(ShortText),
});
export type AgentProposalSubmitRequest = typeof AgentProposalSubmitRequestSchema.Type;

export const AgentProposalSubmitResponseSchema = Schema.Struct({
  batchId: Schema.String,
  proposalIds: Schema.Array(Schema.String),
  replayed: Schema.Boolean,
  /** Path of the platform page, e.g. `/cs/sprava/ke-schvaleni`. */
  reviewPath: Schema.String,
});
export type AgentProposalSubmitResponse = typeof AgentProposalSubmitResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ queue (read)

export const AgentItemStatusSchema = Schema.Literals([
  'pending',
  'applied',
  'rejected',
  'failed',
  'reverted',
  'revert_failed',
]);
export type AgentItemStatus = typeof AgentItemStatusSchema.Type;

export const AgentSourceSchema = Schema.Literals(['core', 'legacy']);
export type AgentSource = typeof AgentSourceSchema.Type;

export const AgentQueueItemSchema = Schema.Struct({
  appId: Schema.String,
  /**
   * True when the current person may approve/reject this item: module write permission and, where the module says
   * so in its records read, the right to carry out this exact command on this record (approval runs as them).
   */
  canDecide: Schema.Boolean,
  /** Czech reason why this person cannot decide a pending item (absent when `canDecide`). */
  cannotDecideReason: Schema.optionalKey(Schema.String),
  /** Exact module command an approval runs (core queue only). */
  command: Schema.optionalKey(AgentCommandSchema),
  decidedAt: Schema.optionalKey(Schema.String),
  decidedByName: Schema.optionalKey(Schema.String),
  decisionNote: Schema.optionalKey(Schema.String),
  diff: Schema.Array(AgentDiffLineSchema),
  /**
   * `platform`: lines built by the platform from the stored command and the record (live while pending).
   * `command`: the platform lists the stored command's values; it does not read the record, so there is no before.
   * `agent`: the platform does not understand this command; the lines are the agent's own description.
   */
  diffSource: Schema.optionalKey(Schema.Literals(['platform', 'command', 'agent'])),
  failure: Schema.optionalKey(Schema.String),
  /** `core:<proposalId>` or `legacy:<appId>:<changeId>`; pass back unchanged in decide requests. */
  key: Schema.String,
  moduleKey: Schema.String,
  moduleLabel: Schema.String,
  proposedAt: Schema.String,
  reason: Schema.String,
  /** Absent when the item can be reverted; otherwise why „Vrátit vše“ skips it. */
  revertUnavailableReason: Schema.optionalKey(Schema.String),
  risk: AgentRiskSchema,
  status: AgentItemStatusSchema,
  summary: Schema.String,
  targetLabel: Schema.String,
});
export type AgentQueueItem = typeof AgentQueueItemSchema.Type;

export const AgentQueueBatchSchema = Schema.Struct({
  agentLabel: Schema.String,
  agentPrincipalId: Schema.String,
  batchId: Schema.String,
  /** True when at least one item is applied and revertible and the person may decide it. */
  canRevertAll: Schema.Boolean,
  createdAt: Schema.String,
  instruction: Schema.String,
  items: Schema.Array(AgentQueueItemSchema),
  /** `core:<batchId>` or `legacy:<appId>:<batchId>`; pass back unchanged in decide/revert requests. */
  key: Schema.String,
  moduleLabels: Schema.Array(Schema.String),
  /** Page of the module that keeps its own AI changes, where the batch is also shown (module-declared). */
  modulePage: Schema.optionalKey(
    Schema.Struct({ label: Schema.Struct({ cs: Schema.String, en: Schema.String }), path: Schema.String }),
  ),
  revertNote: Schema.optionalKey(Schema.String),
  revertedAt: Schema.optionalKey(Schema.String),
  revertedByName: Schema.optionalKey(Schema.String),
  source: AgentSourceSchema,
});
export type AgentQueueBatch = typeof AgentQueueBatchSchema.Type;

export const AgentActivityKindSchema = Schema.Literals(['read', 'write', 'denied', 'failed', 'proposal', 'decision']);
export type AgentActivityKind = typeof AgentActivityKindSchema.Type;

/** Stable descending keyset shared by the platform and owner history reads. */
export const AgentPageCursorSchema = Schema.Struct({
  // Canonical wire position: lexical order must equal chronological order, including milliseconds.
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
});
export type AgentPageCursor = typeof AgentPageCursorSchema.Type;
export const AGENT_PAGE_SIZE = 30;
const ModuleKey = Schema.toEncoded(ShortText.pipe(Schema.brand('ModuleKey')));
const BatchKey = Schema.toEncoded(ShortText.pipe(Schema.brand('AgentBatchKey')));
const AgentPrincipalId = Schema.toEncoded(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AgentPrincipalId')));
export const AgentQueueRequestSchema = Schema.Struct({
  batchKey: Schema.optionalKey(BatchKey),
  cursor: Schema.optionalKey(AgentPageCursorSchema),
  moduleKey: Schema.optionalKey(ModuleKey),
  pendingOnly: Schema.optionalKey(Schema.Boolean),
});
export type AgentQueueRequest = typeof AgentQueueRequestSchema.Type;

/** Owner records reads use this mode to project only a bounded AI history slice in PostgreSQL. */
export const AgentHistoryRequestSchema = Schema.Struct({
  agentPrincipalId: Schema.optionalKey(AgentPrincipalId),
  batchKey: Schema.optionalKey(BatchKey),
  cursor: Schema.optionalKey(AgentPageCursorSchema),
  kind: Schema.optionalKey(AgentActivityKindSchema),
  mode: Schema.Literals(['queue', 'activity']),
  pendingOnly: Schema.optionalKey(Schema.Boolean),
});
export type AgentHistoryRequest = typeof AgentHistoryRequestSchema.Type;

/** Newest first; identifier breaks timestamp ties deterministically (also in SQL). */
export const compareAgentPage = (left: AgentPageCursor, right: AgentPageCursor): number => {
  if (left.at !== right.at) {
    return left.at < right.at ? 1 : -1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
};
export const afterAgentCursor = (entry: AgentPageCursor, cursor: AgentPageCursor | undefined): boolean =>
  cursor === undefined || compareAgentPage(entry, cursor) > 0;

export const AgentQueueResponseSchema = Schema.Struct({
  modules: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, moduleKey: ModuleKey }))),
  nextCursor: Schema.optionalKey(AgentPageCursorSchema),
  /** Newest batch first. */
  batches: Schema.Array(AgentQueueBatchSchema),
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  pendingCount: Schema.Int,
  /** Czech labels of modules whose proposals could not be read right now. */
  unavailableModules: Schema.Array(Schema.String),
});
export type AgentQueueResponse = typeof AgentQueueResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ decide / revert

export const AgentDecideRequestSchema = Schema.Struct({
  batchKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  decision: Schema.Literals(['approve', 'reject']),
  itemKeys: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  note: Schema.optionalKey(OptionalNote),
});
export type AgentDecideRequest = typeof AgentDecideRequestSchema.Type;

export const AgentDecideResultSchema = Schema.Struct({
  itemKey: Schema.String,
  /** Czech reason when not applied/rejected. */
  message: Schema.optionalKey(Schema.String),
  outcome: Schema.Literals(['applied', 'rejected', 'failed', 'forbidden', 'skipped']),
});
export const AgentDecideResponseSchema = Schema.Struct({ results: Schema.Array(AgentDecideResultSchema) });
export type AgentDecideResponse = typeof AgentDecideResponseSchema.Type;

export const AgentRevertRequestSchema = Schema.Struct({
  batchKey: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  note: Schema.optionalKey(OptionalNote),
});
export type AgentRevertRequest = typeof AgentRevertRequestSchema.Type;

export const AgentRevertResponseSchema = Schema.Struct({
  /** Czech summary, e.g. „Vráceny 2 změny, 1 změnu nelze automaticky vrátit.“ */
  message: Schema.String,
  outcome: Schema.Literals(['reverted', 'partial', 'failed']),
});
export type AgentRevertResponse = typeof AgentRevertResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ activity

export const AgentActivityRequestSchema = Schema.Struct({
  agentPrincipalId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  cursor: Schema.optionalKey(AgentPageCursorSchema),
  kind: Schema.optionalKey(AgentActivityKindSchema),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: AGENT_PAGE_SIZE, minimum: 1 }))),
  moduleKey: Schema.optionalKey(ShortText),
});
export type AgentActivityRequest = typeof AgentActivityRequestSchema.Type;

export const AgentActivityEntrySchema = Schema.Struct({
  /** Czech, e.g. „Čtení seznamu“, „Zápis změny“, „Návrh změny“, „Schváleno: Jana Nováková“. */
  actionLabel: Schema.String,
  actionInvocationId: Schema.optionalKey(Schema.String),
  agentName: Schema.String,
  agentPrincipalId: Schema.String,
  detail: Schema.optionalKey(Schema.String),
  /** Present only for a target returned by the owning module as this viewer. */
  record: Schema.optionalKey(Schema.Struct({ label: Schema.String, path: Schema.String })),
  recordReference: Schema.optionalKey(Schema.Struct({ resourceType: Schema.String, resourceId: Schema.String })),
  proposal: Schema.optionalKey(Schema.Struct({ batchKey: Schema.String, itemKey: Schema.String })),
  actionPath: Schema.optionalKey(Schema.String),
  agentPath: Schema.optionalKey(Schema.String),
  modulePath: Schema.optionalKey(Schema.String),
  grants: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String }))),
  id: Schema.String,
  kind: AgentActivityKindSchema,
  moduleKey: Schema.NullOr(Schema.String),
  moduleLabel: Schema.String,
  occurredAt: Schema.String,
  outcomeCode: Schema.String,
});
export type AgentActivityEntry = typeof AgentActivityEntrySchema.Type;

export const AgentActivityResponseSchema = Schema.Struct({
  nextCursor: Schema.optionalKey(AgentPageCursorSchema),
  agents: Schema.Array(Schema.Struct({ name: Schema.String, principalId: Schema.String })),
  entries: Schema.Array(AgentActivityEntrySchema),
  modules: Schema.Array(Schema.Struct({ label: Schema.String, moduleKey: Schema.String })),
});
export type AgentActivityResponse = typeof AgentActivityResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ Czech UI labels

export const agentItemStatusLabel: Readonly<Record<AgentItemStatus, string>> = {
  applied: 'Provedeno',
  failed: 'Nelze provést',
  pending: 'Čeká na schválení',
  rejected: 'Zamítnuto',
  revert_failed: 'Vrácení se nepodařilo',
  reverted: 'Vráceno',
};

export const agentRiskLabel: Readonly<Record<AgentRisk, string>> = {
  high: 'Vysoké riziko',
  low: 'Nízké riziko',
  medium: 'Střední riziko',
};

export const agentActivityKindLabel: Readonly<Record<AgentActivityKind, string>> = {
  decision: 'Rozhodnutí člověka',
  denied: 'Odmítnuto oprávněním',
  failed: 'Chyba',
  proposal: 'Návrh ke schválení',
  read: 'Čtení',
  write: 'Zápis',
};

export const AGENT_APPROVALS_PATH = '/sprava/ke-schvaleni';
export const AGENT_ACTIVITY_PATH = '/sprava/aktivita-agentu';
export const AGENT_REVERT_UNAVAILABLE = 'Tuto změnu nelze automaticky vrátit.';
