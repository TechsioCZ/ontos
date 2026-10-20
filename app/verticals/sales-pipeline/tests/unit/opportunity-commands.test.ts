import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  SalesPipelineCommandSchema,
  SalesPipelineLifecycleConflict,
  SalesPipelineNotFound,
  SalesPipelineRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import type { SalesPipelineState } from '../../shared/apis/records.ts';
import { evolveOpportunityState } from '../../src/services/persistence.service.ts';

type CommandInput = typeof SalesPipelineCommandSchema.Encoded;
type CreateInput = Extract<CommandInput, { readonly _tag: 'CreateOpportunity' }>;

const now = DateTime.makeUnsafe('2026-10-05T10:00:00Z');
const later = DateTime.makeUnsafe('2026-10-06T10:00:00Z');
const partyId = '50000000-0000-4000-8000-000000000001';
const employeeA = '40000000-0000-4000-8000-000000000001';
const employeeB = '40000000-0000-4000-8000-000000000002';
const productId = '30000000-0000-4000-8000-000000000001';
const opportunityA = '60000000-0000-4000-8000-000000000001';
const opportunityB = '60000000-0000-4000-8000-000000000002';
const missingOpportunity = '60000000-0000-4000-8000-0000000000ff';
const unusedInvocation = '70000000-0000-4000-8000-0000000000ff';
const emptyState: SalesPipelineState = { opportunities: [] };

const decode = Schema.decodeUnknownEffect(SalesPipelineCommandSchema);
const run = (state: SalesPipelineState, input: CommandInput, invocationId = opportunityA, at = now) =>
  decode(input).pipe(Effect.flatMap((command) => evolveOpportunityState(state, command, { invocationId, now: at })));

const createInput = (overrides: Partial<CreateInput> = {}): CommandInput => ({
  _tag: 'CreateOpportunity',
  expectedCloseDate: '2026-12-31',
  lines: [],
  partyId,
  title: 'Chair deal',
  ...overrides,
});

it.effect('create, move through open stages, then WON closes the opportunity', () =>
  Effect.gen(function* create() {
    const created = yield* run(emptyState, createInput(), opportunityA);
    const [opportunity] = created.affected;
    expect(opportunity?.stage).toBe('LEAD');
    expect(opportunity?.probability).toBe(10);
    expect(opportunity?.closedAt).toBeUndefined();
    expect(opportunity?.stageHistory).toEqual([{ at: now, stage: 'LEAD' }]);
    expect(created.stageChanges.map((change) => change.opportunity)).toEqual([opportunity]);
    expect(created.stageChanges.map((change) => Option.isNone(change.fromStage))).toEqual([true]);

    const qualified = yield* run(
      created.state,
      { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'QUALIFIED' },
      unusedInvocation,
      later,
    );
    expect(qualified.affected[0]?.probability).toBe(25);
    expect(qualified.stageChanges.map((change) => change.opportunity.stage)).toEqual(['QUALIFIED']);
    expect(qualified.stageChanges.map((change) => Option.getOrUndefined(change.fromStage))).toEqual(['LEAD']);

    const won = yield* run(qualified.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'WON' });
    const [closed] = won.affected;
    expect(closed?.stage).toBe('WON');
    expect(closed?.probability).toBe(100);
    expect(closed?.closedAt).toEqual(now);
    expect(closed?.stageHistory.map((entry) => entry.stage)).toEqual(['LEAD', 'QUALIFIED', 'WON']);
    expect(won.stageChanges.map((change) => change.opportunity.stage)).toEqual(['WON']);
  }),
);

it.effect('a closed opportunity rejects every stage change, update and assignment', () =>
  Effect.gen(function* closedIsTerminal() {
    const created = yield* run(emptyState, createInput(), opportunityA);
    const won = yield* run(created.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'WON' });
    for (const toStage of ['LEAD', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'LOST', 'WON'] as const) {
      const error = yield* run(won.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage }).pipe(
        Effect.flip,
      );
      expect(Schema.is(SalesPipelineLifecycleConflict)(error)).toBe(true);
    }
    const updateError = yield* run(won.state, {
      _tag: 'UpdateOpportunity',
      id: opportunityA,
      patch: { title: 'Renamed' },
    }).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineLifecycleConflict)(updateError)).toBe(true);
    const assignError = yield* run(won.state, {
      _tag: 'AssignOpportunity',
      id: opportunityA,
      ownerEmployeeId: employeeA,
    }).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineLifecycleConflict)(assignError)).toBe(true);
  }),
);

it.effect('LOST is terminal too and same-stage moves are not transitions', () =>
  Effect.gen(function* lostAndSameStage() {
    const created = yield* run(emptyState, createInput(), opportunityA);
    const sameStage = yield* run(created.state, {
      _tag: 'ChangeOpportunityStage',
      id: opportunityA,
      toStage: 'LEAD',
    }).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineLifecycleConflict)(sameStage)).toBe(true);

    const lost = yield* run(created.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'LOST' });
    expect(lost.affected[0]?.probability).toBe(0);
    expect(lost.affected[0]?.closedAt).toEqual(now);
    const reopen = yield* run(lost.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'LEAD' }).pipe(
      Effect.flip,
    );
    expect(Schema.is(SalesPipelineLifecycleConflict)(reopen)).toBe(true);
  }),
);

it.effect('a stage change to an unknown opportunity is not found', () =>
  Effect.gen(function* unknownOpportunity() {
    const error = yield* run(emptyState, {
      _tag: 'ChangeOpportunityStage',
      id: missingOpportunity,
      toStage: 'WON',
    }).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineNotFound)(error)).toBe(true);
  }),
);

it.effect('bulk stage change skips a closed opportunity and an unknown id with per-id results', () =>
  Effect.gen(function* bulkSkipsClosed() {
    const withA = yield* run(emptyState, createInput({ title: 'First' }), opportunityA);
    const withB = yield* run(withA.state, createInput({ title: 'Second' }), opportunityB);
    const wonB = yield* run(withB.state, { _tag: 'ChangeOpportunityStage', id: opportunityB, toStage: 'WON' });

    const moved = yield* run(wonB.state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA, opportunityB, missingOpportunity],
      patch: { stage: 'NEGOTIATION' },
    });
    expect(moved.results).toEqual([
      { id: opportunityA, outcome: 'changed' },
      { id: opportunityB, outcome: 'skipped', reason: 'closed' },
      { id: missingOpportunity, outcome: 'skipped', reason: 'not_found' },
    ]);
    expect(moved.affected.map((opportunity) => opportunity.id)).toEqual([opportunityA]);
    expect(moved.affected[0]?.probability).toBe(75);
    expect(moved.stageChanges.map((change) => change.opportunity.id)).toEqual([opportunityA]);

    const again = yield* run(moved.state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA],
      patch: { stage: 'NEGOTIATION' },
    });
    expect(again.results).toEqual([{ id: opportunityA, outcome: 'skipped', reason: 'invalid_transition' }]);
    expect(again.affected).toEqual([]);
    expect(again.stageChanges).toEqual([]);
  }),
);

it.effect('bulk owner patch sets, clears and reports unchanged owners without touching the stage', () =>
  Effect.gen(function* bulkOwner() {
    const withA = yield* run(emptyState, createInput(), opportunityA);
    const assigned = yield* run(withA.state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA],
      patch: { ownerEmployeeId: employeeB },
    });
    expect(assigned.affected[0]?.ownerEmployeeId).toBe(employeeB);
    expect(assigned.stageChanges).toEqual([]);

    const unchanged = yield* run(assigned.state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA],
      patch: { ownerEmployeeId: employeeB },
    });
    expect(unchanged.results).toEqual([{ id: opportunityA, outcome: 'skipped' }]);

    const cleared = yield* run(assigned.state, {
      _tag: 'BulkUpdateOpportunities',
      ids: [opportunityA],
      patch: { ownerEmployeeId: null },
    });
    const [clearedOpportunity] = cleared.affected;
    expect(clearedOpportunity?.ownerEmployeeId).toBeUndefined();
    expect(Object.keys(clearedOpportunity ?? {})).not.toContain('ownerEmployeeId');
  }),
);

it.effect('amount follows the lines on create and on line updates', () =>
  Effect.gen(function* amounts() {
    const lines = [
      { productId, productName: 'Chair', quantity: 2, unitPriceMinor: 150_000, vatRate: 21 },
      { productName: 'Desk', quantity: 1, unitPriceMinor: 5000, vatRate: 10 },
    ] as const;
    const created = yield* run(emptyState, createInput({ lines: [...lines] }), opportunityA);
    expect(created.affected[0]?.amountMinor).toBe(305_000);

    const relined = yield* run(created.state, {
      _tag: 'UpdateOpportunity',
      id: opportunityA,
      patch: { lines: [{ productName: 'Chair', quantity: 3, unitPriceMinor: 150_000, vatRate: 21 }] },
    });
    expect(relined.affected[0]?.amountMinor).toBe(450_000);
    expect(relined.affected[0]?.lines).toHaveLength(1);

    const retitled = yield* run(relined.state, {
      _tag: 'UpdateOpportunity',
      id: opportunityA,
      patch: { title: 'Renamed' },
    });
    expect(retitled.affected[0]?.amountMinor).toBe(450_000);
    expect(retitled.affected[0]?.title).toBe('Renamed');
  }),
);

it.effect('create keeps the assignee and rejects a duplicate identity', () =>
  Effect.gen(function* createDefaults() {
    const created = yield* run(emptyState, createInput({ ownerEmployeeId: employeeA }), opportunityA);
    expect(created.affected[0]?.stage).toBe('LEAD');
    expect(created.affected[0]?.ownerEmployeeId).toBe(employeeA);
    const duplicate = yield* run(created.state, createInput(), opportunityA).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineRevisionConflict)(duplicate)).toBe(true);
  }),
);

it.effect('archives a closed opportunity without deleting its history or emitting a new sale', () =>
  Effect.gen(function* archiveClosed() {
    const created = yield* run(emptyState, createInput(), opportunityA);
    const rejected = yield* run(created.state, { _tag: 'ArchiveOpportunity', id: opportunityA }).pipe(Effect.flip);
    expect(Schema.is(SalesPipelineLifecycleConflict)(rejected)).toBe(true);
    const lost = yield* run(created.state, { _tag: 'ChangeOpportunityStage', id: opportunityA, toStage: 'LOST' });
    const archived = yield* run(lost.state, { _tag: 'ArchiveOpportunity', id: opportunityA }, unusedInvocation, later);
    expect(archived.state.opportunities).toHaveLength(1);
    expect(archived.affected[0]?.archivedAt).toEqual(later);
    expect(archived.affected[0]?.stageHistory).toEqual(lost.affected[0]?.stageHistory);
    expect(archived.stageChanges).toEqual([]);
  }),
);
