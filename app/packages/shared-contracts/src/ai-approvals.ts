// AI level C (specs AGENT.md §3): proposals of an AI agent that change business data only after a person approves
// them in the application, with a readable log and a bulk "Vrátit vše" revert. This module is the module-neutral
// engine; each vertical plugs its own state, operations and reducers in through an `AiApprovalAdapter`.
//
//   propose  agent (API key): one pending batch. Every proposal is dry-run against the current state first, so an
//            operation outside the module's rules is refused at once. Nothing is written to business data.
//   decide   human: approve (runs the stored operation through the module's reducer as the approver) or reject.
//            A proposal whose entities changed since the dry run is refused (stale).
//   revert   human: restores every applied change of one batch, newest first, only when nobody changed the
//            entities since; pending proposals of the batch are rejected. History stays (nothing is deleted).
//
// Snapshots are stored ENCODED (wire JSON) so they compare equal after a database round trip.
import { Effect, Option, Result, Schema } from 'effect';
import { AiAdapterFailure } from './ai-adapter-failure.ts';

export { AiAdapterFailure } from './ai-adapter-failure.ts';

const ShortText = Schema.String.check(Schema.isMaxLength(300));
const LongText = Schema.String.check(Schema.isMaxLength(4000));

export const AiPrincipalIdSchema = ShortText.pipe(Schema.brand('AiPrincipalId'));
export const AiBatchIdSchema = ShortText.pipe(Schema.brand('AiBatchId'));
export const AiChangeIdSchema = ShortText.pipe(Schema.brand('AiChangeId'));
export const AiRunIdSchema = ShortText.pipe(Schema.brand('AiRunId'));
export const AiInvocationIdSchema = ShortText.pipe(Schema.brand('AiInvocationId'));
export const AiLogIdSchema = ShortText.pipe(Schema.brand('AiLogId'));

export const AiRiskSchema = Schema.Literals(['low', 'medium', 'high']);
export type AiRisk = typeof AiRiskSchema.Type;

export const AiChangeStatusSchema = Schema.Literals(['pending', 'applied', 'rejected', 'reverted', 'failed']);
export type AiChangeStatus = typeof AiChangeStatusSchema.Type;

/** One readable line of the before -> after diff. Absent before = new value, absent after = cleared. */
export const AiDiffLineSchema = Schema.Struct({
  after: Schema.optionalKey(LongText),
  before: Schema.optionalKey(LongText),
  field: ShortText,
  label: ShortText,
});
export type AiDiffLine = typeof AiDiffLineSchema.Type;

/** An encoded entity snapshot contains only JSON values. */
export const AiSnapshotValueSchema: Schema.Codec<Schema.Json> = Schema.suspend(() =>
  Schema.Union([
    Schema.Null,
    Schema.Finite,
    Schema.Boolean,
    Schema.String,
    Schema.Array(AiSnapshotValueSchema),
    Schema.Record(Schema.String, AiSnapshotValueSchema),
  ]),
);

/** Exact encoded entity before/after the change; absent before = the change created the entity. */
export const AiSnapshotSchema = Schema.Struct({
  after: Schema.optionalKey(AiSnapshotValueSchema),
  before: Schema.optionalKey(AiSnapshotValueSchema),
  id: ShortText,
  kind: ShortText,
});
export type AiSnapshot = typeof AiSnapshotSchema.Type;

export const AiTargetSchema = Schema.Struct({
  id: Schema.optionalKey(ShortText),
  kind: ShortText,
  label: ShortText,
});
export type AiTarget = typeof AiTargetSchema.Type;

/** Canonical UTC strings round-trip exactly; valid offset timestamps normalize to UTC when next encoded. */
export const AiBatchSchema = Schema.Struct({
  agentLabel: ShortText,
  agentPrincipalId: AiPrincipalIdSchema,
  createdAt: Schema.DateTimeUtcFromString,
  id: AiBatchIdSchema,
  /** What the agent was asked to do. */
  instruction: LongText,
  revertedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  revertedBy: Schema.optionalKey(AiPrincipalIdSchema),
  revertNote: Schema.optionalKey(LongText),
  /** Agent-side run id; a repeated run id returns the existing batch (no duplicates). */
  runId: Schema.optionalKey(AiRunIdSchema),
});
export type AiBatch = typeof AiBatchSchema.Type;

export const AiLogActionSchema = Schema.Literals([
  'proposed',
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
  actorPrincipalId: AiPrincipalIdSchema,
  at: Schema.DateTimeUtcFromString,
  batchId: AiBatchIdSchema,
  changeId: Schema.optionalKey(AiChangeIdSchema),
  id: AiLogIdSchema,
  /** Core action invocation of the step (link to the Core audit record). */
  invocationId: Schema.optionalKey(AiInvocationIdSchema),
  message: LongText,
});
export type AiLogEntry = typeof AiLogEntrySchema.Type;

const changeFieldsBeforeOperation = {
  appliedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  applySequence: Schema.optionalKey(Schema.Int),
  batchId: AiBatchIdSchema,
  decidedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  decidedBy: Schema.optionalKey(AiPrincipalIdSchema),
  decisionNote: Schema.optionalKey(LongText),
  diff: Schema.Array(AiDiffLineSchema),
  failure: Schema.optionalKey(LongText),
  id: AiChangeIdSchema,
};
const changeFieldsAfterOperation = {
  proposedAt: Schema.DateTimeUtcFromString,
  /** Entity snapshots of the dry run; approval refuses stale proposals. */
  proposedSnapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
  reason: LongText,
  revertedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  revertedBy: Schema.optionalKey(AiPrincipalIdSchema),
  risk: AiRiskSchema,
  snapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
  status: AiChangeStatusSchema,
  summary: ShortText,
  target: AiTargetSchema,
};
const AiChangeMetadataSchema = Schema.Struct({ ...changeFieldsBeforeOperation, ...changeFieldsAfterOperation });

/** Change and slice schemas for one module's operation union, preserving encoded field order. */
export const makeAiApprovalSchemas = <Operation extends Schema.Top>(operation: Operation) => {
  const change = Schema.Struct({ ...changeFieldsBeforeOperation, operation, ...changeFieldsAfterOperation });
  const slice = Schema.Struct({
    batches: Schema.Array(AiBatchSchema),
    changes: Schema.Array(change),
    log: Schema.Array(AiLogEntrySchema),
  });
  return { change, slice };
};

export type AiChange<Operation> = typeof AiChangeMetadataSchema.Type & { readonly operation: Operation };

export interface AiSlice<Operation> {
  readonly batches: readonly AiBatch[];
  readonly changes: readonly AiChange<Operation>[];
  readonly log: readonly AiLogEntry[];
}

export const emptyAiSlice = <Operation>(): AiSlice<Operation> => ({ batches: [], changes: [], log: [] });

export const aiRiskLabel = {
  high: 'Vysoké riziko',
  low: 'Nízké riziko',
  medium: 'Střední riziko',
} satisfies Readonly<Record<AiRisk, string>>;

export const aiStatusLabel = {
  applied: 'Provedeno',
  failed: 'Nelze provést',
  pending: 'Čeká na schválení',
  rejected: 'Zamítnuto',
  reverted: 'Vráceno',
} satisfies Readonly<Record<AiChangeStatus, string>>;

export const aiLogActionLabel = {
  apply_failed: 'Neprovedeno',
  approved: 'Schváleno a provedeno',
  batch_reverted: 'Dávka vrácena',
  proposed: 'Uloženo ke schválení',
  rejected: 'Zamítnuto',
  revert_conflict: 'Vrácení zablokováno',
  reverted: 'Vráceno',
} satisfies Readonly<Record<AiLogAction, string>>;

// ------------------------------------------------------------------------------------------------ engine

export const AiContextSchema = Schema.Struct({
  invocationId: AiInvocationIdSchema,
  now: Schema.DateTimeUtc,
  principalId: AiPrincipalIdSchema,
});
export type AiContext = typeof AiContextSchema.Type;

/** Engine rejection; kind/message retain the public contract and cause keeps an adapter failure when present. */
export class AiFailure extends Schema.TaggedError<AiFailure>()('AiFailure', {
  cause: Schema.optionalKey(AiAdapterFailure),
  kind: Schema.Literals(['conflict', 'invalid', 'not_found']),
  message: Schema.String,
}) {}

export interface AiDescribed {
  readonly diff: readonly AiDiffLine[];
  readonly summary: string;
  readonly target: AiTarget;
}

export interface AiEntity {
  readonly id: string;
}

/** Reducers return new state values. Description, codecs and reducers compose through Effect; collection access stays pure. */
export interface AiApprovalAdapter<State, Operation extends { readonly _tag: string }> {
  /** True when the operation creates the entity its target points at (target id = first entity id). */
  readonly creates: (operation: Operation) => boolean;
  readonly describe: (state: State, operation: Operation) => Effect.Effect<AiDescribed, AiAdapterFailure>;
  /** Wire (JSON) form of one entity of `kind`. */
  readonly encode: (kind: string, entity: AiEntity) => Effect.Effect<Schema.Json, AiAdapterFailure>;
  readonly entities: (state: State, kind: string) => readonly AiEntity[];
  readonly getSlice: (state: State) => AiSlice<Operation> | undefined;
  /** Entity collections a change may create or modify (snapshot kinds). */
  readonly kinds: readonly string[];
  /** Undo one snapshot of an applied change; the engine already verified the entity is unchanged since. */
  readonly restore: (
    state: State,
    snapshot: AiSnapshot,
    context: AiContext & { readonly suffix: string },
    note: string,
  ) => Effect.Effect<State, AiAdapterFailure>;
  readonly risk: (operation: Operation) => AiRisk;
  /** Runs one operation through the module's own reducer; every module rule applies. Failures retain a readable message and their original cause. */
  readonly run: (
    state: State,
    operation: Operation,
    invocationId: string,
  ) => Effect.Effect<{ readonly entityIds: readonly string[]; readonly state: State }, AiAdapterFailure>;
  readonly setSlice: (state: State, slice: AiSlice<Operation>) => State;
}

/** JSONB reorders object keys on persistence; snapshots compare values, not insertion order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Hash operands are signed or unsigned 32-bit integers from constants, XOR, or Math.imul. */
const unsignedAiWord = (value: number): number => (value < 0 ? value + 0x1_00_00_00_00 : value);

/** Binary digits differ exactly where XOR sets a bit; each sum stays below 2^32. */
const xorAiWord = (left: number, right: number): number => {
  let a = unsignedAiWord(left);
  let b = unsignedAiWord(right);
  let result = 0;
  for (let place = 1; place < 0x1_00_00_00_00; place *= 2) {
    if (a % 2 !== b % 2) {
      result += place;
    }
    a = Math.floor(a / 2);
    b = Math.floor(b / 2);
  }
  return result;
};

const shiftAiWord = (value: number, distance: number): number => Math.floor(unsignedAiWord(value) / 2 ** distance);

/** Deterministic RFC 4122-shaped id from a seed (pure; same seed, same id). */
export const deriveAiUuid = (seed: string): string => {
  let h1 = 0x6a_09_e6_67;
  let h2 = 0xbb_67_ae_85;
  let h3 = 0x3c_6e_f3_72;
  let h4 = 0xa5_4f_f5_3a;
  for (let index = 0; index < seed.length; index += 1) {
    const point = seed.codePointAt(index) ?? 0;
    // Keep both UTF-16 iterations. A paired high surrogate is recovered from the full code point;
    // the next index supplies its low surrogate. Unpaired surrogates pass through unchanged.
    const code = point > 0xff_ff ? 0xd8_00 + Math.floor((point - 0x1_00_00) / 0x4_00) : point;
    h1 = xorAiWord(h2, Math.imul(xorAiWord(h1, code), 597_399_067));
    h2 = xorAiWord(h3, Math.imul(xorAiWord(h2, code), 2_869_860_233));
    h3 = xorAiWord(h4, Math.imul(xorAiWord(h3, code), 951_274_213));
    h4 = xorAiWord(h1, Math.imul(xorAiWord(h4, code), 2_716_044_179));
  }
  h1 = Math.imul(xorAiWord(h3, shiftAiWord(h1, 18)), 597_399_067);
  h2 = Math.imul(xorAiWord(h4, shiftAiWord(h2, 22)), 2_869_860_233);
  h3 = Math.imul(xorAiWord(h1, shiftAiWord(h3, 17)), 951_274_213);
  h4 = Math.imul(xorAiWord(h2, shiftAiWord(h4, 19)), 2_716_044_179);
  const hex = [xorAiWord(xorAiWord(xorAiWord(h1, h2), h3), h4), xorAiWord(h2, h1), xorAiWord(h3, h1), xorAiWord(h4, h1)]
    .map((part) => part.toString(16).padStart(8, '0'))
    .join('');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) % 4) + 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const invalid = (message: string, cause?: AiAdapterFailure): AiFailure =>
  cause === undefined
    ? new AiFailure({ kind: 'invalid', message })
    : new AiFailure({ cause, kind: 'invalid', message });
const conflict = (message: string, cause?: AiAdapterFailure): AiFailure =>
  cause === undefined
    ? new AiFailure({ kind: 'conflict', message })
    : new AiFailure({ cause, kind: 'conflict', message });
const notFound = (message: string): AiFailure => new AiFailure({ kind: 'not_found', message });

const snapshotOfEntity = Effect.fn('AiApprovals.snapshotOfEntity')(function* collectEntitySnapshot<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  kind: string,
  before: ReadonlyMap<string, AiEntity>,
  entity: AiEntity,
): Effect.fn.Return<readonly AiSnapshot[], AiAdapterFailure> {
  const old = before.get(entity.id);
  if (old === entity) {
    return [];
  }
  // Encode the new entity before its previous value, as the persisted snapshot contract requires.
  const after = yield* adapter.encode(kind, entity);
  if (old === undefined) {
    return [{ after, id: entity.id, kind }];
  }
  const encodedBefore = yield* adapter.encode(kind, old);
  return sameJson(encodedBefore, after) ? [] : [{ after, before: encodedBefore, id: entity.id, kind }];
});

const snapshotsOfKind = Effect.fn('AiApprovals.snapshotsOfKind')(function* collectKindSnapshots<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  previous: State,
  next: State,
  kind: string,
): Effect.fn.Return<readonly AiSnapshot[], AiAdapterFailure> {
  const before = new Map(adapter.entities(previous, kind).map((entity) => [entity.id, entity] as const));
  const snapshots = yield* Effect.forEach(
    adapter.entities(next, kind),
    (entity) => snapshotOfEntity(adapter, kind, before, entity),
    { concurrency: 1 },
  );
  return snapshots.flat();
});

/** Every entity the change created or modified, with its exact previous and next encoded value. */
const snapshotsBetween = Effect.fn('AiApprovals.snapshotsBetween')(function* collectSnapshots<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  previous: State,
  next: State,
): Effect.fn.Return<readonly AiSnapshot[], AiAdapterFailure> {
  const snapshots = yield* Effect.forEach(adapter.kinds, (kind) => snapshotsOfKind(adapter, previous, next, kind), {
    concurrency: 1,
  });
  return snapshots.flat();
});

const currentEncoded = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  kind: string,
  id: string,
): Effect.Effect<Option.Option<Schema.Json>, AiAdapterFailure> =>
  Effect.suspend((): Effect.Effect<Option.Option<Schema.Json>, AiAdapterFailure> => {
    const entity = adapter.entities(state, kind).find((entry) => entry.id === id);
    return entity === undefined ? Effect.succeedNone : adapter.encode(kind, entity).pipe(Effect.asSome);
  });

const sliceOf = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
): AiSlice<Operation> => adapter.getSlice(state) ?? emptyAiSlice<Operation>();

const replaceChange = <Operation>(changes: readonly AiChange<Operation>[], next: AiChange<Operation>) =>
  changes.map((entry) => (entry.id === next.id ? next : entry));

const invalidIdentity = (cause: Schema.SchemaError) => {
  const message = 'Identitu záznamu schvalování AI nelze vytvořit.';
  return invalid(message, new AiAdapterFailure({ cause, message }));
};

const logEntry = Effect.fn('AiApprovals.logEntry')(function* createLogEntry(
  context: AiContext,
  index: number,
  entry: Omit<AiLogEntry, 'actorPrincipalId' | 'at' | 'id' | 'invocationId'>,
): Effect.fn.Return<AiLogEntry, AiFailure> {
  const id = yield* Schema.decodeEffect(AiLogIdSchema)(`${context.invocationId}:ai-log-${index}`).pipe(
    Effect.mapError(invalidIdentity),
  );
  return { ...entry, actorPrincipalId: context.principalId, at: context.now, id, invocationId: context.invocationId };
});

/** Czech plural: 1 změna vrácena, 2–4 změny vráceny, 0/5+ změn vráceno. */
const revertedCount = (count: number) => {
  if (count === 1) {
    return '1 provedená změna vrácena';
  }
  if (count >= 2 && count <= 4) {
    return `${count} provedené změny vráceny`;
  }
  return `${count} provedených změn vráceno`;
};

const subInvocation = (context: AiContext, suffix: string) => deriveAiUuid(`${context.invocationId}:${suffix}`);

export interface AiProposal<Operation> {
  readonly agentLabel: string;
  readonly changes: readonly { readonly operation: Operation; readonly reason: string }[];
  readonly instruction: string;
  readonly runId?: string | undefined;
}

export interface AiOutcome<State> {
  /** First id is the batch (propose/revert) or the decided change ids (decide). */
  readonly entityIds: readonly string[];
  readonly state: State;
}

interface ProposalProgress<Operation> {
  readonly changes: readonly AiChange<Operation>[];
  readonly log: readonly AiLogEntry[];
  readonly touched: ReadonlySet<string>;
}

const claimSnapshots = (
  previous: ReadonlySet<string>,
  snapshots: readonly AiSnapshot[],
): Option.Option<ReadonlySet<string>> => {
  const touched = new Set(previous);
  for (const snapshot of snapshots) {
    const key = `${snapshot.kind}:${snapshot.id}`;
    if (snapshot.before !== undefined && touched.has(key)) {
      return Option.none();
    }
    touched.add(key);
  }
  return Option.some(touched);
};

const prepareProposal = Effect.fn('AiApprovals.prepareProposal')(function* prepareOneProposal<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  progress: ProposalProgress<Operation>,
  entry: AiProposal<Operation>['changes'][number],
  index: number,
  batch: AiBatch,
  context: AiContext,
): Effect.fn.Return<ProposalProgress<Operation>, AiFailure> {
  const { described, dryRun } = yield* adapter.describe(state, entry.operation).pipe(
    Effect.mapError((cause) => invalid(`Návrh č. ${index + 1} nelze přijmout: ${cause.message}`, cause)),
    Effect.flatMap((description) =>
      adapter.run(state, entry.operation, subInvocation(context, `c${index}`)).pipe(
        Effect.result,
        Effect.map((dryRunResult) => ({ described: description, dryRun: dryRunResult })),
      ),
    ),
  );
  if (Result.isFailure(dryRun)) {
    return yield* invalid(
      `Návrh č. ${index + 1} (${described.summary}) nelze přijmout: ${dryRun.failure.message}`,
      dryRun.failure,
    );
  }
  if (described.diff.length === 0) {
    return yield* invalid(`Návrh č. ${index + 1} (${described.summary}) nic nemění.`);
  }
  const proposedSnapshots = yield* snapshotsBetween(adapter, state, dryRun.success.state).pipe(
    Effect.mapError((cause) =>
      invalid(`Návrh č. ${index + 1} (${described.summary}) nelze přijmout: ${cause.message}`, cause),
    ),
  );
  const touched = claimSnapshots(progress.touched, proposedSnapshots);
  if (Option.isNone(touched)) {
    return yield* invalid(
      `Návrh č. ${index + 1} (${described.summary}) mění stejný záznam jako dřívější návrh dávky. Spojte je do jedné změny.`,
    );
  }
  const change: AiChange<Operation> = {
    batchId: batch.id,
    diff: described.diff,
    id: yield* Schema.decodeEffect(AiChangeIdSchema)(`${context.invocationId}:ai-change-${index}`).pipe(
      Effect.mapError(invalidIdentity),
    ),
    operation: entry.operation,
    proposedAt: context.now,
    proposedSnapshots,
    reason: entry.reason,
    risk: adapter.risk(entry.operation),
    status: 'pending',
    summary: described.summary,
    target: described.target,
  };
  return {
    changes: [...progress.changes, change],
    log: [
      ...progress.log,
      yield* logEntry(context, progress.log.length, {
        action: 'proposed',
        actorKind: 'agent',
        batchId: batch.id,
        changeId: change.id,
        message: `${batch.agentLabel} navrhl: ${change.summary} — ${change.target.label}. Důvod: ${entry.reason}`,
      }),
    ],
    touched: touched.value,
  };
});

/** Stores one pending batch. Data does not change; each proposal is dry-run first. */
export const proposeAiChanges = Effect.fn('AiApprovals.proposeAiChanges')(function* propose<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  proposal: AiProposal<Operation>,
  context: AiContext,
): Effect.fn.Return<AiOutcome<State>, AiFailure> {
  const slice = sliceOf(adapter, state);
  const repeated =
    proposal.runId === undefined
      ? undefined
      : slice.batches.find((batch) => batch.runId === proposal.runId && batch.agentPrincipalId === context.principalId);
  if (repeated !== undefined) {
    const existing = slice.changes.filter((change) => change.batchId === repeated.id);
    if (
      repeated.instruction !== proposal.instruction ||
      !sameJson(
        existing.map((change) => ({ operation: change.operation, reason: change.reason })),
        proposal.changes,
      )
    ) {
      return yield* conflict('Toto označení běhu už patří jinému návrhu. Pro nový návrh použijte nové runId.');
    }
    return { entityIds: [repeated.id, ...existing.map((change) => change.id)], state };
  }
  const batch: AiBatch = {
    agentLabel: proposal.agentLabel,
    agentPrincipalId: context.principalId,
    createdAt: context.now,
    id: yield* Schema.decodeEffect(AiBatchIdSchema)(`${context.invocationId}:ai-batch`).pipe(
      Effect.mapError(invalidIdentity),
    ),
    instruction: proposal.instruction,
  };
  if (proposal.runId !== undefined) {
    Object.assign(batch, {
      runId: yield* Schema.decodeEffect(AiRunIdSchema)(proposal.runId).pipe(Effect.mapError(invalidIdentity)),
    });
  }
  const initial: ProposalProgress<Operation> = { changes: [], log: [], touched: new Set<string>() };
  const prepared = yield* Effect.reduce(
    proposal.changes,
    () => initial,
    (progress, entry, index) => prepareProposal(adapter, state, progress, entry, index, batch, context),
  );
  return {
    entityIds: [batch.id, ...prepared.changes.map((change) => change.id)],
    state: adapter.setSlice(state, {
      batches: [...slice.batches, batch],
      changes: [...slice.changes, ...prepared.changes],
      log: [...slice.log, ...prepared.log],
    }),
  };
});

interface DecisionStep {
  readonly context: AiContext;
  readonly decision: 'approve' | 'reject';
  readonly note: string;
  readonly noteText: string;
}
interface DecisionProgress<State> {
  readonly log: readonly AiLogEntry[];
  readonly state: State;
}

const proposalSnapshotChanged = Effect.fn('AiApprovals.proposalSnapshotChanged')(function* checkProposedSnapshot<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  change: AiChange<Operation>,
  slice: AiSlice<Operation>,
  snapshot: AiSnapshot,
  alreadyStale: boolean,
): Effect.fn.Return<boolean, AiAdapterFailure> {
  if (alreadyStale) {
    return true;
  }
  let expected = snapshot.before;
  const siblings = slice.changes
    .filter((entry) => entry.batchId === change.batchId && entry.status === 'applied')
    .toSorted((left, right) => (left.applySequence ?? 0) - (right.applySequence ?? 0));
  for (const sibling of siblings) {
    const previous = sibling.snapshots?.find((entry) => entry.id === snapshot.id && entry.kind === snapshot.kind);
    if (previous !== undefined) {
      if (!sameJson(expected, previous.before)) {
        return true;
      }
      expected = previous.after;
    }
  }
  const current = yield* currentEncoded(adapter, state, snapshot.kind, snapshot.id);
  return !sameJson(Option.getOrUndefined(current), expected);
});

const decideChange = Effect.fn('AiApprovals.decideChange')(function* decideOne<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  progress: DecisionProgress<State>,
  changeId: string,
  index: number,
  step: DecisionStep,
): Effect.fn.Return<DecisionProgress<State>, AiFailure> {
  const working = progress.state;
  const slice = sliceOf(adapter, working);
  const change = slice.changes.find((entry) => entry.id === changeId);
  if (change === undefined) {
    return yield* notFound('Návrh AI neexistuje.');
  }
  const targetLabel = change.target.label;
  if (change.status !== 'pending') {
    return yield* conflict(`Návrh „${change.summary} — ${targetLabel}“ už byl vyřízen.`);
  }
  const decided: AiChange<Operation> = { ...change, decidedAt: step.context.now, decidedBy: step.context.principalId };
  if (step.note !== '') {
    Object.assign(decided, { decisionNote: step.note });
  }
  if (step.decision === 'reject') {
    const rejectedState = adapter.setSlice(working, {
      ...slice,
      changes: replaceChange(slice.changes, { ...decided, status: 'rejected' }),
    });
    return {
      log: [
        ...progress.log,
        yield* logEntry(step.context, progress.log.length, {
          action: 'rejected',
          actorKind: 'human',
          batchId: change.batchId,
          changeId: change.id,
          message: `Zamítnuto: ${change.summary} — ${targetLabel}${step.noteText}`,
        }),
      ],
      state: rejectedState,
    };
  }
  const stale = yield* Effect.reduce(
    change.proposedSnapshots ?? [],
    (): boolean => false,
    (alreadyStale, snapshot) => proposalSnapshotChanged(adapter, working, change, slice, snapshot, alreadyStale),
  ).pipe(Effect.mapError((cause) => conflict(cause.message, cause)));
  if (stale) {
    return yield* conflict(`Záznam „${targetLabel}“ se od návrhu změnil. Obnovte data a požádejte AI o nový návrh.`);
  }
  const applied = yield* adapter
    .run(working, change.operation, subInvocation(step.context, `a${index}`))
    .pipe(Effect.result);
  if (Result.isFailure(applied)) {
    const failedState = adapter.setSlice(working, {
      ...slice,
      changes: replaceChange(slice.changes, { ...decided, failure: applied.failure.message, status: 'failed' }),
    });
    return {
      log: [
        ...progress.log,
        yield* logEntry(step.context, progress.log.length, {
          action: 'apply_failed',
          actorKind: 'human',
          batchId: change.batchId,
          changeId: change.id,
          message: `Schválení nešlo provést: ${change.summary} — ${targetLabel}: ${applied.failure.message}`,
        }),
      ],
      state: failedState,
    };
  }
  const appliedState = applied.success.state;
  const snapshots = yield* snapshotsBetween(adapter, working, appliedState).pipe(
    Effect.mapError((cause) => conflict(cause.message, cause)),
  );
  const after = sliceOf(adapter, appliedState);
  const createdId = adapter.creates(change.operation) ? applied.success.entityIds[0] : undefined;
  const appliedChange: AiChange<Operation> = { ...decided };
  if (createdId !== undefined) {
    Object.assign(appliedChange, { target: { ...change.target, id: createdId } });
  }
  Object.assign(appliedChange, {
    appliedAt: step.context.now,
    applySequence:
      after.changes.filter((entry) => entry.status === 'applied' || entry.status === 'reverted').length + 1,
    snapshots,
    status: 'applied',
  });
  const approvedState = adapter.setSlice(appliedState, {
    ...after,
    changes: replaceChange(after.changes, appliedChange),
  });
  return {
    log: [
      ...progress.log,
      yield* logEntry(step.context, progress.log.length, {
        action: 'approved',
        actorKind: 'human',
        batchId: change.batchId,
        changeId: change.id,
        message: `Schváleno a provedeno: ${change.summary} — ${targetLabel}${step.noteText}`,
      }),
    ],
    state: approvedState,
  };
});

/** Approves (applies through the module reducer) or rejects pending changes. The caller checks human + write. */
export const decideAiChanges = Effect.fn('AiApprovals.decideAiChanges')(function* decide<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  input: {
    readonly changeIds: readonly string[];
    readonly decision: 'approve' | 'reject';
    readonly note?: string | undefined;
  },
  context: AiContext,
): Effect.fn.Return<AiOutcome<State>, AiFailure> {
  const note = input.note?.trim() ?? '';
  const step: DecisionStep = {
    context,
    decision: input.decision,
    note,
    noteText: note === '' ? '' : `. Poznámka: ${note}`,
  };
  const initial: DecisionProgress<State> = { log: [], state };
  const decided = yield* Effect.reduce(
    input.changeIds,
    () => initial,
    (progress, changeId, index) => decideChange(adapter, progress, changeId, index, step),
  );
  const slice = sliceOf(adapter, decided.state);
  return {
    entityIds: [...input.changeIds],
    state: adapter.setSlice(decided.state, { ...slice, log: [...slice.log, ...decided.log] }),
  };
});

interface RevertProgress<State, Operation> extends DecisionProgress<State> {
  readonly changes: readonly AiChange<Operation>[];
}
interface RevertStep {
  readonly batchId: AiBatch['id'];
  readonly context: AiContext;
  readonly note: string;
}

const appliedSnapshotChanged = Effect.fn('AiApprovals.appliedSnapshotChanged')(function* checkAppliedSnapshot<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  snapshot: AiSnapshot,
  alreadyChanged: boolean,
): Effect.fn.Return<boolean, AiAdapterFailure> {
  if (alreadyChanged) {
    return true;
  }
  const current = yield* currentEncoded(adapter, state, snapshot.kind, snapshot.id);
  return !sameJson(Option.getOrUndefined(current), snapshot.after);
});

const restoreSnapshot = Effect.fn('AiApprovals.restoreSnapshot')(function* restoreOneSnapshot<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  snapshot: AiSnapshot,
  position: number,
  change: AiChange<Operation>,
  index: number,
  step: RevertStep,
): Effect.fn.Return<State, AiFailure> {
  return yield* adapter
    .restore(state, snapshot, { ...step.context, suffix: `r${index}-${position}` }, step.note)
    .pipe(Effect.mapError((cause) => conflict(`${change.summary} (${change.target.label}): ${cause.message}`, cause)));
});

const revertChange = Effect.fn('AiApprovals.revertChange')(function* revertOne<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  progress: RevertProgress<State, Operation>,
  change: AiChange<Operation>,
  index: number,
  step: RevertStep,
): Effect.fn.Return<RevertProgress<State, Operation>, AiFailure> {
  const snapshots = change.snapshots ?? [];
  const targetLabel = change.target.label;
  const changedSince = yield* Effect.reduce(
    snapshots,
    (): boolean => false,
    (alreadyChanged, snapshot) => appliedSnapshotChanged(adapter, progress.state, snapshot, alreadyChanged),
  ).pipe(Effect.mapError((cause) => conflict(cause.message, cause)));
  if (changedSince) {
    return yield* conflict(
      `${change.summary} (${targetLabel}): záznam se od schválení změnil, automaticky ho nevracím. Pozdější úpravy zůstaly zachovány.`,
    );
  }
  const restored = yield* Effect.reduce(
    snapshots.toReversed(),
    () => progress.state,
    (working, snapshot, position) => restoreSnapshot(adapter, working, snapshot, position, change, index, step),
  );
  return {
    changes: replaceChange(progress.changes, {
      ...change,
      revertedAt: step.context.now,
      revertedBy: step.context.principalId,
      status: 'reverted',
    }),
    log: [
      ...progress.log,
      yield* logEntry(step.context, progress.log.length, {
        action: 'reverted',
        actorKind: 'human',
        batchId: step.batchId,
        changeId: change.id,
        message: `${change.summary} (${targetLabel}) vráceno do stavu před změnou.`,
      }),
    ],
    state: restored,
  };
});

interface PendingProgress<Operation> {
  readonly changes: readonly AiChange<Operation>[];
  readonly log: readonly AiLogEntry[];
}
const rejectPendingChange = Effect.fn('AiApprovals.rejectPendingChange')(function* rejectOnePending<Operation>(
  progress: PendingProgress<Operation>,
  change: AiChange<Operation>,
  step: RevertStep,
): Effect.fn.Return<PendingProgress<Operation>, AiFailure> {
  const changes = replaceChange(progress.changes, {
    ...change,
    decidedAt: step.context.now,
    decidedBy: step.context.principalId,
    decisionNote: 'Zamítnuto při vrácení celé dávky',
    status: 'rejected',
  });
  const entry = yield* logEntry(step.context, progress.log.length, {
    action: 'rejected',
    actorKind: 'human',
    batchId: step.batchId,
    changeId: change.id,
    message: `Zamítnuto při vrácení dávky: ${change.summary} — ${change.target.label}`,
  });
  return { changes, log: [...progress.log, entry] };
});
const rejectPendingForBatch = Effect.fn('AiApprovals.rejectPendingForBatch')(function* rejectPending<Operation>(
  progress: PendingProgress<Operation>,
  original: readonly AiChange<Operation>[],
  step: RevertStep,
): Effect.fn.Return<PendingProgress<Operation>, AiFailure> {
  const pending = original.filter((entry) => entry.batchId === step.batchId && entry.status === 'pending');
  return yield* Effect.reduce(
    pending,
    () => progress,
    (current, change) => rejectPendingChange(current, change, step),
  );
});

/** Restores every applied change of one batch (newest first). Refuses the whole revert when anything changed since. */
export const revertAiBatch = Effect.fn('AiApprovals.revertAiBatch')(function* revertBatch<
  State,
  Operation extends { readonly _tag: string },
>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  input: { readonly batchId: string; readonly note?: string | undefined },
  context: AiContext,
): Effect.fn.Return<AiOutcome<State>, AiFailure> {
  const slice = sliceOf(adapter, state);
  const batch = slice.batches.find((entry) => entry.id === input.batchId);
  if (batch === undefined) {
    return yield* notFound('Dávka AI změn neexistuje.');
  }
  if (batch.revertedAt !== undefined) {
    return yield* conflict('Dávka už byla vrácena.');
  }
  const note =
    input.note !== undefined && input.note.trim().length >= 3
      ? input.note.trim()
      : `Vráceno: dávka AI „${batch.instruction.slice(0, 120)}“`;
  const step: RevertStep = { batchId: batch.id, context, note };
  const applied = slice.changes
    .filter((change) => change.batchId === batch.id && change.status === 'applied')
    .toSorted((left, right) => (right.applySequence ?? 0) - (left.applySequence ?? 0));
  const initial: RevertProgress<State, Operation> = { changes: slice.changes, log: [], state };
  const reverted = yield* Effect.reduce(
    applied,
    () => initial,
    (progress, change, index) => revertChange(adapter, progress, change, index, step),
  );
  const pending = yield* rejectPendingForBatch(reverted, slice.changes, step);
  const log = [
    ...pending.log,
    yield* logEntry(context, pending.log.length, {
      action: 'batch_reverted',
      actorKind: 'human',
      batchId: batch.id,
      message: `Vrátit vše: ${revertedCount(applied.length)} do původního stavu.`,
    }),
  ];
  const current = sliceOf(adapter, reverted.state);
  return {
    entityIds: [batch.id],
    state: adapter.setSlice(reverted.state, {
      batches: current.batches.map((entry) =>
        entry.id === batch.id
          ? { ...entry, revertedAt: context.now, revertedBy: context.principalId, revertNote: note }
          : entry,
      ),
      changes: pending.changes,
      log: [...current.log, ...log],
    }),
  };
});

/** Only people decide and revert; an API key may only propose. */
export const aiHumanOnlyCommands: ReadonlySet<string> = new Set(['AiDecideChanges', 'AiRevertBatch']);
export const aiCommandTags: ReadonlySet<string> = new Set(['AiProposeChanges', 'AiDecideChanges', 'AiRevertBatch']);
