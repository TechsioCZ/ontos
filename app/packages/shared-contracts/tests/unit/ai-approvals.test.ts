import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AiAdapterFailure,
  AiBatchSchema,
  AiContextSchema,
  makeAiApprovalSchemas,
  AiFailure,
  decideAiChanges,
  deriveAiUuid,
  proposeAiChanges,
  revertAiBatch,
  sameJson,
} from '../../src/ai-approvals.ts';
import type { AiApprovalAdapter, AiContext, AiProposal, AiSlice } from '../../src/ai-approvals.ts';

/** A real asynchronous boundary with no timing assertion or external I/O. */
const nextMicrotask = Effect.promise(() => Promise.resolve());

const EntitySchema = Schema.Struct({ id: Schema.String, value: Schema.Finite });
type Entity = typeof EntitySchema.Type;
const OperationSchema = Schema.TaggedStruct('SetValue', { id: Schema.String, value: Schema.Finite });
type Operation = typeof OperationSchema.Type;
interface State {
  readonly aiChanges?: AiSlice<Operation>;
  readonly values: readonly Entity[];
}
const start: State = {
  values: [
    { id: 'one', value: 1 },
    { id: 'two', value: 10 },
  ],
};
const context = (invocationId: string): AiContext =>
  Schema.decodeSync(AiContextSchema)({
    invocationId,
    now: DateTime.makeUnsafe('2026-10-21T08:00:00.000Z'),
    principalId: 'person',
  });
const proposal = {
  agentLabel: 'Agent',
  changes: [
    { operation: { _tag: 'SetValue', id: 'one', value: 2 }, reason: 'První změna' },
    { operation: { _tag: 'SetValue', id: 'two', value: 20 }, reason: 'Druhá změna' },
  ],
  instruction: 'Změnit oba záznamy',
} satisfies AiProposal<Operation>;

const adapterFor = (events: string[]): AiApprovalAdapter<State, Operation> => ({
  creates: () => false,
  describe: Effect.fn('TestAi.describe')(function* describeTestValue(state, operation) {
    yield* nextMicrotask;
    events.push(`describe:${operation.id}`);
    return {
      diff: [
        {
          after: String(operation.value),
          before: String(state.values.find((entry) => entry.id === operation.id)?.value),
          field: 'value',
          label: 'Hodnota',
        },
      ],
      summary: 'Změna hodnoty',
      target: { id: operation.id, kind: 'value', label: operation.id },
    };
  }),
  encode: (_kind, entity) =>
    Schema.encodeUnknownEffect(EntitySchema)(entity).pipe(
      Effect.tap(() => nextMicrotask),
      Effect.tap((encoded) =>
        Effect.sync(() => {
          events.push(`encode:${encoded.id}:${encoded.value}`);
        }),
      ),
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Záznam nelze zapsat.' })),
    ),
  entities: (state) => state.values,
  getSlice: (state) => state.aiChanges,
  kinds: ['value'],
  restore: Effect.fn('TestAi.restore')(function* restoreTestValue(state, snapshot) {
    events.push(`restore:${snapshot.id}`);
    if (snapshot.before === undefined) {
      return state;
    }
    const before = yield* Schema.decodeUnknownEffect(EntitySchema)(snapshot.before).pipe(
      Effect.mapError((cause) => new AiAdapterFailure({ cause, message: 'Záznam nelze obnovit.' })),
    );
    return { ...state, values: state.values.map((entry) => (entry.id === before.id ? before : entry)) };
  }),
  risk: () => 'low',
  run: (state, operation) =>
    Effect.sync(() => {
      events.push(`run:${operation.id}`);
      return {
        entityIds: [operation.id],
        state: {
          ...state,
          values: state.values.map((entry) =>
            entry.id === operation.id ? { ...entry, value: operation.value } : entry,
          ),
        },
      };
    }),
  setSlice: (state, slice) => ({ ...state, aiChanges: slice }),
});

it.live(
  'awaits async description and encoding in entity order through proposal, approval and reverse-order revert',
  () =>
    Effect.gen(function* asyncLifecycle() {
      const events: string[] = [];
      const adapter = adapterFor(events);
      const proposed = yield* proposeAiChanges(adapter, start, proposal, context('propose'));
      expect(proposed.state.values).toBe(start.values);
      expect(events).toEqual([
        'describe:one',
        'run:one',
        'encode:one:2',
        'encode:one:1',
        'describe:two',
        'run:two',
        'encode:two:20',
        'encode:two:10',
      ]);
      expect(proposed.state.aiChanges?.changes.map((change) => change.proposedSnapshots)).toEqual([
        [{ after: { id: 'one', value: 2 }, before: { id: 'one', value: 1 }, id: 'one', kind: 'value' }],
        [{ after: { id: 'two', value: 20 }, before: { id: 'two', value: 10 }, id: 'two', kind: 'value' }],
      ]);
      events.length = 0;
      const approved = yield* decideAiChanges(
        adapter,
        proposed.state,
        {
          changeIds: proposed.entityIds.slice(1),
          decision: 'approve',
        },
        context('approve'),
      );
      expect(approved.state.values.map((entry) => entry.value)).toEqual([2, 20]);
      expect(events).toEqual([
        'encode:one:1',
        'run:one',
        'encode:one:2',
        'encode:one:1',
        'encode:two:10',
        'run:two',
        'encode:two:20',
        'encode:two:10',
      ]);
      events.length = 0;
      const reverted = yield* revertAiBatch(
        adapter,
        approved.state,
        {
          batchId: yield* Schema.decodeUnknownEffect(Schema.String)(proposed.entityIds[0]),
        },
        context('revert'),
      );
      expect(events).toEqual(['encode:two:20', 'restore:two', 'encode:one:2', 'restore:one']);
      expect(reverted.state.values).toEqual(start.values);
      expect(reverted.state.aiChanges?.changes.map((change) => change.status)).toEqual(['reverted', 'reverted']);
    }),
);

it.effect('keeps a description failure typed with its original schema cause and leaves input untouched', () =>
  Effect.gen(function* failedDescription() {
    const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'one', value: 'invalid' }).pipe(Effect.flip);
    const adapterFailure = new AiAdapterFailure({ cause, message: 'Popis nelze vytvořit.' });
    const events: string[] = [];
    const adapter: AiApprovalAdapter<State, Operation> = {
      ...adapterFor(events),
      describe: () => Effect.fail(adapterFailure),
    };
    const failure = yield* proposeAiChanges(adapter, start, proposal, context('description-failure')).pipe(Effect.flip);
    expect(Schema.is(AiFailure)(failure)).toBe(true);
    expect(failure.kind).toBe('invalid');
    expect(failure.message).toBe('Návrh č. 1 nelze přijmout: Popis nelze vytvořit.');
    expect(failure.cause).toBe(adapterFailure);
    expect(failure.cause?.cause).toBe(cause);
    expect(events).toEqual([]);
    expect(start.aiChanges).toBeUndefined();
    expect(start.values).toEqual([
      { id: 'one', value: 1 },
      { id: 'two', value: 10 },
    ]);
  }),
);

it.live('an encoding failure after an earlier approval returns no partial state and preserves the schema cause', () =>
  Effect.gen(function* failedApprovalEncoding() {
    const events: string[] = [];
    const adapter = adapterFor(events);
    const proposed = yield* proposeAiChanges(adapter, start, proposal, context('proposal-for-encoding-failure'));
    const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'two', value: null }).pipe(Effect.flip);
    const adapterFailure = new AiAdapterFailure({ cause, message: 'Záznam nelze zapsat.' });
    const failing: AiApprovalAdapter<State, Operation> = {
      ...adapter,
      encode: (kind, entity) => (entity.id === 'two' ? Effect.fail(adapterFailure) : adapter.encode(kind, entity)),
    };
    events.length = 0;
    const failure = yield* decideAiChanges(
      failing,
      proposed.state,
      {
        changeIds: proposed.entityIds.slice(1),
        decision: 'approve',
      },
      context('encoding-failure'),
    ).pipe(Effect.flip);
    expect(failure.kind).toBe('conflict');
    expect(failure.cause).toBe(adapterFailure);
    expect(failure.cause?.cause).toBe(cause);
    expect(events).toEqual(['encode:one:1', 'run:one', 'encode:one:2', 'encode:one:1']);
    expect(proposed.state.values).toBe(start.values);
    expect(proposed.state.aiChanges?.changes.map((change) => change.status)).toEqual(['pending', 'pending']);
    expect(proposed.state.aiChanges?.log.map((entry) => entry.action)).toEqual(['proposed', 'proposed']);
  }),
);

it.live('a failed dry run keeps its readable rejection and original cause without publishing a proposal', () =>
  Effect.gen(function* failedDryRun() {
    const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'one', value: false }).pipe(Effect.flip);
    const adapterFailure = new AiAdapterFailure({ cause, message: 'Původní zamítnutí operace.' });
    const events: string[] = [];
    const adapter: AiApprovalAdapter<State, Operation> = {
      ...adapterFor(events),
      run: () => Effect.fail(adapterFailure),
    };
    const failure = yield* proposeAiChanges(adapter, start, proposal, context('run-failure')).pipe(Effect.flip);
    expect(failure.message).toBe('Návrh č. 1 (Změna hodnoty) nelze přijmout: Původní zamítnutí operace.');
    expect(failure.cause).toBe(adapterFailure);
    expect(failure.cause?.cause).toBe(cause);
    expect(events).toEqual(['describe:one']);
    expect(start.aiChanges).toBeUndefined();
  }),
);

it.live('a later restore failure returns no partly reverted state and keeps the original cause', () =>
  Effect.gen(function* failedRestore() {
    const events: string[] = [];
    const adapter = adapterFor(events);
    const proposed = yield* proposeAiChanges(adapter, start, proposal, context('proposal-for-restore-failure'));
    const approved = yield* decideAiChanges(
      adapter,
      proposed.state,
      {
        changeIds: proposed.entityIds.slice(1),
        decision: 'approve',
      },
      context('approval-for-restore-failure'),
    );
    const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'one', value: 'invalid' }).pipe(Effect.flip);
    const adapterFailure = new AiAdapterFailure({ cause, message: 'Záznam nelze obnovit.' });
    const failing: AiApprovalAdapter<State, Operation> = {
      ...adapter,
      restore: (state, snapshot, currentContext, note) =>
        snapshot.id === 'one' ? Effect.fail(adapterFailure) : adapter.restore(state, snapshot, currentContext, note),
    };
    events.length = 0;
    const failure = yield* revertAiBatch(
      failing,
      approved.state,
      {
        batchId: yield* Schema.decodeUnknownEffect(Schema.String)(proposed.entityIds[0]),
      },
      context('restore-failure'),
    ).pipe(Effect.flip);
    expect(failure.kind).toBe('conflict');
    expect(failure.message).toBe('Změna hodnoty (one): Záznam nelze obnovit.');
    expect(failure.cause).toBe(adapterFailure);
    expect(failure.cause?.cause).toBe(cause);
    expect(events).toEqual(['encode:two:20', 'restore:two', 'encode:one:2']);
    expect(approved.state.values.map((entry) => entry.value)).toEqual([2, 20]);
    expect(approved.state.aiChanges?.changes.map((change) => change.status)).toEqual(['applied', 'applied']);
  }),
);

it.live(
  'a handled approval rejection stores the same readable failed status and log without changing business values',
  () =>
    Effect.gen(function* handledApprovalFailure() {
      const events: string[] = [];
      const adapter = adapterFor(events);
      const proposed = yield* proposeAiChanges(adapter, start, proposal, context('proposal-for-run-failure'));
      const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'one', value: null }).pipe(Effect.flip);
      const adapterFailure = new AiAdapterFailure({ cause, message: 'Operaci už nelze provést.' });
      const failing: AiApprovalAdapter<State, Operation> = {
        ...adapter,
        run: () => Effect.fail(adapterFailure),
      };
      const outcome = yield* decideAiChanges(
        failing,
        proposed.state,
        {
          changeIds: proposed.entityIds.slice(1),
          decision: 'approve',
        },
        context('handled-run-failure'),
      );
      expect(outcome.state.values).toBe(start.values);
      expect(
        outcome.state.aiChanges?.changes.map((change) => ({ failure: change.failure, status: change.status })),
      ).toEqual([
        { failure: 'Operaci už nelze provést.', status: 'failed' },
        { failure: 'Operaci už nelze provést.', status: 'failed' },
      ]);
      expect(outcome.state.aiChanges?.log.slice(2).map((entry) => entry.message)).toEqual([
        'Schválení nešlo provést: Změna hodnoty — one: Operaci už nelze provést.',
        'Schválení nešlo provést: Změna hodnoty — two: Operaci už nelze provést.',
      ]);
    }),
);

it.effect('round-trips every canonical persisted AI timestamp and identifier through the domain codecs', () =>
  Effect.gen(function* canonicalWireValues() {
    const at = '2026-10-21T08:00:00.000Z';
    const encoded = {
      batches: [
        {
          agentLabel: 'Agent',
          agentPrincipalId: 'person',
          createdAt: at,
          id: 'batch',
          instruction: 'Změna hodnoty',
          revertedAt: at,
          revertedBy: 'person',
          revertNote: 'Vrácení dávky',
          runId: 'běh:1',
        },
      ],
      changes: [
        {
          appliedAt: at,
          applySequence: 1,
          batchId: 'batch',
          decidedAt: at,
          decidedBy: 'person',
          decisionNote: 'Schváleno',
          diff: [{ after: '2', before: '1', field: 'value', label: 'Hodnota' }],
          id: 'change',
          operation: { _tag: 'SetValue', id: 'one', value: 2 },
          proposedAt: at,
          proposedSnapshots: [
            { after: { id: 'one', value: 2 }, before: { id: 'one', value: 1 }, id: 'one', kind: 'value' },
          ],
          reason: 'Zákazník požádal o změnu.',
          revertedAt: at,
          revertedBy: 'person',
          risk: 'low',
          snapshots: [{ after: { id: 'one', value: 2 }, before: { id: 'one', value: 1 }, id: 'one', kind: 'value' }],
          status: 'reverted',
          summary: 'Změna hodnoty',
          target: { id: 'one', kind: 'value', label: 'one' },
        },
      ],
      log: [
        {
          action: 'reverted',
          actorKind: 'human',
          actorPrincipalId: 'person',
          at,
          batchId: 'batch',
          changeId: 'change',
          id: 'log',
          invocationId: 'invocation',
          message: 'Vráceno',
        },
      ],
    };
    const schema = makeAiApprovalSchemas(OperationSchema).slice;
    const decoded = yield* Schema.decodeUnknownEffect(schema)(encoded);
    const batch = yield* Schema.decodeUnknownEffect(Schema.toType(AiBatchSchema))(decoded.batches[0]);
    expect(DateTime.isUtc(batch.createdAt)).toBe(true);
    expect(yield* Schema.encodeEffect(schema)(decoded)).toEqual(encoded);
    const operation = decoded.changes[0]?.operation;
    expect(Schema.is(OperationSchema)(operation)).toBe(true);
    expect(operation?.id).toBe('one');
    expect(operation?.value).toBe(2);
  }),
);

it.effect('normalizes valid offset timestamps to canonical UTC and rejects malformed timestamp fixtures', () =>
  Effect.gen(function* offsetTimestampPolicy() {
    const wire = {
      agentLabel: 'Agent',
      agentPrincipalId: 'person',
      createdAt: '2026-10-21T10:00:00+02:00',
      id: 'batch',
      instruction: 'Změna hodnoty',
    };
    const decoded = yield* Schema.decodeEffect(AiBatchSchema)(wire);
    const encoded = yield* Schema.encodeEffect(AiBatchSchema)(decoded);
    expect(DateTime.formatIso(decoded.createdAt)).toBe('2026-10-21T08:00:00.000Z');
    expect(encoded).toEqual({ ...wire, createdAt: '2026-10-21T08:00:00.000Z' });
    const malformed = yield* Schema.decodeEffect(AiBatchSchema)({ ...wire, createdAt: 'not-an-instant' }).pipe(
      Effect.flip,
    );
    expect(Schema.isSchemaError(malformed)).toBe(true);
  }),
);

it.live('replays an identical run without executing adapters and rejects a changed instruction or operation', () =>
  Effect.gen(function* replaySafeguards() {
    const events: string[] = [];
    const adapter = adapterFor(events);
    const input = { ...proposal, runId: 'same-run' };
    const proposed = yield* proposeAiChanges(adapter, start, input, context('first-run'));
    events.length = 0;
    const replayed = yield* proposeAiChanges(adapter, proposed.state, input, context('replayed-run'));
    expect(replayed.state).toBe(proposed.state);
    expect(replayed.entityIds).toEqual(proposed.entityIds);
    expect(events).toEqual([]);
    const changedOperation = {
      ...input,
      changes: input.changes.map((entry) => ({
        ...entry,
        operation: { ...entry.operation, value: entry.operation.value + 1 },
      })),
    };
    yield* Effect.forEach(
      [{ ...input, instruction: 'Jiný požadavek' }, changedOperation],
      (changed) =>
        proposeAiChanges(adapter, proposed.state, changed, context('conflicting-run')).pipe(
          Effect.flip,
          Effect.tap((failure) =>
            Effect.sync(() => {
              expect(failure.kind).toBe('conflict');
              expect(events).toEqual([]);
              expect(proposed.state.values).toBe(start.values);
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }),
);

it.live('a handled apply failure does not skip a following change or discard an earlier successful change', () =>
  Effect.gen(function* mixedApprovalResults() {
    const cause = yield* Schema.decodeUnknownEffect(EntitySchema)({ id: 'one', value: false }).pipe(Effect.flip);
    const adapterFailure = new AiAdapterFailure({ cause, message: 'Operaci nelze provést.' });
    yield* Effect.forEach(
      ['one', 'two'],
      (failedId) =>
        Effect.gen(function* approveWithOneFailure() {
          const events: string[] = [];
          const adapter = adapterFor(events);
          const proposed = yield* proposeAiChanges(adapter, start, proposal, context(`propose-${failedId}`));
          const failing: AiApprovalAdapter<State, Operation> = {
            ...adapter,
            run: (state, operation, invocationId) =>
              operation.id === failedId ? Effect.fail(adapterFailure) : adapter.run(state, operation, invocationId),
          };
          const decided = yield* decideAiChanges(
            failing,
            proposed.state,
            { changeIds: proposed.entityIds.slice(1), decision: 'approve', note: '  Schváleno  ' },
            context(`approve-${failedId}`),
          );
          expect(decided.state.values.map((entry) => entry.value)).toEqual(failedId === 'one' ? [1, 20] : [2, 10]);
          expect(decided.state.aiChanges?.changes.map((change) => change.status)).toEqual(
            failedId === 'one' ? ['failed', 'applied'] : ['applied', 'failed'],
          );
          expect(decided.state.aiChanges?.changes.map((change) => change.decisionNote)).toEqual([
            'Schváleno',
            'Schváleno',
          ]);
          expect(decided.state.aiChanges?.log.slice(2).map((entry) => entry.action)).toEqual(
            failedId === 'one' ? ['apply_failed', 'approved'] : ['approved', 'apply_failed'],
          );
        }),
      { concurrency: 1, discard: true },
    );
  }),
);

it.live('reverting an applied change also rejects pending siblings and retains deterministic log order', () =>
  Effect.gen(function* rejectPendingDuringRevert() {
    const adapter = adapterFor([]);
    const proposed = yield* proposeAiChanges(adapter, start, proposal, context('propose-pending'));
    const approved = yield* decideAiChanges(
      adapter,
      proposed.state,
      { changeIds: proposed.entityIds.slice(1, 2), decision: 'approve' },
      context('approve-one'),
    );
    const reverted = yield* revertAiBatch(
      adapter,
      approved.state,
      { batchId: yield* Schema.decodeUnknownEffect(Schema.String)(proposed.entityIds[0]) },
      context('revert-pending'),
    );
    expect(reverted.state.values).toEqual(start.values);
    expect(reverted.state.aiChanges?.changes.map((change) => change.status)).toEqual(['reverted', 'rejected']);
    expect(reverted.state.aiChanges?.changes[1]?.decisionNote).toBe('Zamítnuto při vrácení celé dávky');
    expect(reverted.state.aiChanges?.log.slice(3).map((entry) => entry.action)).toEqual([
      'reverted',
      'rejected',
      'batch_reverted',
    ]);
    expect(reverted.state.aiChanges?.log.slice(3).map((entry) => entry.id)).toEqual([
      'revert-pending:ai-log-0',
      'revert-pending:ai-log-1',
      'revert-pending:ai-log-2',
    ]);
  }),
);

it.live('foreign edits block approval and revert without publishing any partial state', () =>
  Effect.gen(function* staleSnapshotSafeguards() {
    const events: string[] = [];
    const adapter = adapterFor(events);
    const proposed = yield* proposeAiChanges(adapter, start, proposal, context('propose-stale'));
    const changed: State = {
      ...proposed.state,
      values: proposed.state.values.map((entry) => (entry.id === 'one' ? { ...entry, value: 999 } : entry)),
    };
    events.length = 0;
    const stale = yield* decideAiChanges(
      adapter,
      changed,
      { changeIds: proposed.entityIds.slice(1), decision: 'approve' },
      context('approve-stale'),
    ).pipe(Effect.flip);
    expect(stale.kind).toBe('conflict');
    expect(events).toEqual(['encode:one:999']);
    expect(changed.aiChanges?.changes.map((change) => change.status)).toEqual(['pending', 'pending']);
    const approved = yield* decideAiChanges(
      adapter,
      proposed.state,
      { changeIds: proposed.entityIds.slice(1), decision: 'approve' },
      context('approve-before-edit'),
    );
    const edited: State = {
      ...approved.state,
      values: approved.state.values.map((entry) => (entry.id === 'one' ? { ...entry, value: 999 } : entry)),
    };
    const refused = yield* revertAiBatch(
      adapter,
      edited,
      { batchId: yield* Schema.decodeUnknownEffect(Schema.String)(proposed.entityIds[0]) },
      context('revert-edited'),
    ).pipe(Effect.flip);
    expect(refused.kind).toBe('conflict');
    expect(edited.values.map((entry) => entry.value)).toEqual([999, 20]);
    expect(edited.aiChanges?.changes.map((change) => change.status)).toEqual(['applied', 'applied']);
  }),
);

it('preserves frozen 32-bit UTF-16 hash outputs for BMP characters and paired or unpaired surrogates', () => {
  const vectors = [
    ['', '027ae52e-1ca8-4f5f-86fc-3073982eea02'],
    ['invocation:c0', 'afcd12fb-3c9f-40f9-ae70-ebf3bd2219f1'],
    ['Příliš žluťoučký kůň', '022bb1a2-b200-4c7e-a528-9b37d50336eb'],
    ['a😀b', '571cf49e-8701-45a1-b2c9-8f1a62d44e25'],
    ['\uD800', 'd3a61907-808b-49d1-a3ed-cb6bf0c00bbd'],
    ['\uDFFF', 'e96aa344-24f6-40a6-90e8-bf491d745cab'],
    ['\uD800x\uDFFF', 'e7310cf9-e585-45db-893e-e4f4cb8afdd6'],
    ['\uD800\uDC00', '1eab2d7c-ff00-4c53-85d7-5076247cb159'],
    ['\uDBFF\uDFFF', '6757199c-68fc-47ee-9d75-e35792defd25'],
    ['\uDC00\uD800', 'f17b07df-fcf1-4065-9c18-66e811929152'],
    ['\u0000\uFFFF', 'c266b8c4-f20f-4b85-9e36-06e8ee5f45a9'],
    ['😀😀\uD800', '85ecfa7e-b914-4f65-9001-600d6cf9e516'],
  ] as const;
  for (const [seed, expected] of vectors) {
    expect(deriveAiUuid(seed)).toBe(expected);
  }
});

it('compares snapshot keys independently of insertion order while keeping array order and absence distinct', () => {
  const nested = { b: 2, c: 3 };
  const reorderedNested = Object.fromEntries(Object.entries(nested).toReversed());
  const reordered = Object.fromEntries([
    ['nested', reorderedNested],
    ['a', 1],
  ]);
  expect(sameJson({ a: 1, nested }, reordered)).toBe(true);
  expect(sameJson(Object.fromEntries([['a', undefined]]), {})).toBe(true);
  expect(sameJson([1, 2], [2, 1])).toBe(false);
  expect(sameJson({ a: null }, {})).toBe(false);
});
