import { AiAdapterFailure, AiFailure, AiSnapshotSchema } from '@app/shared-contracts/ai-approvals';
import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  salesPipelineAiCommandSchemas,
  SalesPipelineCommandSchema,
  SalesPipelineLifecycleConflict,
  SalesPipelinePermissionDenied,
} from '../../shared/actions/apply-command.ts';
import { SalesPipelineStateSchema } from '../../shared/apis/records.ts';
import type { SalesPipelineState } from '../../shared/apis/records.ts';
import { assertCommandAllowed } from '../../shared/actions/command-guard.ts';
import { applySalesPipelineAiCommand } from '../../src/services/ai-changes.ts';
import { evolveOpportunityState } from '../../src/services/persistence.service.ts';

/** A real asynchronous boundary with no timing assertion or external I/O. */
const nextMicrotask = Effect.promise(() => Promise.resolve());

it('round-trips JSON values in shared approval snapshots', () => {
  for (const value of [null, 42, true, 'value', [1, null], { nested: { values: [1, 'value', false] } }]) {
    const snapshot = { after: value, before: value, id: 'snapshot-1', kind: 'opportunity' };
    const decoded = Schema.decodeUnknownSync(AiSnapshotSchema)(snapshot);
    expect(Schema.encodeSync(AiSnapshotSchema)(decoded)).toEqual(snapshot);
  }
});

it('rejects non-JSON values in either side of shared approval snapshots', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1n, { nested: Symbol('not-json') }]) {
    expect(Schema.is(AiSnapshotSchema)({ after: value, id: 'snapshot-1', kind: 'opportunity' })).toBe(false);
    expect(Schema.is(AiSnapshotSchema)({ before: value, id: 'snapshot-1', kind: 'opportunity' })).toBe(false);
  }
});

const now = DateTime.makeUnsafe('2026-10-21T08:00:00Z');
const partyId = '50000000-0000-4000-8000-000000000001';
const opportunityA = '60000000-0000-4000-8000-000000000001';
const agent = 'ai-agent-c-obchod';
const approver = 'vedouci-obchodu';

const decode = Schema.decodeUnknownSync(SalesPipelineCommandSchema);
const StateJsonSchema = Schema.fromJsonString(SalesPipelineStateSchema);
/** Persistence round trip: every step starts from the encoded JSON the database would return. */
const roundTrip = (state: SalesPipelineState) =>
  Schema.decodeUnknownSync(StateJsonSchema)(Schema.encodeSync(StateJsonSchema)(state));

const seeded = Effect.gen(function* seed() {
  const created = yield* evolveOpportunityState(
    { opportunities: [] },
    decode({
      _tag: 'CreateOpportunity',
      expectedCloseDate: '2026-12-31',
      lines: [],
      partyId,
      title: 'Wi-Fi pokrytí skladu',
    }),
    { invocationId: opportunityA, now },
  );
  return roundTrip(created.state);
});

const AiCommandSchema = Schema.Union(salesPipelineAiCommandSchemas);
const decodeAiCommand = Schema.decodeUnknownSync(AiCommandSchema);

/** Callers decode their raw fixtures at the same schema boundary as incoming AI commands. */
const ai = (state: SalesPipelineState, input: typeof AiCommandSchema.Type, invocationId: string, principalId: string) =>
  applySalesPipelineAiCommand(state, input, { invocationId, now, principalId }, evolveOpportunityState).pipe(
    Effect.map((outcome) => ({ ...outcome, state: roundTrip(outcome.state) })),
  );

const proposal = {
  _tag: 'AiProposeChanges',
  agentLabel: 'AI asistent · úroveň C',
  changes: [
    {
      operation: { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'NEGOTIATION' },
      reason: 'Zákazník potvrdil jednání o ceně.',
    },
  ],
  instruction: 'Posuň Wi-Fi příležitost do vyjednávání.',
  runId: 'run-1',
};

it.effect('a proposal changes nothing until a person approves it; Vrátit vše restores the original', () =>
  Effect.gen(function* flow() {
    const start = yield* seeded;
    const proposed = yield* ai(start, decodeAiCommand(proposal), '80000000-0000-4000-8000-000000000001', agent);
    expect(proposed.state.opportunities[0]?.stage).toBe('LEAD');
    const change = proposed.state.aiChanges?.changes[0];
    expect(change?.status).toBe('pending');
    expect(change?.diff).toEqual([{ after: 'Vyjednávání', before: 'Nová', field: 'stage', label: 'Fáze' }]);

    // Same runId: no duplicate batch.
    const replay = yield* ai(proposed.state, decodeAiCommand(proposal), '80000000-0000-4000-8000-000000000002', agent);
    expect(replay.state.aiChanges?.batches).toHaveLength(1);

    const approved = yield* ai(
      proposed.state,
      decodeAiCommand({ _tag: 'AiDecideChanges', changeIds: [change?.id], decision: 'approve' }),
      '80000000-0000-4000-8000-000000000003',
      approver,
    );
    expect(approved.state.opportunities[0]?.stage).toBe('NEGOTIATION');
    expect(approved.state.aiChanges?.changes[0]?.status).toBe('applied');

    const reverted = yield* ai(
      approved.state,
      decodeAiCommand({ _tag: 'AiRevertBatch', batchId: proposed.entityIds[0] }),
      '80000000-0000-4000-8000-000000000004',
      approver,
    );
    expect(reverted.state.opportunities[0]?.stage).toBe('LEAD');
    expect(reverted.state.opportunities[0]?.stageHistory.map((entry) => entry.stage)).toEqual([
      'LEAD',
      'NEGOTIATION',
      'LEAD',
    ]);
    expect(reverted.state.aiChanges?.changes[0]?.status).toBe('reverted');
    expect(reverted.state.aiChanges?.log.map((entry) => entry.action)).toEqual([
      'proposed',
      'approved',
      'reverted',
      'batch_reverted',
    ]);
  }),
);

it.effect('a stale proposal is refused and an impossible one is rejected at proposal time', () =>
  Effect.gen(function* stale() {
    const start = yield* seeded;
    const proposed = yield* ai(start, decodeAiCommand(proposal), '80000000-0000-4000-8000-000000000011', agent);
    const moved = yield* evolveOpportunityState(
      proposed.state,
      decode({ _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'PROPOSAL' }),
      { invocationId: '80000000-0000-4000-8000-000000000012', now },
    );
    const refused = yield* ai(
      roundTrip(moved.state),
      decodeAiCommand({
        _tag: 'AiDecideChanges',
        changeIds: [proposed.state.aiChanges?.changes[0]?.id],
        decision: 'approve',
      }),
      '80000000-0000-4000-8000-000000000013',
      approver,
    ).pipe(Effect.flip);
    expect(refused.kind).toBe('conflict');

    const won = yield* evolveOpportunityState(
      start,
      decode({ _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'WON' }),
      { invocationId: '80000000-0000-4000-8000-000000000014', now },
    );
    const impossible = yield* ai(
      roundTrip(won.state),
      decodeAiCommand({ ...proposal, runId: 'run-closed' }),
      '80000000-0000-4000-8000-000000000015',
      agent,
    ).pipe(Effect.flip);
    expect(impossible.message).toContain('Uzavřenou');
    expect(Schema.is(AiFailure)(impossible)).toBe(true);
    expect(Schema.is(AiAdapterFailure)(impossible.cause)).toBe(true);
    expect(Schema.is(SalesPipelineLifecycleConflict)(impossible.cause?.cause)).toBe(true);
  }),
);

it.effect('an approved new opportunity is archived (not deleted) by Vrátit vše', () =>
  Effect.gen(function* create() {
    const start = yield* seeded;
    const proposed = yield* ai(
      start,
      decodeAiCommand({
        _tag: 'AiProposeChanges',
        changes: [
          {
            operation: {
              _tag: 'CreateOpportunity',
              expectedCloseDate: '2026-11-30',
              lines: [{ productName: 'Servis', quantity: 2, unitPriceMinor: 150_000, vatRate: 21 }],
              partyId,
              title: 'Servisní smlouva',
            },
            reason: 'Zákazník poptal servis.',
          },
        ],
        instruction: 'Založ příležitost na servis.',
      }),
      '80000000-0000-4000-8000-000000000021',
      agent,
    );
    expect(proposed.state.opportunities).toHaveLength(1);
    const approved = yield* ai(
      proposed.state,
      decodeAiCommand({ _tag: 'AiDecideChanges', changeIds: [proposed.entityIds[1]], decision: 'approve' }),
      '80000000-0000-4000-8000-000000000022',
      approver,
    );
    expect(approved.state.opportunities).toHaveLength(2);
    expect(approved.state.opportunities[1]?.amountMinor).toBe(300_000);
    const reverted = yield* ai(
      approved.state,
      decodeAiCommand({ _tag: 'AiRevertBatch', batchId: proposed.entityIds[0] }),
      '80000000-0000-4000-8000-000000000023',
      approver,
    );
    expect(reverted.state.opportunities).toHaveLength(2);
    expect(reverted.state.opportunities[1]?.archivedAt).toBeDefined();
  }),
);

it.effect('API keys may propose but never decide or revert', () =>
  Effect.gen(function* guard() {
    yield* assertCommandAllowed('non_human', 'AiProposeChanges');
    for (const tag of ['AiDecideChanges', 'AiRevertBatch']) {
      const denied = yield* assertCommandAllowed('non_human', tag).pipe(Effect.flip);
      expect(Schema.is(SalesPipelinePermissionDenied)(denied)).toBe(true);
      yield* assertCommandAllowed('human', tag);
    }
  }),
);

it.live('opportunity proposals await an asynchronous owner reducer and retain encoded snapshots', () =>
  Effect.gen(function* asynchronousOpportunityProposal() {
    const start = yield* seeded;
    const proposed = yield* applySalesPipelineAiCommand(
      start,
      decodeAiCommand(proposal),
      {
        invocationId: 'asynchronous-opportunity-proposal',
        now,
        principalId: agent,
      },
      (state, command, input) => evolveOpportunityState(state, command, input).pipe(Effect.tap(() => nextMicrotask)),
    );
    expect(proposed.state.opportunities).toBe(start.opportunities);
    expect(proposed.state.aiChanges?.changes[0]?.diff).toEqual([
      { after: 'Vyjednávání', before: 'Nová', field: 'stage', label: 'Fáze' },
    ]);
    const snapshots = proposed.state.aiChanges?.changes[0]?.proposedSnapshots;
    expect(snapshots).toHaveLength(1);
    expect(snapshots?.[0]?.before).toMatchObject({
      id: opportunityA,
      stage: 'LEAD',
      updatedAt: DateTime.formatIso(now),
    });
    expect(snapshots?.[0]?.after).toMatchObject({
      id: opportunityA,
      stage: 'NEGOTIATION',
      updatedAt: DateTime.formatIso(now),
    });
    expect(start.aiChanges).toBeUndefined();
  }),
);
