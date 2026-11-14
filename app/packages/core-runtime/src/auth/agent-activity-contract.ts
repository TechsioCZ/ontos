import { DateTime, Result, Schema } from 'effect';

const Uuid = Schema.String.check(Schema.isUUID());
const PrincipalId = Uuid.pipe(Schema.brand('PrincipalId'));
const TenantId = Uuid.pipe(Schema.brand('TenantId'));
const LegalEntityId = Uuid.pipe(Schema.brand('LegalEntityId'));
const ProposalId = Uuid.pipe(Schema.brand('AgentProposalId'));
const BatchId = Uuid.pipe(Schema.brand('AgentProposalBatchId'));
const AuditEventId = Uuid.pipe(Schema.brand('AuditEventId'));
const DataAccessEventId = Uuid.pipe(Schema.brand('DataAccessEventId'));
const ActionInvocationId = Uuid.pipe(Schema.brand('ActionInvocationId'));
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ModuleKey = ShortText.pipe(Schema.brand('ModuleKey'));
const AppId = Schema.String.pipe(Schema.brand('DeploymentAppId'));
const RunId = Schema.String.pipe(Schema.brand('AgentProposalRunId'));
const ActionKey = Schema.String.pipe(Schema.brand('ActionKey'));
const ResourceId = Schema.String.pipe(Schema.brand('ResourceId'));

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
  field: ShortText,
  label: ShortText,
});
const RevertPlan = Schema.Union([
  Schema.Struct({
    commands: Schema.Array(Command).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
    createdIdPath: Schema.optionalKey(ShortText),
    kind: Schema.Literal('commands'),
  }),
  Schema.Struct({ kind: Schema.Literal('none'), reason: ShortText }),
]);
export const AgentActivityRiskSchema = Schema.Literals(['low', 'medium', 'high']);
export const AgentActivityStatusSchema = Schema.Literals([
  'pending',
  'applied',
  'rejected',
  'failed',
  'reverted',
  'revert_failed',
]);
export const AGENT_ACTIVITY_CANDIDATE_LIMIT = 31;

/** Native read input, independent of the Shell's HTTP codecs. */
export const AgentActivityRequestSchema = Schema.Struct({
  agentPrincipalId: Schema.optionalKey(Schema.toEncoded(PrincipalId)),
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
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400)).pipe(
        Schema.brand('AgentActivityCursorId'),
      ),
    }),
  ),
  kind: Schema.optionalKey(Schema.Literals(['read', 'write', 'denied', 'failed', 'proposal', 'decision'])),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ maximum: 30, minimum: 1 }))),
  moduleKey: Schema.optionalKey(Schema.toEncoded(ModuleKey)),
});

/** Persisted nulls decode to native Options; the Shell alone restores its existing mapper representation. */
export const AgentActivityProposalSchema = Schema.Struct({
  actionSlug: Schema.String,
  agentLabel: Schema.String,
  agentPrincipalId: PrincipalId,
  appId: AppId,
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
  legalEntityId: LegalEntityId,
  moduleKey: ModuleKey,
  position: Schema.Int,
  proposalId: ProposalId,
  reason: Schema.String,
  referenceAudiences: Schema.Array(Schema.String),
  revert: Schema.OptionFromNullOr(RevertPlan),
  revertedAt: Schema.OptionFromNullOr(Schema.Date),
  revertedByPrincipalId: Schema.OptionFromNullOr(PrincipalId),
  risk: AgentActivityRiskSchema,
  runId: Schema.OptionFromNullOr(RunId),
  status: AgentActivityStatusSchema,
  summary: Schema.String,
  targetLabel: Schema.String,
  tenantId: TenantId,
});

export const AgentActivityActorsInputSchema = Schema.Struct({});
export const AgentActivityActorsResultSchema = Schema.Struct({
  agentIds: Schema.Array(PrincipalId),
  names: Schema.Array(Schema.Struct({ displayName: Schema.String, principalId: PrincipalId })),
});

/** visibleModules only narrows the Core-checked executable modules; it never establishes authority. */
export const AgentActivityInputSchema = Schema.Struct({
  request: AgentActivityRequestSchema,
  visibleModules: Schema.Array(Schema.toEncoded(ModuleKey)).check(Schema.isMaxLength(1000)),
});
const actor = {
  displayName: Schema.String,
  occurredAt: Schema.Date,
  outcome: Schema.String,
  outcomeCode: Schema.String,
  principalId: PrincipalId,
};
const target = {
  targetModuleKey: Schema.OptionFromNullOr(ModuleKey),
  targetResourceId: Schema.OptionFromNullOr(ResourceId),
  targetResourceType: Schema.OptionFromNullOr(Schema.String),
};

/** No arbitrary audit evidence or authentication metadata crosses this projection. */
export const AgentActivityResultSchema = Schema.Struct({
  access: Schema.Array(
    Schema.Struct({
      ...actor,
      accessKind: Schema.String,
      dataAccessEventId: DataAccessEventId,
      servingModuleKey: ModuleKey,
      targetResourceId: target.targetResourceId,
      targetResourceType: target.targetResourceType,
    }),
  ),
  audit: Schema.Array(
    Schema.Struct({
      ...actor,
      ...target,
      actionInvocationId: Schema.OptionFromNullOr(ActionInvocationId),
      actionKey: Schema.OptionFromNullOr(ActionKey),
      auditEventId: AuditEventId,
    }),
  ),
  names: AgentActivityActorsResultSchema.fields.names,
  proposalOnlyAgentIds: Schema.Array(PrincipalId),
  proposals: Schema.Array(AgentActivityProposalSchema),
});
