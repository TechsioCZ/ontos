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
