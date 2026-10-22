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
import { Effect, Schema } from 'effect';

const ShortText = Schema.String.check(Schema.isMaxLength(300));
const LongText = Schema.String.check(Schema.isMaxLength(4000));

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

export const AiBatchSchema = Schema.Struct({
  agentLabel: ShortText,
  agentPrincipalId: ShortText,
  createdAt: ShortText,
  id: ShortText,
  /** What the agent was asked to do. */
  instruction: LongText,
  revertedAt: Schema.optionalKey(ShortText),
  revertedBy: Schema.optionalKey(ShortText),
  revertNote: Schema.optionalKey(LongText),
  /** Agent-side run id; a repeated run id returns the existing batch (no duplicates). */
  runId: Schema.optionalKey(ShortText),
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
  actorPrincipalId: ShortText,
  at: ShortText,
  batchId: ShortText,
  changeId: Schema.optionalKey(ShortText),
  id: ShortText,
  /** Core action invocation of the step (link to the Core audit record). */
  invocationId: Schema.optionalKey(ShortText),
  message: LongText,
});
export type AiLogEntry = typeof AiLogEntrySchema.Type;

/** Change and slice schemas for one module's operation union. */
export const makeAiApprovalSchemas = <Operation extends Schema.Top>(operation: Operation) => {
  const change = Schema.Struct({
    appliedAt: Schema.optionalKey(ShortText),
    applySequence: Schema.optionalKey(Schema.Int),
    batchId: ShortText,
    decidedAt: Schema.optionalKey(ShortText),
    decidedBy: Schema.optionalKey(ShortText),
    decisionNote: Schema.optionalKey(LongText),
    diff: Schema.Array(AiDiffLineSchema),
    failure: Schema.optionalKey(LongText),
    id: ShortText,
    operation,
    proposedAt: ShortText,
    /** Entity snapshots of the dry run; approval refuses stale proposals. */
    proposedSnapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
    /** The agent's justification. */
    reason: LongText,
    revertedAt: Schema.optionalKey(ShortText),
    revertedBy: Schema.optionalKey(ShortText),
    risk: AiRiskSchema,
    snapshots: Schema.optionalKey(Schema.Array(AiSnapshotSchema)),
    status: AiChangeStatusSchema,
    summary: ShortText,
    target: AiTargetSchema,
  });
  const slice = Schema.Struct({
    batches: Schema.Array(AiBatchSchema),
    changes: Schema.Array(change),
    log: Schema.Array(AiLogEntrySchema),
  });
  return { change, slice };
};

export interface AiChange<Operation> {
  readonly appliedAt?: string;
  readonly applySequence?: number;
  readonly batchId: string;
  readonly decidedAt?: string;
  readonly decidedBy?: string;
  readonly decisionNote?: string;
  readonly diff: readonly AiDiffLine[];
  readonly failure?: string;
  readonly id: string;
  readonly operation: Operation;
  readonly proposedAt: string;
  readonly proposedSnapshots?: readonly AiSnapshot[];
  readonly reason: string;
  readonly revertedAt?: string;
  readonly revertedBy?: string;
  readonly risk: AiRisk;
  readonly snapshots?: readonly AiSnapshot[];
  readonly status: AiChangeStatus;
  readonly summary: string;
  readonly target: AiTarget;
}

export interface AiSlice<Operation> {
  readonly batches: readonly AiBatch[];
  readonly changes: readonly AiChange<Operation>[];
  readonly log: readonly AiLogEntry[];
}

export const emptyAiSlice = <Operation>(): AiSlice<Operation> => ({ batches: [], changes: [], log: [] });

export const aiRiskLabel: Readonly<Record<AiRisk, string>> = {
  high: 'Vysoké riziko',
  low: 'Nízké riziko',
  medium: 'Střední riziko',
};

export const aiStatusLabel: Readonly<Record<AiChangeStatus, string>> = {
  applied: 'Provedeno',
  failed: 'Nelze provést',
  pending: 'Čeká na schválení',
  rejected: 'Zamítnuto',
  reverted: 'Vráceno',
};

export const aiLogActionLabel: Readonly<Record<AiLogAction, string>> = {
  apply_failed: 'Neprovedeno',
  approved: 'Schváleno a provedeno',
  batch_reverted: 'Dávka vrácena',
  proposed: 'Uloženo ke schválení',
  rejected: 'Zamítnuto',
  revert_conflict: 'Vrácení zablokováno',
  reverted: 'Vráceno',
};

// ------------------------------------------------------------------------------------------------ engine

export interface AiContext {
  /** Core action invocation id of the current command. */
  readonly invocationId: string;
  /** ISO timestamp of the current command. */
  readonly now: string;
  readonly principalId: string;
}

export interface AiFailure {
  readonly kind: 'conflict' | 'invalid' | 'not_found';
  readonly message: string;
}

export interface AiDescribed {
  readonly diff: readonly AiDiffLine[];
  readonly summary: string;
  readonly target: AiTarget;
}

export interface AiEntity {
  readonly id: string;
}

/** How one module plugs into the engine. Every function is pure. */
export interface AiApprovalAdapter<State, Operation extends { readonly _tag: string }> {
  /** Entity collections a change may create or modify (snapshot kinds). */
  readonly kinds: readonly string[];
  readonly entities: (state: State, kind: string) => readonly AiEntity[];
  /** Wire (JSON) form of one entity of `kind`. */
  readonly encode: (kind: string, entity: AiEntity) => Schema.Json;
  /** Runs one operation through the module's own reducer; every module rule applies. Failure = readable reason. */
  readonly run: (
    state: State,
    operation: Operation,
    invocationId: string,
  ) => Effect.Effect<{ readonly entityIds: readonly string[]; readonly state: State }, string>;
  readonly describe: (state: State, operation: Operation) => AiDescribed;
  readonly risk: (operation: Operation) => AiRisk;
  /** True when the operation creates the entity its target points at (target id = first entity id). */
  readonly creates: (operation: Operation) => boolean;
  /** Undo one snapshot of an applied change; the engine already verified the entity is unchanged since. */
  readonly restore: (
    state: State,
    snapshot: AiSnapshot,
    context: AiContext & { readonly suffix: string },
    note: string,
  ) => Effect.Effect<State, string>;
  readonly getSlice: (state: State) => AiSlice<Operation> | undefined;
  readonly setSlice: (state: State, slice: AiSlice<Operation>) => State;
}

/** JSONB reorders object keys on persistence; snapshots compare values, not insertion order. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
};
export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

/** Deterministic RFC 4122-shaped id from a seed (pure; same seed, same id). */
export const deriveAiUuid = (seed: string): string => {
  let h1 = 0x6a09e667;
  let h2 = 0xbb67ae85;
  let h3 = 0x3c6ef372;
  let h4 = 0xa54ff53a;
  for (let index = 0; index < seed.length; index += 1) {
    const code = seed.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const hex = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1]
    .map((part) => (part >>> 0).toString(16).padStart(8, '0'))
    .join('');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const invalid = (message: string): AiFailure => ({ kind: 'invalid', message });
const conflict = (message: string): AiFailure => ({ kind: 'conflict', message });
const notFound = (message: string): AiFailure => ({ kind: 'not_found', message });

/** Every entity the change created or modified, with its exact previous and next encoded value. */
const snapshotsBetween = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  previous: State,
  next: State,
): readonly AiSnapshot[] =>
  adapter.kinds.flatMap((kind) => {
    const before = new Map(adapter.entities(previous, kind).map((entity) => [entity.id, entity] as const));
    return adapter.entities(next, kind).flatMap((entity): AiSnapshot[] => {
      const old = before.get(entity.id);
      // Reducers keep untouched entities by reference, so most entities skip the encode entirely.
      if (old === entity) return [];
      const after = adapter.encode(kind, entity);
      if (old === undefined) return [{ after, id: entity.id, kind }];
      const encodedBefore = adapter.encode(kind, old);
      return sameJson(encodedBefore, after) ? [] : [{ after, before: encodedBefore, id: entity.id, kind }];
    });
  });

const currentEncoded = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  kind: string,
  id: string,
): unknown => {
  const entity = adapter.entities(state, kind).find((entry) => entry.id === id);
  return entity === undefined ? undefined : adapter.encode(kind, entity);
};

const sliceOf = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
): AiSlice<Operation> => adapter.getSlice(state) ?? emptyAiSlice<Operation>();

const replaceChange = <Operation>(changes: readonly AiChange<Operation>[], next: AiChange<Operation>) =>
  changes.map((entry) => (entry.id === next.id ? next : entry));

const logEntry = (
  context: AiContext,
  index: number,
  entry: Omit<AiLogEntry, 'actorPrincipalId' | 'at' | 'id' | 'invocationId'>,
): AiLogEntry => ({
  ...entry,
  actorPrincipalId: context.principalId,
  at: context.now,
  id: `${context.invocationId}:ai-log-${index}`,
  invocationId: context.invocationId,
});

/** Czech plural: 1 změna vrácena, 2–4 změny vráceny, 0/5+ změn vráceno. */
const revertedCount = (count: number) =>
  count === 1
    ? '1 provedená změna vrácena'
    : count >= 2 && count <= 4
      ? `${count} provedené změny vráceny`
      : `${count} provedených změn vráceno`;

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

/** Stores one pending batch. Data does not change; each proposal is dry-run first. */
export const proposeAiChanges = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  proposal: AiProposal<Operation>,
  context: AiContext,
): Effect.Effect<AiOutcome<State>, AiFailure> =>
  Effect.gen(function* propose() {
    const slice = sliceOf(adapter, state);
    const repeated =
      proposal.runId === undefined
        ? undefined
        : slice.batches.find(
            (batch) => batch.runId === proposal.runId && batch.agentPrincipalId === context.principalId,
          );
    if (repeated !== undefined) {
      const existing = slice.changes.filter((change) => change.batchId === repeated.id);
      if (
        repeated.instruction !== proposal.instruction ||
        !sameJson(
          existing.map((change) => ({ operation: change.operation, reason: change.reason })),
          proposal.changes,
        )
      ) {
        return yield* Effect.fail(
          conflict('Toto označení běhu už patří jinému návrhu. Pro nový návrh použijte nové runId.'),
        );
      }
      return { entityIds: [repeated.id, ...existing.map((change) => change.id)], state };
    }
    const batchId = `${context.invocationId}:ai-batch`;
    const batch: AiBatch = {
      agentLabel: proposal.agentLabel,
      agentPrincipalId: context.principalId,
      createdAt: context.now,
      id: batchId,
      instruction: proposal.instruction,
      ...(proposal.runId === undefined ? {} : { runId: proposal.runId }),
    };
    const touched = new Set<string>();
    const changes: AiChange<Operation>[] = [];
    const log: AiLogEntry[] = [];
    for (const [index, entry] of proposal.changes.entries()) {
      const described = adapter.describe(state, entry.operation);
      const dryRun = yield* adapter
        .run(state, entry.operation, subInvocation(context, `c${index}`))
        .pipe(Effect.result);
      if (dryRun._tag === 'Failure') {
        return yield* Effect.fail(
          invalid(`Návrh č. ${index + 1} (${described.summary}) nelze přijmout: ${dryRun.failure}`),
        );
      }
      if (described.diff.length === 0) {
        return yield* Effect.fail(invalid(`Návrh č. ${index + 1} (${described.summary}) nic nemění.`));
      }
      const proposedSnapshots = snapshotsBetween(adapter, state, dryRun.success.state);
      for (const snapshot of proposedSnapshots) {
        const key = `${snapshot.kind}:${snapshot.id}`;
        if (snapshot.before !== undefined && touched.has(key)) {
          return yield* Effect.fail(
            invalid(
              `Návrh č. ${index + 1} (${described.summary}) mění stejný záznam jako dřívější návrh dávky. Spojte je do jedné změny.`,
            ),
          );
        }
        touched.add(key);
      }
      const change: AiChange<Operation> = {
        batchId,
        diff: described.diff,
        id: `${context.invocationId}:ai-change-${index}`,
        operation: entry.operation,
        proposedAt: context.now,
        proposedSnapshots,
        reason: entry.reason,
        risk: adapter.risk(entry.operation),
        status: 'pending',
        summary: described.summary,
        target: described.target,
      };
      log.push(
        logEntry(context, log.length, {
          action: 'proposed',
          actorKind: 'agent',
          batchId,
          changeId: change.id,
          message: `${batch.agentLabel} navrhl: ${change.summary} — ${change.target.label}. Důvod: ${entry.reason}`,
        }),
      );
      changes.push(change);
    }
    return {
      entityIds: [batchId, ...changes.map((change) => change.id)],
      state: adapter.setSlice(state, {
        batches: [...slice.batches, batch],
        changes: [...slice.changes, ...changes],
        log: [...slice.log, ...log],
      }),
    };
  });

/** Approves (applies through the module reducer) or rejects pending changes. The caller checks human + write. */
export const decideAiChanges = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  input: {
    readonly changeIds: readonly string[];
    readonly decision: 'approve' | 'reject';
    readonly note?: string | undefined;
  },
  context: AiContext,
): Effect.Effect<AiOutcome<State>, AiFailure> =>
  Effect.gen(function* decide() {
    let working = state;
    const log: AiLogEntry[] = [];
    const note = input.note?.trim() ?? '';
    const noteText = note === '' ? '' : `. Poznámka: ${note}`;
    for (const [index, changeId] of input.changeIds.entries()) {
      const slice = sliceOf(adapter, working);
      const change = slice.changes.find((entry) => entry.id === changeId);
      if (change === undefined) {
        return yield* Effect.fail(notFound('Návrh AI neexistuje.'));
      }
      if (change.status !== 'pending') {
        return yield* Effect.fail(conflict(`Návrh „${change.summary} — ${change.target.label}“ už byl vyřízen.`));
      }
      const decided: AiChange<Operation> = {
        ...change,
        decidedAt: context.now,
        decidedBy: context.principalId,
        ...(note === '' ? {} : { decisionNote: note }),
      };
      if (input.decision === 'reject') {
        working = adapter.setSlice(working, {
          ...slice,
          changes: replaceChange(slice.changes, { ...decided, status: 'rejected' }),
        });
        log.push(
          logEntry(context, log.length, {
            action: 'rejected',
            actorKind: 'human',
            batchId: change.batchId,
            changeId,
            message: `Zamítnuto: ${change.summary} — ${change.target.label}${noteText}`,
          }),
        );
        continue;
      }
      const stale = (change.proposedSnapshots ?? []).some((snapshot) => {
        // Proposals are dry runs against the same original state. An approved sibling of this batch may already
        // have changed the entity; follow only that batch's applied snapshot chain, never foreign edits.
        let expected = snapshot.before;
        const siblings = slice.changes
          .filter((entry) => entry.batchId === change.batchId && entry.status === 'applied')
          .toSorted((left, right) => (left.applySequence ?? 0) - (right.applySequence ?? 0));
        for (const sibling of siblings) {
          const previous = sibling.snapshots?.find((entry) => entry.id === snapshot.id && entry.kind === snapshot.kind);
          if (previous !== undefined) {
            if (!sameJson(expected, previous.before)) return true;
            expected = previous.after;
          }
        }
        return !sameJson(currentEncoded(adapter, working, snapshot.kind, snapshot.id), expected);
      });
      if (stale) {
        return yield* Effect.fail(
          conflict(`Záznam „${change.target.label}“ se od návrhu změnil. Obnovte data a požádejte AI o nový návrh.`),
        );
      }
      const applied = yield* adapter
        .run(working, change.operation, subInvocation(context, `a${index}`))
        .pipe(Effect.result);
      if (applied._tag === 'Failure') {
        working = adapter.setSlice(working, {
          ...slice,
          changes: replaceChange(slice.changes, { ...decided, failure: applied.failure, status: 'failed' }),
        });
        log.push(
          logEntry(context, log.length, {
            action: 'apply_failed',
            actorKind: 'human',
            batchId: change.batchId,
            changeId,
            message: `Schválení nešlo provést: ${change.summary} — ${change.target.label}: ${applied.failure}`,
          }),
        );
        continue;
      }
      const snapshots = snapshotsBetween(adapter, working, applied.success.state);
      const after = sliceOf(adapter, applied.success.state);
      const createdId = adapter.creates(change.operation) ? applied.success.entityIds[0] : undefined;
      working = adapter.setSlice(applied.success.state, {
        ...after,
        changes: replaceChange(after.changes, {
          ...decided,
          ...(createdId === undefined ? {} : { target: { ...change.target, id: createdId } }),
          appliedAt: context.now,
          applySequence:
            after.changes.filter((entry) => entry.status === 'applied' || entry.status === 'reverted').length + 1,
          snapshots,
          status: 'applied',
        }),
      });
      log.push(
        logEntry(context, log.length, {
          action: 'approved',
          actorKind: 'human',
          batchId: change.batchId,
          changeId,
          message: `Schváleno a provedeno: ${change.summary} — ${change.target.label}${noteText}`,
        }),
      );
    }
    const slice = sliceOf(adapter, working);
    return {
      entityIds: [...input.changeIds],
      state: adapter.setSlice(working, { ...slice, log: [...slice.log, ...log] }),
    };
  });

/** Restores every applied change of one batch (newest first). Refuses the whole revert when anything changed since. */
export const revertAiBatch = <State, Operation extends { readonly _tag: string }>(
  adapter: AiApprovalAdapter<State, Operation>,
  state: State,
  input: { readonly batchId: string; readonly note?: string | undefined },
  context: AiContext,
): Effect.Effect<AiOutcome<State>, AiFailure> =>
  Effect.gen(function* revertBatch() {
    const slice = sliceOf(adapter, state);
    const batch = slice.batches.find((entry) => entry.id === input.batchId);
    if (batch === undefined) {
      return yield* Effect.fail(notFound('Dávka AI změn neexistuje.'));
    }
    if (batch.revertedAt !== undefined) {
      return yield* Effect.fail(conflict('Dávka už byla vrácena.'));
    }
    const note =
      input.note !== undefined && input.note.trim().length >= 3
        ? input.note.trim()
        : `Vráceno: dávka AI „${batch.instruction.slice(0, 120)}“`;
    let working = state;
    let changes = slice.changes;
    const log: AiLogEntry[] = [];
    const applied = slice.changes
      .filter((change) => change.batchId === batch.id && change.status === 'applied')
      .toSorted((left, right) => (right.applySequence ?? 0) - (left.applySequence ?? 0));
    for (const [index, change] of applied.entries()) {
      const snapshots = change.snapshots ?? [];
      const changedSince = snapshots.some(
        (snapshot) => !sameJson(currentEncoded(adapter, working, snapshot.kind, snapshot.id), snapshot.after),
      );
      if (changedSince) {
        return yield* Effect.fail(
          conflict(
            `${change.summary} (${change.target.label}): záznam se od schválení změnil, automaticky ho nevracím. Pozdější úpravy zůstaly zachovány.`,
          ),
        );
      }
      for (const [position, snapshot] of snapshots.toReversed().entries()) {
        const restored = yield* adapter
          .restore(working, snapshot, { ...context, suffix: `r${index}-${position}` }, note)
          .pipe(Effect.result);
        if (restored._tag === 'Failure') {
          return yield* Effect.fail(conflict(`${change.summary} (${change.target.label}): ${restored.failure}`));
        }
        working = restored.success;
      }
      changes = replaceChange(changes, {
        ...change,
        revertedAt: context.now,
        revertedBy: context.principalId,
        status: 'reverted',
      });
      log.push(
        logEntry(context, log.length, {
          action: 'reverted',
          actorKind: 'human',
          batchId: batch.id,
          changeId: change.id,
          message: `${change.summary} (${change.target.label}) vráceno do stavu před změnou.`,
        }),
      );
    }
    for (const change of slice.changes.filter((entry) => entry.batchId === batch.id && entry.status === 'pending')) {
      changes = replaceChange(changes, {
        ...change,
        decidedAt: context.now,
        decidedBy: context.principalId,
        decisionNote: 'Zamítnuto při vrácení celé dávky',
        status: 'rejected',
      });
      log.push(
        logEntry(context, log.length, {
          action: 'rejected',
          actorKind: 'human',
          batchId: batch.id,
          changeId: change.id,
          message: `Zamítnuto při vrácení dávky: ${change.summary} — ${change.target.label}`,
        }),
      );
    }
    log.push(
      logEntry(context, log.length, {
        action: 'batch_reverted',
        actorKind: 'human',
        batchId: batch.id,
        message: `Vrátit vše: ${revertedCount(applied.length)} do původního stavu.`,
      }),
    );
    const current = sliceOf(adapter, working);
    return {
      entityIds: [batch.id],
      state: adapter.setSlice(working, {
        batches: current.batches.map((entry) =>
          entry.id === batch.id
            ? { ...entry, revertNote: note, revertedAt: context.now, revertedBy: context.principalId }
            : entry,
        ),
        changes,
        log: [...current.log, ...log],
      }),
    };
  });

/** Only people decide and revert; an API key may only propose. */
export const aiHumanOnlyCommands: ReadonlySet<string> = new Set(['AiDecideChanges', 'AiRevertBatch']);
export const aiCommandTags: ReadonlySet<string> = new Set(['AiProposeChanges', 'AiDecideChanges', 'AiRevertBatch']);
