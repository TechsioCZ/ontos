import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { seedAssetsState } from '../../verticals/facility-operations/scripts/seed/assets.mts';
import { AssetsStateSchema } from '../../verticals/facility-operations/shared/domain/assets.ts';
import { PropertyRecordSchema } from '../../verticals/property-portfolio/shared/apis/records.ts';
import { demoTenantId, rentalDemoLegalEntityId } from '../demo/fixture-ids.mts';
import { assetRepairCommand, assetRepairFingerprint, selectAssetRepair } from '../demo/siampark-assets-stage.mts';

const propertyId = '528cd143-ef28-4b23-bebf-340ab530af8d';
const sample = Effect.gen(function* sampleRepair() {
  const state = yield* Schema.decodeUnknownEffect(AssetsStateSchema)(seedAssetsState());
  const property = yield* Schema.decodeUnknownEffect(PropertyRecordSchema)({
    address: 'Nábřežní 12, Praha',
    code: 'RIVERSIDE',
    createdAt: '2026-10-26T09:00:00Z',
    legalEntityRef: {
      moduleId: 'core.identity',
      resourceId: rentalDemoLegalEntityId,
      resourceType: 'core.identity.legal-entity',
      tenantId: demoTenantId,
    },
    lifecycleState: 'ACTIVE',
    name: 'Riverside Office Park',
    note: null,
    propertyRef: {
      moduleId: 'property.portfolio',
      resourceId: propertyId,
      resourceType: 'property.portfolio.property',
      tenantId: demoTenantId,
    },
    updatedAt: '2026-10-26T09:00:00Z',
  });
  return { property, state };
});

it.effect('repairs only the exact active BUD-002 and resolves its destination by scoped code/name', () =>
  Effect.gen(function* exactRepair() {
    const { property, state } = yield* sample;
    const selected = yield* selectAssetRepair(state.assets, [property]);
    expect(selected.asset.inventoryNumber).toBe('BUD-002');
    const command = yield* assetRepairCommand(selected.asset, property);
    expect(command.location).toEqual({ id: propertyId, kind: 'property', label: 'Riverside Office Park (RIVERSIDE)' });
    expect(command.propertyId).toBe(propertyId);
    expect(command.assetId).toBe(selected.asset.id);
    expect(command.name).toBe(selected.asset.name);
    expect(command.category).toBe(selected.asset.category);
    expect(command.note).toBe(selected.asset.note);
    expect(command.responsible).toBe(selected.asset.responsible);
    expect(command.serialNumber).toBe(selected.asset.serialNumber);
    expect(command.accountingProduct).toBe(selected.asset.accountingProduct);
    expect(command).not.toHaveProperty('currentValueMinor');
    expect(command).not.toHaveProperty('depreciationPlans');
    expect(command).not.toHaveProperty('events');
  }),
);

it.effect('fails closed on duplicate, missing, inactive or foreign-company property targets', () =>
  Effect.gen(function* rejectAmbiguity() {
    const { property, state } = yield* sample;
    for (const candidates of [
      [],
      [property, property],
      [{ ...property, lifecycleState: 'INACTIVE' as const }],
      [{ ...property, legalEntityRef: { ...property.legalEntityRef, resourceId: demoTenantId } }],
      [{ ...property, propertyRef: { ...property.propertyRef, tenantId: rentalDemoLegalEntityId } }],
    ]) {
      expect(Exit.isFailure(yield* Effect.exit(selectAssetRepair(state.assets, candidates)))).toBe(true);
    }
    const selected = yield* selectAssetRepair(state.assets, [property]);
    expect(Exit.isFailure(yield* Effect.exit(selectAssetRepair([...state.assets, selected.asset], [property])))).toBe(
      true,
    );
    expect(Exit.isFailure(yield* Effect.exit(selectAssetRepair([], [property])))).toBe(true);
  }),
);

it.effect('binds review fingerprint to the whole asset, other records, both revisions and target', () =>
  Effect.gen(function* exactFingerprint() {
    const { property, state } = yield* sample;
    const selected = yield* selectAssetRepair(state.assets, [property]);
    const plan = {
      ...selected,
      company: rentalDemoLegalEntityId,
      otherStateDigest: 'other-state',
      propertyRevision: 1,
      revision: 2,
      tenant: demoTenantId,
    };
    const original = yield* assetRepairFingerprint(plan);
    expect(yield* assetRepairFingerprint(plan)).toBe(original);
    for (const changed of [
      { ...plan, revision: 3 },
      { ...plan, propertyRevision: 3 },
      { ...plan, otherStateDigest: 'changed-state' },
      { ...plan, asset: { ...plan.asset, responsible: 'Jiná osoba' } },
      { ...plan, property: { ...property, propertyRef: { ...property.propertyRef, resourceId: demoTenantId } } },
    ]) {
      expect(yield* assetRepairFingerprint(changed)).not.toBe(original);
    }
  }),
);
