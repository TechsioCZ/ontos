import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';

import { PropertyDateSchema } from '../../shared/apis/records.ts';
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
        propertyType: 'Administrativní budova',
        responsiblePerson: 'Jana Novotná',
        note: 'Areál u parku',
        lifecycleState: 'ACTIVE',
      },
      context,
    );
    const property = yield* Effect.fromNullishOr(created.state.properties[0]);
    expect(property).toMatchObject({
      propertyType: 'Administrativní budova',
      responsiblePerson: 'Jana Novotná',
      note: 'Areál u parku',
      lifecycleState: 'ACTIVE',
    });
    const updated = yield* applyPropertyCommand(
      created.state,
      {
        _tag: 'UpdateProperty',
        propertyRef: property.propertyRef,
        name: property.name,
        address: property.address,
        note: 'Nový správce areálu',
        responsiblePerson: 'Petr Dvořák',
      },
      context,
    );
    expect(updated.state.properties[0]).toMatchObject({
      propertyType: 'Administrativní budova',
      responsiblePerson: 'Petr Dvořák',
      note: 'Nový správce areálu',
      lifecycleState: 'ACTIVE',
      propertyRef: property.propertyRef,
    });
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
    }),
  );
});
