// @effect-diagnostics nodeBuiltinImport:off -- Migration safety is checked against its generated SQL; expires: 2027-03-31.
import { readFileSync } from 'node:fs';

import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CreateConfigurationUnitPayloadSchema } from '../../shared/actions/create-configuration-unit.ts';
import { RetireConfigurationUnitPayloadSchema } from '../../shared/actions/retire-configuration-unit.ts';
import { ReviseConfigurationUnitPayloadSchema } from '../../shared/actions/revise-configuration-unit.ts';
import { configurationUnits } from '../../src/database/schema.ts';
import type { configurationUnitRevisions } from '../../src/database/schema.ts';
import { configurationUnitPersistenceForScope } from '../../src/persistence/configuration-unit-persistence.ts';

it('fails closed instead of remapping purchase Units in existing measured choices', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260918050031_lethal_black_tom/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain('Configuration Unit migration requires verified mapping of existing measured choices');
  expect(migration).toContain('catalog_configuration_choices_unit_fk');
  expect(migration).toContain('configuration_unit_revisions');
  expect(migration).toContain('catalog_configuration_unit_revisions_append_only');
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const unitRef = { moduleId: 'commerce.catalog', resourceId: unitId, resourceType: 'commerce.catalog.unit', tenantId };
const evidence = { actionInvocationId: '44444444-4444-4444-8444-444444444444', principalId };
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:configuration-unit-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'configuration-unit-test',
};
const createPayload = Schema.decodeUnknownSync(CreateConfigurationUnitPayloadSchema)({
  code: 'CM',
  dimension: 'length',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  evidenceRefs: ['owner:engineering:1'],
  meaning: 'Centimetre',
  reason: 'Approved measurement basis',
  unitRef,
});

type UnitTable = typeof configurationUnits | typeof configurationUnitRevisions;
type UnitWrite = typeof configurationUnits.$inferInsert | typeof configurationUnitRevisions.$inferInsert;
const readRows = (rows: readonly UnitWrite[]) => Effect.succeed(rows);
const limited = (rows: readonly UnitWrite[]) => ({ limit: () => readRows(rows) });
const filtered = (rows: readonly UnitWrite[]) => ({
  for: () => limited(rows),
  limit: () => readRows(rows),
  orderBy: () => readRows(rows),
});
const fromTable = (rows: readonly UnitWrite[]) => ({ where: () => filtered(rows) });
const fixture = () => {
  const units: UnitWrite[] = [];
  const revisions: UnitWrite[] = [];
  const rows = (table: UnitTable) => (table === configurationUnits ? units : revisions);
  return {
    insert: (table: UnitTable) => ({
      values: (value: UnitWrite) =>
        Effect.sync(() => {
          rows(table).push(value);
          return [];
        }),
    }),
    select: () => ({ from: (table: UnitTable) => fromTable(rows(table)) }),
  };
};

describe('Configuration Unit revision chain', () => {
  it.effect('rejects an overlapping successor without changing the existing Current proof', () =>
    Effect.gen(function* rejectsOverlap() {
      // @ts-expect-error Mock covers the scoped Drizzle select/insert chains used here.
      const persistence = configurationUnitPersistenceForScope(fixture(), scope);
      const bounded = Schema.decodeUnknownSync(CreateConfigurationUnitPayloadSchema)({
        ...createPayload,
        effectiveTo: '2026-12-01T00:00:00.000Z',
      });
      expect((yield* persistence.create({ ...evidence, payload: bounded })).status).toBe('CREATED');
      const overlapping = Schema.decodeUnknownSync(ReviseConfigurationUnitPayloadSchema)({
        dimension: 'length',
        effectiveFrom: '2026-11-01T00:00:00.000Z',
        evidenceRefs: ['owner:engineering:2'],
        expectedRevision: 1,
        meaning: 'Changed meaning',
        reason: 'Proposed overlap',
        unitRef,
      });
      expect((yield* persistence.revise({ ...evidence, payload: overlapping })).status).toBe('INVALID');
      const current = yield* persistence.readCurrent(unitId, new Date('2026-11-15T00:00:00Z'));
      expect(current.status).toBe('CONFIRMED');
      if (current.status === 'CONFIRMED') {
        expect(current.revision.revision).toBe(1);
      }
    }),
  );

  it.effect('retains historical R1, supersedes it at R2, and rejects a stale concurrent writer', () =>
    Effect.gen(function* testChain() {
      const transaction = fixture();
      // @ts-expect-error Mock covers the scoped Drizzle select/insert chains used here.
      const persistence = configurationUnitPersistenceForScope(transaction, scope);
      expect((yield* persistence.create({ ...evidence, payload: createPayload })).status).toBe('CREATED');
      expect((yield* persistence.readCurrent(unitId, new Date('2026-09-10T00:00:00Z'))).status).toBe('CONFIRMED');
      const revise = Schema.decodeUnknownSync(ReviseConfigurationUnitPayloadSchema)({
        dimension: 'length',
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        evidenceRefs: ['owner:engineering:2'],
        expectedRevision: 1,
        meaning: 'Centimetre, corrected evidence',
        reason: 'Documented revision',
        unitRef,
      });
      expect((yield* persistence.revise({ ...evidence, payload: revise })).status).toBe('REVISED');
      expect((yield* persistence.revise({ ...evidence, payload: revise })).status).toBe('STALE');
      const historical = yield* persistence.readCurrent(unitId, new Date('2026-09-10T00:00:00Z'));
      expect(historical.status).toBe('CONFIRMED');
      if (historical.status === 'CONFIRMED') {
        expect(historical.revision.revision).toBe(1);
        expect(historical.revision.effectiveTo?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
      }
      const future = yield* persistence.readCurrent(unitId, new Date('2026-10-10T00:00:00Z'));
      expect(future.status).toBe('CONFIRMED');
      if (future.status === 'CONFIRMED') {
        expect(future.revision.revision).toBe(2);
      }
      const retire = Schema.decodeUnknownSync(RetireConfigurationUnitPayloadSchema)({
        effectiveFrom: '2026-11-01T00:00:00.000Z',
        evidenceRefs: ['owner:engineering:3'],
        expectedRevision: 2,
        reason: 'Retired Unit',
        unitRef,
      });
      expect((yield* persistence.retire({ ...evidence, payload: retire })).status).toBe('RETIRED');
      expect((yield* persistence.readCurrent(unitId, new Date('2026-11-10T00:00:00Z'))).status).toBe('RETIRED');
    }),
  );
});
