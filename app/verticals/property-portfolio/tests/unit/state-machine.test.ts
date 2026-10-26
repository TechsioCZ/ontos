import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { PropertyDateSchema, PropertyStateSchema } from '../../shared/apis/records.ts';
import { isStaffOnlyPropertyCommand, PropertyCommandSchema } from '../../shared/actions/apply-command.ts';
import type { PropertyState } from '../../shared/apis/records.ts';
import { applyPropertyCommand } from '../../src/services/persistence.service.ts';

const context = {
  legalEntityId: '71000000-0000-4000-8000-000000000020',
  now: '2026-10-06T09:00:00.000Z',
  resourceId: '74000000-0000-4000-8000-000000000020',
  tenantId: '70000000-0000-4000-8000-000000000020',
};
const empty: PropertyState = { assets: [], properties: [], units: [] };
const create = { _tag: 'CreateProperty', address: 'Parková 12', code: 'PARK', name: 'Parková' } as const;

describe('Property owner transitions', () => {
  it.effect('creates a planned Property bound to the actual Legal Entity and rejects duplicate business codes', () =>
    Effect.gen(function* propertyScenario() {
      const first = yield* applyPropertyCommand(empty, create, context);
      expect(first.state.properties[0]?.legalEntityRef.resourceId).toBe(context.legalEntityId);
      expect(first.state.properties[0]?.lifecycleState).toBe('PLANNED');
      expect(first.state.properties[0]?.createdAt).toBe(context.now);
      const duplicate = yield* Effect.exit(
        applyPropertyCommand(first.state, create, { ...context, resourceId: '75000000-0000-4000-8000-000000000020' }),
      );
      expect(Exit.isFailure(duplicate)).toBe(true);
    }),
  );

  it.effect('rejects cross-tenant and missing parent references before creating a Unit', () =>
    Effect.gen(function* propertyScenario() {
      const first = yield* applyPropertyCommand(empty, create, context);
      const { propertyRef } = yield* Effect.fromNullishOr(first.state.properties[0]);
      for (const invalid of [
        { ...propertyRef, tenantId: '70000000-0000-4000-8000-000000000021' },
        { ...propertyRef, resourceId: '75000000-0000-4000-8000-000000000020' },
      ]) {
        const exit = yield* Effect.exit(
          applyPropertyCommand(
            first.state,
            { _tag: 'CreateUnit', capacity: 2, code: 'A101', name: 'A101', propertyRef: invalid },
            context,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect('keeps availability separate from the Unit lifecycle and rejects impossible service dates', () =>
    Effect.gen(function* propertyScenario() {
      const first = yield* applyPropertyCommand(empty, create, context);
      const { propertyRef } = yield* Effect.fromNullishOr(first.state.properties[0]);
      const unit = yield* applyPropertyCommand(
        first.state,
        {
          _tag: 'CreateUnit',
          capacity: 2,
          code: 'A101',
          name: 'A101',
          propertyRef,
        },
        { ...context, resourceId: '75000000-0000-4000-8000-000000000020' },
      );
      expect(unit.state.units[0]?.lifecycleState).toBe('ACTIVE');
      expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(PropertyDateSchema)('2026-02-31')))).toBe(true);
      expect(yield* Schema.decodeEffect(PropertyDateSchema)('2028-02-29')).toBe('2028-02-29');
    }),
  );
});

it.effect('persists property operational metadata on creation and updates without changing its identity', () =>
  Effect.gen(function* propertyMetadata() {
    const created = yield* applyPropertyCommand(
      empty,
      {
        ...create,
        lifecycleState: 'ACTIVE',
        note: 'Areál u parku',
        propertyType: 'Administrativní budova',
        responsiblePerson: 'Jana Novotná',
      },
      context,
    );
    const property = yield* Effect.fromNullishOr(created.state.properties[0]);
    expect(property).toMatchObject({
      lifecycleState: 'ACTIVE',
      note: 'Areál u parku',
      propertyType: 'Administrativní budova',
      responsiblePerson: 'Jana Novotná',
    });
    const updated = yield* applyPropertyCommand(
      created.state,
      {
        _tag: 'UpdateProperty',
        address: property.address,
        name: property.name,
        note: 'Nový správce areálu',
        propertyRef: property.propertyRef,
        responsiblePerson: 'Petr Dvořák',
      },
      context,
    );
    expect(updated.state.properties[0]).toMatchObject({
      lifecycleState: 'ACTIVE',
      note: 'Nový správce areálu',
      propertyRef: property.propertyRef,
      propertyType: 'Administrativní budova',
      responsiblePerson: 'Petr Dvořák',
    });
  }),
);

it.effect('round-trips multiple responsible employees and replaces the selection when a property is edited', () =>
  Effect.gen(function* responsibleEmployees() {
    const employeeIds = ['75000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000002'] as const;
    const command = yield* Schema.decodeEffect(PropertyCommandSchema)({
      ...create,
      responsibleEmployeeIds: employeeIds,
    });
    const created = yield* applyPropertyCommand(empty, command, context);
    const state = yield* Schema.decodeEffect(PropertyStateSchema)(created.state);
    const property = yield* Effect.fromNullishOr(state.properties[0]);
    expect(property.responsibleEmployeeIds).toEqual(employeeIds);
    const updated = yield* applyPropertyCommand(
      state,
      yield* Schema.decodeEffect(PropertyCommandSchema)({
        _tag: 'UpdateProperty',
        address: property.address,
        name: property.name,
        note: property.note,
        propertyRef: property.propertyRef,
        responsibleEmployeeIds: [employeeIds[1]],
      }),
      context,
    );
    const updatedState = yield* Schema.decodeEffect(PropertyStateSchema)(updated.state);
    expect(updatedState.properties[0]?.responsibleEmployeeIds).toEqual([employeeIds[1]]);
    const unchanged = yield* applyPropertyCommand(
      updatedState,
      {
        _tag: 'UpdateProperty',
        address: property.address,
        name: property.name,
        note: property.note,
        propertyRef: property.propertyRef,
      },
      context,
    );
    expect(unchanged.state.properties[0]?.responsibleEmployeeIds).toEqual([employeeIds[1]]);
  }),
);

it.effect('rejects free text and an empty employee selection while retaining legacy property records', () =>
  Effect.gen(function* employeeSelectionValidation() {
    for (const responsibleEmployeeIds of [[], ['Já'], 'Jana Novotná']) {
      const result = yield* Effect.exit(
        Schema.decodeUnknownEffect(PropertyCommandSchema)({ ...create, responsibleEmployeeIds }),
      );
      expect(Exit.isFailure(result)).toBe(true);
    }
    const legacy = yield* applyPropertyCommand(empty, { ...create, responsiblePerson: 'Původní správce' }, context);
    const decoded = yield* Schema.decodeEffect(PropertyStateSchema)(legacy.state);
    expect(decoded.properties[0]?.responsiblePerson).toBe('Původní správce');
    expect(decoded.properties[0]?.responsibleEmployeeIds).toBeUndefined();
  }),
);

it.effect('preserves optional note encoding and staff-only archive classification', () =>
  Effect.gen(function* commandCompatibility() {
    const commands = yield* Effect.forEach(
      [create, { ...create, note: null }, { ...create, note: 'Poznámka' }],
      (input) => Schema.decodeUnknownEffect(PropertyCommandSchema)(input),
    );
    expect(commands).toEqual([create, { ...create, note: null }, { ...create, note: 'Poznámka' }]);
    expect(commands.map(isStaffOnlyPropertyCommand)).toEqual([false, false, false]);
    const created = yield* applyPropertyCommand(empty, create, context);
    const { propertyRef } = yield* Effect.fromNullishOr(created.state.properties[0]);
    for (const raw of [
      { _tag: 'ArchiveProperty', propertyRef, reason: 'Test' },
      { _tag: 'RestoreProperty', propertyRef },
    ]) {
      const command = yield* Schema.decodeUnknownEffect(PropertyCommandSchema)(raw);
      expect(isStaffOnlyPropertyCommand(command)).toBe(true);
    }
  }),
);

describe('Units of disposed properties', () => {
  it.effect('S02: disposing a Property retires its Units and keeps them from being reactivated', () =>
    Effect.gen(function* disposeScenario() {
      const first = yield* applyPropertyCommand(empty, create, context);
      const { propertyRef } = yield* Effect.fromNullishOr(first.state.properties[0]);
      const unitContext = { ...context, resourceId: '76000000-0000-4000-8000-000000000020' };
      const unit = yield* applyPropertyCommand(
        first.state,
        { _tag: 'CreateUnit', capacity: null, code: 'SD01', name: 'Servisní místnost', propertyRef },
        unitContext,
      );
      const disposed = yield* applyPropertyCommand(
        unit.state,
        { _tag: 'ChangePropertyLifecycle', lifecycleState: 'DISPOSED', propertyRef },
        context,
      );
      expect(disposed.state.units[0]?.lifecycleState).toBe('RETIRED');
      const unitRef = yield* Effect.fromNullishOr(disposed.state.units[0]?.unitRef);
      const reactivate = yield* Effect.exit(
        applyPropertyCommand(
          disposed.state,
          { _tag: 'ChangeUnitLifecycle', lifecycleState: 'ACTIVE', unitRef },
          context,
        ),
      );
      expect(Exit.isFailure(reactivate)).toBe(true);
      const outOfService = yield* applyPropertyCommand(
        unit.state,
        { _tag: 'ChangeUnitLifecycle', lifecycleState: 'RETIRED', unitRef },
        context,
      );
      expect(outOfService.state.units[0]?.lifecycleState).toBe('RETIRED');
    }),
  );
});

describe('Staff archive of demo records', () => {
  it.effect('archives a property out of operation with its units, freezes them and restores them together', () =>
    Effect.gen(function* archiveScenario() {
      const archiveContext = { ...context, principalId: '72000000-0000-4000-8000-000000000021' };
      const first = yield* applyPropertyCommand(empty, create, context);
      const { propertyRef } = yield* Effect.fromNullishOr(first.state.properties[0]);
      const unit = yield* applyPropertyCommand(
        first.state,
        { _tag: 'CreateUnit', capacity: null, code: 'V01', name: 'Vrátnice', propertyRef },
        { ...context, resourceId: '76000000-0000-4000-8000-000000000021' },
      );
      const active = yield* applyPropertyCommand(
        unit.state,
        { _tag: 'ChangePropertyLifecycle', lifecycleState: 'ACTIVE', propertyRef },
        context,
      );
      const refused = yield* Effect.exit(
        applyPropertyCommand(active.state, { _tag: 'ArchiveProperty', propertyRef, reason: 'Test' }, archiveContext),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      const archived = yield* applyPropertyCommand(
        unit.state,
        { _tag: 'ArchiveProperty', propertyRef, reason: 'Testovací záznam' },
        archiveContext,
      );
      expect(archived.state.properties[0]?.archive?.archivedBy).toBe(archiveContext.principalId);
      expect(archived.state.units[0]?.lifecycleState).toBe('RETIRED');
      expect(archived.state.units[0]?.archive?.reason).toBe('Testovací záznam');
      const unitRef = yield* Effect.fromNullishOr(archived.state.units[0]?.unitRef);
      const frozen = yield* Effect.exit(
        applyPropertyCommand(
          archived.state,
          { _tag: 'ChangeUnitLifecycle', lifecycleState: 'OUT_OF_SERVICE', unitRef },
          context,
        ),
      );
      expect(Exit.isFailure(frozen)).toBe(true);
      const restored = yield* applyPropertyCommand(archived.state, { _tag: 'RestoreProperty', propertyRef }, context);
      expect(restored.state.properties[0]?.archive).toBeUndefined();
      expect(restored.state.units[0]?.archive).toBeUndefined();
      expect(restored.state.units[0]?.lifecycleState).toBe('RETIRED');
    }),
  );

  it.effect('archives only retired units', () =>
    Effect.gen(function* unitArchiveScenario() {
      const first = yield* applyPropertyCommand(empty, create, context);
      const { propertyRef } = yield* Effect.fromNullishOr(first.state.properties[0]);
      const unit = yield* applyPropertyCommand(
        first.state,
        { _tag: 'CreateUnit', capacity: null, code: 'C01', name: 'Hala C', propertyRef },
        { ...context, resourceId: '76000000-0000-4000-8000-000000000022' },
      );
      const unitRef = yield* Effect.fromNullishOr(unit.state.units[0]?.unitRef);
      const refused = yield* Effect.exit(
        applyPropertyCommand(unit.state, { _tag: 'ArchiveUnit', reason: 'Test', unitRef }, context),
      );
      expect(Exit.isFailure(refused)).toBe(true);
      const retired = yield* applyPropertyCommand(
        unit.state,
        { _tag: 'ChangeUnitLifecycle', lifecycleState: 'RETIRED', unitRef },
        context,
      );
      const archived = yield* applyPropertyCommand(
        retired.state,
        { _tag: 'ArchiveUnit', reason: 'Test', unitRef },
        context,
      );
      expect(archived.state.units[0]?.archive?.reason).toBe('Test');
      const asset = {
        _tag: 'CreateAsset',
        category: 'Vybavení',
        code: 'ASSET-ARCHIVE',
        name: 'Testovací vybavení',
        propertyRef,
        unitRef,
      } as const;
      const blockedAsset = yield* Effect.exit(applyPropertyCommand(archived.state, asset, context));
      expect(Exit.isFailure(blockedAsset)).toBe(true);
      const restored = yield* applyPropertyCommand(archived.state, { _tag: 'RestoreUnit', unitRef }, context);
      const allowedAsset = yield* applyPropertyCommand(restored.state, asset, context);
      expect(allowedAsset.state.assets[0]?.unitRef).toEqual(unitRef);
    }),
  );
});
