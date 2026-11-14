import { draftSavable, startDraftSave } from '@app/admin-ui';
import type { SaveOutcome } from '@app/admin-ui';
import { Effect, Option, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'effect-rstest';
import { AssetSchema } from '../../shared/domain/assets.ts';
import {
  assetCardCreateCommandOf,
  assetCardDraftOf,
  assetCardProblems,
  assetCardUpdateCommandOf,
  sameAssetCardDraft,
} from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';
import type { AssetCardDraft } from '../../src/routes/[lang]/provoz/majetek/asset-card-draft.ts';

const tenantId = '70000000-0000-4000-8000-000000000020';
const actor = { principalId: '72000000-0000-4000-8000-000000000021', tenantId };
const at = '2026-10-20T08:00:00Z';
const asset = Schema.decodeUnknownSync(AssetSchema)({
  acquisitionDate: '2024-03-01',
  category: 'Klimatizace',
  createdAt: at,
  createdBy: actor,
  id: 'asset-1',
  inventoryNumber: 'MJ-2024-017',
  kind: 'equipment',
  location: { id: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b', kind: 'property', label: 'Rezidence Parková' },
  name: 'Venkovní jednotka',
  note: 'Střešní instalace',
  propertyId: 'f5ef97e9-2935-4ebc-83e6-aa9d475e561b',
  responsible: 'Jan Novák',
  serialNumber: 'KL-8831',
  updatedAt: at,
  updatedBy: actor,
});
const stored = assetCardDraftOf(asset);
const placement = { location: asset.location, propertyId: asset.propertyId };

describe('asset card draft', () => {
  it('starts from the stored asset and compares without surrounding spaces', () => {
    expect(stored.inventoryNumber).toBe('MJ-2024-017');
    expect(stored.location).toBe(`property:${asset.location?.id}`);
    expect(stored.acquisitionValue).toBe('');
    expect(sameAssetCardDraft(stored, { ...stored, note: '  Střešní instalace ' })).toBe(true);
    expect(sameAssetCardDraft(stored, { ...stored, name: 'Venkovní jednotka 2' })).toBe(false);
    expect(sameAssetCardDraft(stored, { ...stored, kind: 'building' })).toBe(false);
    expect(sameAssetCardDraft(stored, { ...stored, location: 'unit:u-1' })).toBe(false);
  });

  it('never saves a card without a name or a category', () => {
    const missingName = { ...stored, name: '  ' };
    const missingCategory = { ...stored, category: '' };
    expect(assetCardProblems(missingName).name).toBe(true);
    expect(Option.isNone(assetCardUpdateCommandOf(missingName, asset, placement))).toBe(true);
    expect(Option.isNone(assetCardUpdateCommandOf(missingCategory, asset, placement))).toBe(true);
    expect(Option.isNone(assetCardCreateCommandOf({ ...missingName, inventoryNumber: 'MJ-2024-018' }, placement))).toBe(
      true,
    );
  });

  it('sends the trimmed card on update and keeps the fixed inventory number out of it', () => {
    const command = Option.getOrThrow(
      assetCardUpdateCommandOf({ ...stored, name: '  Venkovní jednotka A  ', serialNumber: '  ' }, asset, placement),
    );
    expect(command).toMatchObject({
      assetId: asset.id,
      location: asset.location,
      name: 'Venkovní jednotka A',
      propertyId: asset.propertyId,
    });
    expect('inventoryNumber' in command).toBe(false);
    expect('serialNumber' in command).toBe(false);
  });

  it('creates a new asset with the typed amount, and only with it', () => {
    const draft: AssetCardDraft = {
      ...assetCardDraftOf(),
      acquisitionValue: '12 500,50',
      category: 'Nábytek',
      inventoryNumber: 'MJ-2024-018',
      name: 'Konferenční stůl',
    };
    const command = Option.getOrThrow(assetCardCreateCommandOf(draft, placement));
    expect(command).toMatchObject({
      acquisitionMethod: 'purchase',
      acquisitionValueMinor: 1_250_050,
      inventoryNumber: 'MJ-2024-018',
      name: 'Konferenční stůl',
    });
    expect('responsible' in command).toBe(false);
    expect(assetCardProblems({ ...draft, acquisitionValue: '12,5,0' }).amount).toBe(true);
    expect(Option.isNone(assetCardCreateCommandOf({ ...draft, acquisitionValue: 'abc' }, placement))).toBe(true);
    const noAmount = Option.getOrThrow(assetCardCreateCommandOf({ ...draft, acquisitionValue: '' }, placement));
    expect('acquisitionValueMinor' in noAmount).toBe(false);
  });
});

const panel = Effect.fnUntraced(function* panel(outcome: SaveOutcome) {
  const sent: AssetCardDraft[] = [];
  const controller = yield* startDraftSave(stored, {
    equals: sameAssetCardDraft,
    isValid: (value: AssetCardDraft) => Option.isSome(assetCardUpdateCommandOf(value, asset, placement)),
    save: (value: AssetCardDraft) => Effect.sync(() => sent.push(value)).pipe(Effect.as(outcome)),
  });
  return { controller, sent };
});

describe('asset card edit explicit save', () => {
  it.effect('sends a typed name only on Save, once; an empty category stays local', () =>
    Effect.gen(function* typed() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, category: '' });
      controller.save();
      expect(controller.status()).toBe('invalid');
      expect(draftSavable(controller.status())).toBe(false);
      controller.change({ ...stored, note: 'Vyměněno 2026' });
      // Longer than any delay the panel ever saved after: typing alone sends nothing.
      yield* TestClock.adjust('1 minute');
      expect(sent).toEqual([]);
      expect(controller.status()).toBe('dirty');
      controller.save();
      controller.save();
      yield* Effect.yieldNow;
      expect(sent.map(({ note }) => note)).toEqual(['Vyměněno 2026']);
      expect(controller.status()).toBe('saved');
    }),
  );

  it.effect('discard goes back to the confirmed draft and sends nothing', () =>
    Effect.gen(function* discarded() {
      const { controller, sent } = yield* panel('saved');
      controller.change({ ...stored, note: 'Vyměněno 2026' });
      expect(controller.status()).toBe('dirty');
      controller.discard();
      expect(controller.status()).toBe('idle');
      expect(controller.confirmed()).toBe(stored);
      yield* TestClock.adjust('1 minute');
      expect(sent).toEqual([]);
    }),
  );

  it.effect('holds a conflicting draft instead of sending it again', () =>
    Effect.gen(function* conflict() {
      const { controller, sent } = yield* panel('conflict');
      controller.change({ ...stored, responsible: 'Petr Svoboda' });
      controller.save();
      yield* Effect.yieldNow;
      expect(controller.status()).toBe('conflict');
      controller.change({ ...stored, responsible: 'Petr Svoboda ml.' });
      yield* TestClock.adjust('1 second');
      expect(sent).toHaveLength(1);
    }),
  );
});
