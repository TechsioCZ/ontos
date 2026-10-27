import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { assetsAtLocation } from '../../shared/domain/asset-location.ts';
import { AssetsStateSchema, currentServiceRecords, upcomingServiceDue } from '../../shared/domain/assets.ts';
import { seedAssetsState } from '../../scripts/seed/assets.mts';

const riverside = '6a0197b3-4b13-46c5-a3ab-8dbb46dda58e';
const r101 = 'bf65f06e-fe64-4787-813f-6a62bad12409';

it.effect('R101 equipment comes from registered unit locations, never sibling units', () =>
  Effect.gen(function* unitEquipment() {
    const state = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
    const rows = assetsAtLocation(state.assets, riverside, r101);
    expect(rows.some((asset) => asset.inventoryNumber === 'VYB-005' && asset.currentValueMinor === 14_200_000)).toBe(
      true,
    );
    expect(rows.every((asset) => asset.location?.kind === 'unit' && asset.location.id === r101)).toBe(true);
    expect(assetsAtLocation(state.assets, riverside, 'unknown-unit')).toEqual([]);
  }),
);

it.effect('building equipment includes unit assets but excludes other properties', () =>
  Effect.gen(function* buildingEquipment() {
    const state = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
    const rows = assetsAtLocation(state.assets, riverside);
    expect(rows.some((asset) => asset.inventoryNumber === 'VYB-005')).toBe(true);
    expect(rows.some((asset) => asset.inventoryNumber === 'BUD-002')).toBe(true);
    expect(rows.every((asset) => asset.propertyId === riverside)).toBe(true);
    expect(assetsAtLocation(state.assets, 'unknown-property')).toEqual([]);
  }),
);

it.effect('Riverside electrical revision matches its 2026 PDF and supersedes only the older deadline', () =>
  Effect.gen(function* revisionEvidence() {
    const state = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
    const building = state.assets.find((asset) => asset.inventoryNumber === 'BUD-002');
    expect(building).toBeDefined();
    if (building === undefined) {
      return;
    }
    const revision = currentServiceRecords(building).find(
      (record) => record.title === 'Revize elektroinstalace (budova)',
    );
    expect(revision?.performedOn).toBe('2026-09-18');
    expect(revision?.nextDueOn).toBe('2029-09-18');
    expect(revision?.documentRef).toBe('Revizní zpráva elektro – Riverside 2026');
    expect(revision?.result).toBe('defects');
    expect(revision?.supplier).toBe('Ing. Pavel Šťastný');
    expect(building.services?.some((record) => record.performedOn === '2023-11-18')).toBe(true);
    const deadlines = upcomingServiceDue(state).filter((record) => record.assetId === building.id);
    expect(deadlines.some((record) => record.nextDueOn === '2026-11-18')).toBe(false);
    expect(deadlines.some((record) => record.nextDueOn === '2026-12-15')).toBe(true);
  }),
);
