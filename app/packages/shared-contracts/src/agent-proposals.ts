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
import { DateTime, Predicate, Result, Schema } from 'effect';

const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const LongText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000));
const OptionalNote = Schema.String.check(Schema.isMaxLength(1000));

// Brands identify domain roles without changing the strings admitted by existing response codecs.
export const AgentAppIdSchema = Schema.String.pipe(Schema.brand('DeploymentAppId'));
export const AgentModuleKeySchema = Schema.String.pipe(Schema.brand('ModuleKey'));
export const AgentBatchIdSchema = Schema.String.pipe(Schema.brand('AgentProposalBatchId'));
export const AgentProposalIdSchema = Schema.String.pipe(Schema.brand('AgentProposalId'));
export const AgentPrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
export const AgentLegalEntityIdSchema = Schema.String.pipe(Schema.brand('LegalEntityId'));
export const AgentRunIdSchema = Schema.String.pipe(Schema.brand('AgentProposalRunId'));
export const AgentBatchKeySchema = Schema.String.pipe(Schema.brand('AgentBatchKey'));
export const AgentItemKeySchema = Schema.String.pipe(Schema.brand('AgentItemKey'));
export const AgentActivityIdSchema = Schema.String.pipe(Schema.brand('AgentActivityId'));
export const AgentActionInvocationIdSchema = Schema.String.pipe(Schema.brand('ActionInvocationId'));
export const AgentResourceIdSchema = Schema.String.pipe(Schema.brand('ResourceId'));
export const AgentResourceTypeSchema = Schema.String.pipe(Schema.brand('ResourceType'));

/** Pre-JSON command construction includes the three nonfinite numeric values normalized to null on storage. */
const AgentNonFiniteSourceNumberSchema = Schema.declare(Predicate.isNumber).check(
  Schema.makeFilter((value) =>
    Object.is(value, Number.NaN) || value === Number.POSITIVE_INFINITY || value === Number.NEGATIVE_INFINITY
      ? undefined
      : 'Expected NaN, positive infinity or negative infinity before command JSON normalization.',
  ),
);
export const AgentCommandSourceNumberSchema = Schema.Union([Schema.Finite, AgentNonFiniteSourceNumberSchema]);
export const isAgentCommandSourceNumber = Schema.is(AgentCommandSourceNumberSchema);

/** Internal command construction permits absent properties; the stored command is always JSON. */
export type AgentCommandSourceValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly AgentCommandSourceValue[]
  | AgentCommandSource;
export interface AgentCommandSource {
  readonly [key: string]: AgentCommandSourceValue;
}

export const AgentCommandSourceValueSchema: Schema.Codec<AgentCommandSourceValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    AgentCommandSourceNumberSchema,
    Schema.Boolean,
    Schema.Null,
    Schema.Undefined,
    Schema.Array(AgentCommandSourceValueSchema),
    Schema.Record(Schema.String, AgentCommandSourceValueSchema),
  ]),
);
const isSourceArray = Schema.is(Schema.Array(AgentCommandSourceValueSchema));
export const AgentCommandSourceSchema = Schema.Record(Schema.String, AgentCommandSourceValueSchema);
const isSourceRecord = Schema.is(AgentCommandSourceSchema);

/** One JSON value of a stored module command; the module's own command schema validates it when the command runs. */
export const AgentCommandValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
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

const agentJsonOf = (value: AgentCommandSourceValue): Schema.Json | undefined => {
  if (value === null || Schema.is(Schema.String)(value) || Schema.is(Schema.Boolean)(value)) {
    return value;
  }
  if (isAgentCommandSourceNumber(value)) {
    return Number.isFinite(value) ? value : null;
  }
  if (isSourceArray(value)) {
    return value.map((item) => agentJsonOf(item) ?? null);
  }
  if (!isSourceRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const json = agentJsonOf(item);
      return json === undefined ? [] : [[key, json] as const];
    }),
  );
};

/** Entries without a JSON value are omitted; nonfinite numbers and absent array values become null. */
export const agentCommandOf = (record: AgentCommandSource): AgentCommand =>
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
  appId: AgentAppIdSchema.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
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
  legalEntityId: AgentLegalEntityIdSchema.check(Schema.isUUID()),
  proposals: Schema.Array(AgentProposalInputSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  /** Agent-side run id; repeating it returns the existing batch (`replayed: true`) instead of a duplicate. */
  runId: Schema.optionalKey(AgentRunIdSchema.check(Schema.isMinLength(1), Schema.isMaxLength(300))),
});
export type AgentProposalSubmitRequest = typeof AgentProposalSubmitRequestSchema.Type;

export const AgentProposalSubmitResponseSchema = Schema.Struct({
  batchId: AgentBatchIdSchema,
  proposalIds: Schema.Array(AgentProposalIdSchema),
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
  appId: AgentAppIdSchema,
  /**
   * True when the current person may approve/reject this item: module write permission and, where the module says
   * so in its records read, the right to carry out this exact command on this record (approval runs as them).
   */
  canDecide: Schema.Boolean,
  /** Czech reason why this person cannot decide a pending item (absent when `canDecide`). */
  cannotDecideReason: Schema.optionalKey(Schema.String),
  /** Exact module command an approval runs (core queue only). */
  command: Schema.optionalKey(AgentCommandSchema),
  decidedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
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
  key: AgentItemKeySchema,
  moduleKey: AgentModuleKeySchema,
  moduleLabel: Schema.String,
  proposedAt: Schema.DateTimeUtcFromString,
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
  agentPrincipalId: AgentPrincipalIdSchema,
  batchId: AgentBatchIdSchema,
  /** True when at least one item is applied and revertible and the person may decide it. */
  canRevertAll: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  instruction: Schema.String,
  items: Schema.Array(AgentQueueItemSchema),
  /** `core:<batchId>` or `legacy:<appId>:<batchId>`; pass back unchanged in decide/revert requests. */
  key: AgentBatchKeySchema,
  moduleLabels: Schema.Array(Schema.String),
  /** Page of the module that keeps its own AI changes, where the batch is also shown (module-declared). */
  modulePage: Schema.optionalKey(
    Schema.Struct({ label: Schema.Struct({ cs: Schema.String, en: Schema.String }), path: Schema.String }),
  ),
  revertedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  revertedByName: Schema.optionalKey(Schema.String),
  revertNote: Schema.optionalKey(Schema.String),
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
  ).pipe(Schema.brand('AgentPageCursorAt')),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(Schema.brand('AgentPageCursorId')),
});
export type AgentPageCursor = typeof AgentPageCursorSchema.Type;
export const AGENT_PAGE_SIZE = 30;
const ModuleKey = AgentModuleKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const BatchKey = AgentBatchKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const AgentPrincipalId = AgentPrincipalIdSchema.check(Schema.isUUID());
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
  company: Schema.Struct({ legalEntityId: AgentLegalEntityIdSchema, legalName: Schema.String }),
  pendingCount: Schema.Int,
  /** Czech labels of modules whose proposals could not be read right now. */
  unavailableModules: Schema.Array(Schema.String),
});
export type AgentQueueResponse = typeof AgentQueueResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ decide / revert

export const AgentDecideRequestSchema = Schema.Struct({
  batchKey: AgentBatchKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
  decision: Schema.Literals(['approve', 'reject']),
  itemKeys: Schema.Array(AgentItemKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(400))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50),
  ),
  note: Schema.optionalKey(OptionalNote),
});
export type AgentDecideRequest = typeof AgentDecideRequestSchema.Type;

export const AgentDecideResultSchema = Schema.Struct({
  itemKey: AgentItemKeySchema,
  /** Czech reason when not applied/rejected. */
  message: Schema.optionalKey(Schema.String),
  outcome: Schema.Literals(['applied', 'rejected', 'failed', 'forbidden', 'skipped']),
});
export const AgentDecideResponseSchema = Schema.Struct({ results: Schema.Array(AgentDecideResultSchema) });
export type AgentDecideResponse = typeof AgentDecideResponseSchema.Type;

export const AgentRevertRequestSchema = Schema.Struct({
  batchKey: AgentBatchKeySchema.check(Schema.isMinLength(1), Schema.isMaxLength(400)),
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
  agentPrincipalId: Schema.optionalKey(AgentPrincipalId),
  cursor: Schema.optionalKey(AgentPageCursorSchema),
  kind: Schema.optionalKey(AgentActivityKindSchema),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: AGENT_PAGE_SIZE, minimum: 1 }))),
  moduleKey: Schema.optionalKey(ModuleKey),
});
export type AgentActivityRequest = typeof AgentActivityRequestSchema.Type;

export const AgentRecordReferenceSchema = Schema.Struct({
  resourceId: AgentResourceIdSchema,
  resourceType: AgentResourceTypeSchema,
});
export const AgentProposalReferenceSchema = Schema.Struct({
  batchKey: AgentBatchKeySchema,
  itemKey: AgentItemKeySchema,
});

export const AgentActivityEntrySchema = Schema.Struct({
  actionInvocationId: Schema.optionalKey(AgentActionInvocationIdSchema),
  /** Czech, e.g. „Čtení seznamu“, „Zápis změny“, „Návrh změny“, „Schváleno: Jana Nováková“. */
  actionLabel: Schema.String,
  actionPath: Schema.optionalKey(Schema.String),
  agentName: Schema.String,
  agentPath: Schema.optionalKey(Schema.String),
  agentPrincipalId: AgentPrincipalIdSchema,
  detail: Schema.optionalKey(Schema.String),
  grants: Schema.optionalKey(Schema.Array(Schema.Struct({ label: Schema.String, path: Schema.String }))),
  id: AgentActivityIdSchema,
  kind: AgentActivityKindSchema,
  moduleKey: Schema.OptionFromNullOr(AgentModuleKeySchema),
  moduleLabel: Schema.String,
  modulePath: Schema.optionalKey(Schema.String),
  occurredAt: Schema.DateTimeUtcFromString,
  outcomeCode: Schema.String,
  proposal: Schema.optionalKey(AgentProposalReferenceSchema),
  /** Present only for a target returned by the owning module as this viewer. */
  record: Schema.optionalKey(Schema.Struct({ label: Schema.String, path: Schema.String })),
  recordReference: Schema.optionalKey(AgentRecordReferenceSchema),
});
export type AgentActivityEntry = typeof AgentActivityEntrySchema.Type;

export const AgentActivityResponseSchema = Schema.Struct({
  agents: Schema.Array(Schema.Struct({ name: Schema.String, principalId: AgentPrincipalIdSchema })),
  entries: Schema.Array(AgentActivityEntrySchema),
  modules: Schema.Array(Schema.Struct({ label: Schema.String, moduleKey: AgentModuleKeySchema })),
  nextCursor: Schema.optionalKey(AgentPageCursorSchema),
});
export type AgentActivityResponse = typeof AgentActivityResponseSchema.Type;

// ------------------------------------------------------------------------------------------------ Czech UI labels

export const agentItemStatusLabel = {
  applied: 'Provedeno',
  failed: 'Nelze provést',
  pending: 'Čeká na schválení',
  rejected: 'Zamítnuto',
  revert_failed: 'Vrácení se nepodařilo',
  reverted: 'Vráceno',
} satisfies Readonly<Record<AgentItemStatus, string>>;

export const agentRiskLabel = {
  high: 'Vysoké riziko',
  low: 'Nízké riziko',
  medium: 'Střední riziko',
} satisfies Readonly<Record<AgentRisk, string>>;

export const agentActivityKindLabel = {
  decision: 'Rozhodnutí člověka',
  denied: 'Odmítnuto oprávněním',
  failed: 'Chyba',
  proposal: 'Návrh ke schválení',
  read: 'Čtení',
  write: 'Zápis',
} satisfies Readonly<Record<AgentActivityKind, string>>;

export const AGENT_APPROVALS_PATH = '/sprava/ke-schvaleni';
export const AGENT_ACTIVITY_PATH = '/sprava/aktivita-agentu';
export const AGENT_REVERT_UNAVAILABLE = 'Tuto změnu nelze automaticky vrátit.';
