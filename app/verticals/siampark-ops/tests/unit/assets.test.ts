import { DateTime, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AssetsCommandSchema, evolveAssets } from '../../shared/commands/assets.ts';
import type { AssetsCommand } from '../../shared/commands/assets.ts';
import {
  AssetsStateSchema,
  emptyAssetsState,
  indicativeSchedule,
  upcomingServiceDue,
} from '../../shared/domain/assets.ts';
import type { AssetsState } from '../../shared/domain/assets.ts';
import type { OpsCommandInput } from '../../shared/domain/common.ts';
import { seedAssetsState } from '../../scripts/seed/assets.mts';

const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId: '70000000-0000-4000-8000-000000000020' };
const input = (resourceId: string): OpsCommandInput => ({
  actor: actor as OpsCommandInput['actor'],
  now: DateTime.makeUnsafe('2026-10-20T08:00:00Z'),
  resourceId,
});
const decodeCommand = Schema.decodeUnknownEffect(AssetsCommandSchema);
const empty = Schema.decodeUnknownEffect(AssetsStateSchema)(emptyAssetsState);

const apply = (state: AssetsState, command: unknown, resourceId: string) =>
  Effect.flatMap(decodeCommand(command), (decoded: AssetsCommand) => evolveAssets(state, decoded, input(resourceId)));

const withAsset = Effect.gen(function* withAssetEffect() {
  const state = yield* empty;
  const created = yield* apply(
    state,
    {
      _tag: 'AssetCreate',
      acquisitionDate: '2024-03-01',
      acquisitionMethod: 'purchase',
      acquisitionValueMinor: 10_000_000,
      category: 'Klimatizace',
      inventoryNumber: 'TEC-001',
      kind: 'technology',
      name: 'Klimatizační jednotka',
    },
    'asset-1',
  );
  return created.state;
});

it.effect('S02-02 value change keeps the original value and the reason in history', () =>
  Effect.gen(function* valueChange() {
    const state = yield* withAsset;
    expect(state.assets[0]?.currentValueMinor).toBe(10_000_000);
    const changed = yield* apply(
      state,
      {
        _tag: 'AssetValueChange',
        assetId: 'asset-1',
        date: '2026-10-01',
        newValueMinor: 12_000_000,
        reason: 'Modernizace',
      },
      'value-1',
    );
    const asset = changed.state.assets[0];
    expect(asset?.currentValueMinor).toBe(12_000_000);
    const event = asset?.events?.find((entry) => entry.kind === 'value_change');
    expect(event?.previousValueMinor).toBe(10_000_000);
    expect(event?.newValueMinor).toBe(12_000_000);
    expect(event?.note).toBe('Modernizace');
    expect(asset?.acquisitionValueMinor).toBe(10_000_000);
  }),
);

it.effect('duplicate inventory number is rejected', () =>
  Effect.gen(function* duplicate() {
    const state = yield* withAsset;
    const exit = yield* Effect.exit(
      apply(
        state,
        { _tag: 'AssetCreate', category: 'X', inventoryNumber: 'tec-001', kind: 'equipment', name: 'Y' },
        'a2',
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('S02-04 disposed asset leaves the active list, keeps history and refuses changes', () =>
  Effect.gen(function* dispose() {
    const state = yield* withAsset;
    const disposed = yield* apply(
      state,
      { _tag: 'AssetDispose', assetId: 'asset-1', date: '2026-10-15', kind: 'retirement', reason: 'Nefunkční' },
      'dispose-1',
    );
    const asset = disposed.state.assets[0];
    expect(asset?.status).toBe('disposed');
    expect(asset?.events?.map((entry) => entry.kind)).toEqual(['acquisition', 'retirement']);
    const exit = yield* Effect.exit(
      apply(
        disposed.state,
        { _tag: 'AssetValueChange', assetId: 'asset-1', date: '2026-10-16', newValueMinor: 1, reason: 'x' },
        'v',
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const inventory = yield* Effect.exit(
      apply(
        disposed.state,
        { _tag: 'AssetInventoryCreate', assetIds: ['asset-1'], date: '2026-10-20', title: 'I' },
        'i',
      ),
    );
    expect(Exit.isFailure(inventory)).toBe(true);
  }),
);

it.effect('S02-03 missing item gets a follow-up task; inventory closes only when every item is checked', () =>
  Effect.gen(function* inventoryFlow() {
    const state = yield* withAsset;
    const created = yield* apply(
      state,
      { _tag: 'AssetInventoryCreate', assetIds: ['asset-1'], date: '2026-10-20', title: 'Inventura 2026' },
      'inv',
    );
    const inventoryId = created.state.inventories?.[0]?.id ?? '';
    const closeEarly = yield* Effect.exit(apply(created.state, { _tag: 'AssetInventoryClose', inventoryId }, 'c0'));
    expect(Exit.isFailure(closeEarly)).toBe(true);
    const foundFollowUp = yield* Effect.exit(
      apply(
        created.state,
        { _tag: 'AssetInventoryFollowUp', assetId: 'asset-1', dueDate: '2026-10-30', inventoryId, title: 'T' },
        'f0',
      ),
    );
    expect(Exit.isFailure(foundFollowUp)).toBe(true);
    const marked = yield* apply(
      created.state,
      { _tag: 'AssetInventoryMark', assetId: 'asset-1', inventoryId, note: 'Není v místnosti', result: 'missing' },
      'm1',
    );
    const task = yield* apply(
      marked.state,
      {
        _tag: 'AssetInventoryFollowUp',
        assetId: 'asset-1',
        dueDate: '2026-10-30',
        inventoryId,
        title: 'Dohledat jednotku',
      },
      'f1',
    );
    const item = task.state.inventories?.[0]?.items[0];
    expect(item?.result).toBe('missing');
    expect(item?.followUp?.status).toBe('open');
    const closed = yield* apply(task.state, { _tag: 'AssetInventoryClose', inventoryId }, 'c1');
    expect(closed.state.inventories?.[0]?.status).toBe('closed');
  }),
);

it.effect('S03-01 accounting and tax approved amounts stay separate; base cannot be exceeded', () =>
  Effect.gen(function* depreciation() {
    const state = yield* withAsset;
    const accounting = yield* apply(
      state,
      {
        _tag: 'AssetDepreciationPlanCreate',
        assetId: 'asset-1',
        baseMinor: 10_000_000,
        interval: 'yearly',
        method: 'rovnoměrný',
        startDate: '2024-04-01',
        type: 'accounting',
        years: 10,
      },
      'p1',
    );
    const tax = yield* apply(
      accounting.state,
      {
        _tag: 'AssetDepreciationPlanCreate',
        assetId: 'asset-1',
        baseMinor: 10_000_000,
        interval: 'yearly',
        method: 'rovnoměrný',
        startDate: '2024-04-01',
        taxGroup: '2',
        type: 'tax',
        years: 5,
      },
      'p2',
    );
    const duplicate = yield* Effect.exit(
      apply(
        tax.state,
        {
          _tag: 'AssetDepreciationPlanCreate',
          assetId: 'asset-1',
          baseMinor: 1,
          interval: 'yearly',
          method: 'x',
          startDate: '2024-01-01',
          type: 'tax',
          years: 1,
        },
        'p3',
      ),
    );
    expect(Exit.isFailure(duplicate)).toBe(true);
    const a = yield* apply(
      tax.state,
      {
        _tag: 'AssetDepreciationEntryRecord',
        amountMinor: 150_000,
        assetId: 'asset-1',
        period: '2026',
        planId: 'p1:plan',
      },
      'e1',
    );
    const b = yield* apply(
      a.state,
      {
        _tag: 'AssetDepreciationEntryRecord',
        amountMinor: 120_000,
        assetId: 'asset-1',
        period: '2026',
        planId: 'p2:plan',
      },
      'e2',
    );
    const plans = b.state.assets[0]?.depreciationPlans ?? [];
    expect(plans.find((plan) => plan.type === 'accounting')?.entries.map((entry) => entry.amountMinor)).toEqual([
      150_000,
    ]);
    expect(plans.find((plan) => plan.type === 'tax')?.entries.map((entry) => entry.amountMinor)).toEqual([120_000]);
    const samePeriod = yield* Effect.exit(
      apply(
        b.state,
        { _tag: 'AssetDepreciationEntryRecord', amountMinor: 1, assetId: 'asset-1', period: '2026', planId: 'p1:plan' },
        'e3',
      ),
    );
    expect(Exit.isFailure(samePeriod)).toBe(true);
    const monthly = yield* Effect.exit(
      apply(
        b.state,
        {
          _tag: 'AssetDepreciationEntryRecord',
          amountMinor: 1,
          assetId: 'asset-1',
          period: '2026-05',
          planId: 'p1:plan',
        },
        'e4',
      ),
    );
    expect(Exit.isFailure(monthly)).toBe(true);
    const tooMuch = yield* Effect.exit(
      apply(
        b.state,
        {
          _tag: 'AssetDepreciationEntryRecord',
          amountMinor: 9_900_000,
          assetId: 'asset-1',
          period: '2027',
          planId: 'p1:plan',
        },
        'e5',
      ),
    );
    expect(Exit.isFailure(tooMuch)).toBe(true);
    const confirmed = yield* apply(
      b.state,
      { _tag: 'AssetDepreciationPlanConfirm', assetId: 'asset-1', planId: 'p1:plan' },
      'k1',
    );
    const plan = confirmed.state.assets[0]?.depreciationPlans?.find((entry) => entry.id === 'p1:plan');
    expect(plan?.status).toBe('confirmed');
    expect(plan?.history.map((entry) => entry.change)).toEqual(['created', 'entry_recorded', 'confirmed']);
  }),
);

it.effect('service records feed the upcoming-due list (newest record per kind and title)', () =>
  Effect.gen(function* services() {
    const state = yield* withAsset;
    const first = yield* apply(
      state,
      {
        _tag: 'AssetServiceRecord',
        assetId: 'asset-1',
        kind: 'revision',
        nextDueOn: '2026-11-01',
        performedOn: '2025-11-01',
        title: 'Revize',
      },
      's1',
    );
    const second = yield* apply(
      first.state,
      {
        _tag: 'AssetServiceRecord',
        assetId: 'asset-1',
        kind: 'revision',
        nextDueOn: '2027-11-01',
        performedOn: '2026-10-20',
        title: 'Revize',
      },
      's2',
    );
    expect(upcomingServiceDue(second.state).map((entry) => entry.nextDueOn)).toEqual(['2027-11-01']);
  }),
);

it('indicative schedule spreads the base and ends exactly on it', () => {
  const rows = indicativeSchedule({ baseMinor: 10_000_000, interval: 'yearly', startDate: '2024-04-01', years: 3 });
  expect(rows.map((row) => row.period)).toEqual(['2024', '2025', '2026']);
  expect(rows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(10_000_000);
});

it.effect('seed decodes with the state schema', () =>
  Effect.gen(function* seed() {
    const state = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
    expect(state.assets.length).toBeGreaterThanOrEqual(20);
  }),
);
