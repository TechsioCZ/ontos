import { PersistenceFailure, scopedRoutineInvokerFromTransaction } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CurrentStorefrontApplicationRequestSchema } from '@app/storefront-registry-contracts';
import { currentStorefrontApplicationPersistence } from '../../src/persistence/current-storefront-application-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const request = Schema.decodeSync(CurrentStorefrontApplicationRequestSchema)({
  effectiveAt: '2026-09-22T10:00:00.000Z',
  requestedChannel: 'B2C',
  storefrontAppId: 'shop-cz',
  tenantId,
});
const current = {
  allowedChannels: ['B2C'],
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: null,
  generation: 7,
  lifecycle: 'ACTIVE',
  observedAt: '2026-09-22T09:59:59.000Z',
  revision: 3,
};
interface RegistryWireRow {
  readonly payload: object;
}
const loadRows = (rows: readonly RegistryWireRow[], trustedTenantId = tenantId) =>
  currentStorefrontApplicationPersistence(
    scopedRoutineInvokerFromTransaction(() => Effect.succeed(rows), {
      tenantId: trustedTenantId,
    }),
    trustedTenantId,
  ).load(request);

it.effect('decodes native found rows with null and finite ends after Core Type validation', () =>
  Effect.gen(function* foundRawRows() {
    const open = yield* loadRows([{ payload: { _tag: 'found', current } }]);
    expect(Option.getOrThrow(open.snapshot).effectiveTo).toBeUndefined();
    const finite = yield* loadRows([
      { payload: { _tag: 'found', current: { ...current, effectiveTo: '2026-10-01T00:00:00.000Z' } } },
    ]);
    expect(Option.getOrThrow(finite.snapshot).effectiveTo).toBe('2026-10-01T00:00:00.000Z');
    expect(finite.generation).toBe(7);
  }),
);
it.effect('preserves native not-found authority without inventing a registration', () =>
  Effect.gen(function* missingRegistration() {
    const result = yield* loadRows([{ payload: { _tag: 'not_found', generation: 0, observedAt: current.observedAt } }]);
    expect(Option.isNone(result.snapshot)).toBe(true);
    expect(result.generation).toBe(0);
  }),
);
for (const [name, invalid] of Object.entries({
  channel: { ...current, allowedChannels: ['INVALID'] },
  end: { ...current, effectiveTo: 'invalid-date' },
  generation: { ...current, generation: -1 },
  lifecycle: { ...current, lifecycle: 'INVALID' },
  nullable: { ...current, effectiveTo: 3 },
  observedAt: { ...current, observedAt: 'invalid-date' },
  revision: { ...current, revision: 0 },
  start: { ...current, effectiveFrom: 'invalid-date' },
})) {
  it.effect(`rejects malformed native ${name} with the existing persistence failure`, () =>
    Effect.gen(function* invalidRawRow() {
      const failure = yield* loadRows([{ payload: { _tag: 'found', current: invalid } }]).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(PersistenceFailure);
    }),
  );
}
it.effect('rejects unknown tags, empty rows and a mismatching trusted Tenant', () =>
  Effect.gen(function* invalidNativeEnvelope() {
    for (const rows of [[], [{ payload: { _tag: 'unknown' } }]]) {
      expect(yield* loadRows(rows).pipe(Effect.flip)).toBeInstanceOf(PersistenceFailure);
    }
    const mismatch = yield* loadRows(
      [{ payload: { _tag: 'found', current } }],
      '33333333-3333-4333-8333-333333333333',
    ).pipe(Effect.flip);
    expect(mismatch).toBeInstanceOf(PersistenceFailure);
  }),
);
