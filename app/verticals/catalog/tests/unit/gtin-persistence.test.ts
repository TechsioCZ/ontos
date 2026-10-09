import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  commercialGtinAssignmentRevisions,
  commercialGtinAssignments,
  packageDefinitions,
  productVariants,
} from '../../src/database/schema.ts';
import type { products } from '../../src/database/schema.ts';
import { gtinPersistenceForScope } from '../../src/persistence/gtin-persistence.ts';
import type { GtinPersistenceOutcome } from '../../src/persistence/gtin-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const packageDefinitionId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:gtin-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'gtin-test',
};
const input = {
  actionInvocationId: '77777777-7777-4777-8777-777777777777',
  attributionEvidenceRef: 'provider-record:confirmed-unit',
  code: '4006381333931',
  effectiveAt: new Date('2026-09-01T00:00:00.000Z'),
  expectedRevision: 0,
  principalId,
  reason: 'Verified exact trade item',
  target: { kind: 'VARIANT' as const, tenantId, variantId },
};
type Table =
  | typeof commercialGtinAssignments
  | typeof commercialGtinAssignmentRevisions
  | typeof packageDefinitions
  | typeof productVariants
  | typeof products;

type Row = Readonly<Record<string, string | number | Date | null>>;
interface FixtureOptions {
  existing?: Row;
  packageState?: string;
  prior?: Row;
  revisionRows?: readonly (readonly Row[])[];
  variantState?: string;
}
type GtinWrite = typeof commercialGtinAssignments.$inferInsert | typeof commercialGtinAssignmentRevisions.$inferInsert;
const rowsFor = (table: Table, options: FixtureOptions, revisionRead: number): readonly Row[] => {
  if (table === commercialGtinAssignmentRevisions) {
    return options.revisionRows?.[revisionRead] ?? (options.prior ? [options.prior] : []);
  }
  if (table === commercialGtinAssignments) {
    return options.existing ? [options.existing] : [];
  }
  if (table === packageDefinitions) {
    return [{ lifecycleState: options.packageState ?? 'ACTIVE', packageDefinitionId, productId, variantId }];
  }
  if (table === productVariants) {
    return [{ lifecycleState: options.variantState ?? 'ACTIVE', productId, variantId }];
  }
  return [{ lifecycleState: 'ACTIVE', productId }];
};
const list = (rows: readonly Row[]) => ({ limit: () => Effect.succeed(rows) });
const selected = (rows: readonly Row[]) => ({ for: () => list(rows), limit: () => Effect.succeed(rows) });
const returning = (writes: object[], table: Table, value: GtinWrite) => ({
  returning: () => {
    writes.push([table, value]);
    return Effect.succeed([{ currentRevision: 2 }]);
  },
});
const fixture = (writes: object[], options: FixtureOptions = {}) => {
  let revisionRead = 0;
  const nextRows = (table: Table) => {
    const rows = rowsFor(table, options, revisionRead);
    if (table === commercialGtinAssignmentRevisions) {
      revisionRead += 1;
    }
    return rows;
  };
  return {
    insert: (table: Table) => ({
      values: (value: GtinWrite) => {
        writes.push([table, value]);
        return Effect.succeed([]);
      },
    }),
    select: () => ({
      from: (table: Table) => ({
        where: () => selected(nextRows(table)),
      }),
    }),
    update: (table: Table) => ({ set: (value: GtinWrite) => ({ where: () => returning(writes, table, value) }) }),
  };
};
const outcomeKind = (outcome: GtinPersistenceOutcome): string =>
  Match.value(outcome).pipe(
    Match.tag('confirmed', () => 'confirmed'),
    Match.tag('corrected', () => 'corrected'),
    Match.tag('invalid', () => 'invalid'),
    Match.tag('not_found', () => 'not_found'),
    Match.tag('retired', () => 'retired'),
    Match.tag('stale', () => 'stale'),
    Match.tag('unresolved', () => 'unresolved'),
    Match.exhaustive,
  );

describe('GTIN exact-target persistence', () => {
  it.effect('confirms a Variant with exact digits and retained evidence', () =>
    Effect.gen(function* confirmsVariant() {
      const writes: object[] = [];
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes), scope);
      const outcome = yield* service.confirm(input);
      expect(outcomeKind(outcome)).toBe('confirmed');
      expect('revision' in outcome && outcome.revision).toBe(1);
      expect(writes).toEqual([
        [
          commercialGtinAssignments,
          expect.objectContaining({ gtin: input.code, packageDefinitionId: null, state: 'CONFIRMED' }),
        ],
        [
          commercialGtinAssignmentRevisions,
          expect.objectContaining({ attributionEvidenceRef: input.attributionEvidenceRef, revision: 1 }),
        ],
      ]);
    }),
  );

  it.effect('identifies a package level without requiring a Package Option role', () =>
    Effect.gen(function* confirmsPackage() {
      const writes: object[] = [];
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes), scope);
      const outcome = yield* service.confirm({
        ...input,
        code: '10012345678902',
        target: { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId },
      });
      expect(outcomeKind(outcome)).toBe('confirmed');
      expect('revision' in outcome && outcome.revision).toBe(1);
      expect(writes[0]).toEqual([commercialGtinAssignments, expect.objectContaining({ packageDefinitionId })]);
    }),
  );

  it.effect('rejects invalid digits, cross-tenant, stale and retired targets without writing', () =>
    Effect.gen(function* rejectsInvalid() {
      const writes: object[] = [];
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { variantState: 'RETIRED' }), scope);
      expect(outcomeKind(yield* service.confirm({ ...input, code: '4006381333932' }))).toBe('invalid');
      expect(
        outcomeKind(yield* service.confirm({ ...input, target: { ...input.target, tenantId: principalId } })),
      ).toBe('invalid');
      expect(outcomeKind(yield* service.confirm(input))).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('replays the same invocation without another revision and rejects changed evidence', () =>
    Effect.gen(function* replay() {
      const writes: object[] = [];
      const prior = {
        actingPrincipalId: principalId,
        actionInvocationId: input.actionInvocationId,
        attributionEvidenceRef: input.attributionEvidenceRef,
        effectiveAt: input.effectiveAt,
        gtin: input.code,
        packageDefinitionId: null,
        productId,
        reason: input.reason,
        revision: 1,
        state: 'CONFIRMED',
        variantId,
      };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { prior }), scope);
      expect(outcomeKind(yield* service.confirm(input))).toBe('confirmed');
      expect(outcomeKind(yield* service.confirm({ ...input, reason: 'Different evidence' }))).toBe('invalid');
      expect(outcomeKind(yield* service.confirm({ ...input, expectedRevision: 1 }))).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('preserves a retained GTIN when the requested target differs', () =>
    Effect.gen(function* preservesTarget() {
      const writes: object[] = [];
      const existing = {
        currentRevision: 1,
        packageDefinitionId: null,
        productId,
        state: 'CONFIRMED',
        variantId: '99999999-9999-4999-8999-999999999999',
      };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { existing }), scope);
      expect(outcomeKind(yield* service.confirm({ ...input, expectedRevision: 1 }))).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('keeps confirmation a first assignment, even when the retained target is identical', () =>
    Effect.gen(function* rejectsSecondConfirmation() {
      const writes: object[] = [];
      const existing = { currentRevision: 1, packageDefinitionId: null, productId, state: 'CONFIRMED', variantId };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { existing }), scope);
      expect(outcomeKind(yield* service.confirm({ ...input, expectedRevision: 1 }))).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('corrects a documented attribution while retaining the previous revision', () =>
    Effect.gen(function* correctsAttribution() {
      const writes: object[] = [];
      const existing = { currentRevision: 1, packageDefinitionId: null, productId, state: 'CONFIRMED', variantId };
      const head = { ...existing, attributionEvidenceRef: input.attributionEvidenceRef, revision: 1 };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { existing, revisionRows: [[], [head]] }), scope);
      const result = yield* service.correct({
        ...input,
        attributionEvidenceRef: 'provider-record:corrected-package',
        expectedRevision: 1,
        previousTarget: input.target,
        reason: 'Documented provider attribution error',
        supersededEvidenceRef: input.attributionEvidenceRef,
        target: { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId },
      });
      expect(outcomeKind(result)).toBe('corrected');
      expect(writes).toEqual([
        [
          commercialGtinAssignments,
          expect.objectContaining({ currentRevision: 2, packageDefinitionId, state: 'CONFIRMED' }),
        ],
        [
          commercialGtinAssignmentRevisions,
          expect.objectContaining({
            attributionEvidenceRef: 'provider-record:corrected-package',
            packageDefinitionId,
            revision: 2,
          }),
        ],
      ]);
    }),
  );

  it.effect('rejects correction without matching prior evidence or exact previous target', () =>
    Effect.gen(function* rejectsUnprovenCorrection() {
      const writes: object[] = [];
      const existing = { currentRevision: 1, packageDefinitionId: null, productId, state: 'CONFIRMED', variantId };
      const head = { ...existing, attributionEvidenceRef: input.attributionEvidenceRef, revision: 1 };
      const correction = {
        ...input,
        attributionEvidenceRef: 'provider-record:corrected-package',
        expectedRevision: 1,
        previousTarget: input.target,
        supersededEvidenceRef: 'wrong-evidence',
        target: { kind: 'PACKAGE_LEVEL' as const, packageDefinitionId, tenantId },
      };
      const service = gtinPersistenceForScope(
        // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
        fixture(writes, { existing, revisionRows: [[], [head], [], [head]] }),
        scope,
      );
      expect(outcomeKind(yield* service.correct(correction))).toBe('invalid');
      expect(
        outcomeKind(
          yield* service.correct({
            ...correction,
            previousTarget: { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId },
            supersededEvidenceRef: input.attributionEvidenceRef,
          }),
        ),
      ).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('rejects a correction replay with a changed expected revision', () =>
    Effect.gen(function* rejectsChangedCorrectionIntent() {
      const writes: object[] = [];
      const correction = {
        ...input,
        attributionEvidenceRef: 'provider-record:corrected-package',
        expectedRevision: 1,
        previousTarget: input.target,
        supersededEvidenceRef: input.attributionEvidenceRef,
        target: { kind: 'PACKAGE_LEVEL' as const, packageDefinitionId, tenantId },
      };
      const prior = {
        actingPrincipalId: principalId,
        actionInvocationId: input.actionInvocationId,
        attributionEvidenceRef: correction.attributionEvidenceRef,
        effectiveAt: input.effectiveAt,
        gtin: input.code,
        packageDefinitionId,
        productId,
        reason: input.reason,
        revision: 2,
        state: 'CONFIRMED',
        variantId,
      };
      const before = {
        ...prior,
        attributionEvidenceRef: input.attributionEvidenceRef,
        packageDefinitionId: null,
        revision: 1,
      };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { prior, revisionRows: [[prior], [before]] }), scope);
      expect(outcomeKind(yield* service.correct({ ...correction, expectedRevision: 2 }))).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('marks a disputed GTIN unresolved and then retires without changing its target', () =>
    Effect.gen(function* changesLifecycle() {
      const writes: object[] = [];
      const existing = { currentRevision: 1, packageDefinitionId: null, productId, state: 'CONFIRMED', variantId };
      const head = { ...existing, attributionEvidenceRef: input.attributionEvidenceRef, revision: 1 };
      const service = gtinPersistenceForScope(
        // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
        fixture(writes, { existing, revisionRows: [[], [head], [], [head]] }),
        scope,
      );
      const lifecycle = {
        ...input,
        attributionEvidenceRef: 'case:disputed-gtin',
        expectedRevision: 1,
        previousTarget: input.target,
        supersededEvidenceRef: input.attributionEvidenceRef,
      };
      expect(outcomeKind(yield* service.markUnresolved(lifecycle))).toBe('unresolved');
      expect(
        outcomeKind(
          yield* service.retire({ ...lifecycle, actionInvocationId: '88888888-8888-4888-8888-888888888888' }),
        ),
      ).toBe('retired');
      expect(writes).toEqual([
        [commercialGtinAssignments, expect.objectContaining({ packageDefinitionId: null, state: 'UNRESOLVED' })],
        [commercialGtinAssignmentRevisions, expect.objectContaining({ revision: 2, state: 'UNRESOLVED' })],
        [commercialGtinAssignments, expect.objectContaining({ packageDefinitionId: null, state: 'RETIRED' })],
        [commercialGtinAssignmentRevisions, expect.objectContaining({ revision: 2, state: 'RETIRED' })],
      ]);
    }),
  );

  it.effect('never corrects a retired GTIN into a new attribution', () =>
    Effect.gen(function* rejectsRetiredCorrection() {
      const writes: object[] = [];
      const existing = { currentRevision: 2, packageDefinitionId: null, productId, state: 'RETIRED', variantId };
      // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
      const service = gtinPersistenceForScope(fixture(writes, { existing }), scope);
      const result = yield* service.correct({
        ...input,
        attributionEvidenceRef: 'provider-record:corrected-package',
        expectedRevision: 2,
        previousTarget: input.target,
        supersededEvidenceRef: input.attributionEvidenceRef,
        target: { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId },
      });
      expect(outcomeKind(result)).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );

  it.effect('does not change lifecycle without matching exact target and superseded evidence', () =>
    Effect.gen(function* rejectsUnprovenLifecycle() {
      const writes: object[] = [];
      const existing = { currentRevision: 1, packageDefinitionId: null, productId, state: 'CONFIRMED', variantId };
      const head = { ...existing, attributionEvidenceRef: input.attributionEvidenceRef, revision: 1 };
      const service = gtinPersistenceForScope(
        // @ts-expect-error Mock covers the exercised scoped Drizzle chain.
        fixture(writes, { existing, revisionRows: [[], [head], [], [head]] }),
        scope,
      );
      const lifecycle = {
        ...input,
        attributionEvidenceRef: 'case:disputed-gtin',
        expectedRevision: 1,
        previousTarget: input.target,
        supersededEvidenceRef: 'wrong-proof',
      };
      expect(outcomeKind(yield* service.markUnresolved(lifecycle))).toBe('invalid');
      expect(
        outcomeKind(
          yield* service.retire({
            ...lifecycle,
            actionInvocationId: '88888888-8888-4888-8888-888888888888',
            previousTarget: { kind: 'PACKAGE_LEVEL', packageDefinitionId, tenantId },
            supersededEvidenceRef: input.attributionEvidenceRef,
          }),
        ),
      ).toBe('invalid');
      expect(writes).toEqual([]);
    }),
  );
});
