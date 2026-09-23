import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { ColorCurrentRequestSchema, ColorCurrentResponseSchema } from '../../shared/apis/color-current.ts';
import { ColorHistoryResponseSchema } from '../../shared/apis/color-history.ts';
import { controlledAttributeValueRevisions, controlledAttributeValues } from '../../src/database/schema.ts';
import { colorReadsForScope } from '../../src/persistence/color-reads.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const valueId = '33333333-3333-4333-8333-333333333333';
const definitionId = '44444444-4444-4444-8444-444444444444';
const valueRef = {
  moduleId: 'commerce.catalog',
  resourceId: valueId,
  resourceType: 'commerce.catalog.controlled-attribute-value',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:color-read-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'color-read-test',
};
const details = {
  distinctionEvidence: {
    designation: 'A-1',
    kind: 'SWATCH',
    source: 'Supplier',
    sourceScope: '2026 book',
    system: 'Supplier palette',
  },
  groupName: 'grey',
  localizedNames: [{ locale: 'cs-CZ', name: 'Antracit' }],
  preview: { hex: '#333333', kind: 'HEX' },
} as const;
const revisedDetails = { ...details, localizedNames: [{ locale: 'cs-CZ', name: 'Tmavý antracit' }] } as const;
const revision = (
  number: number,
  name: string,
  colorDetails: typeof details | typeof revisedDetails | null,
  lifecycleState = 'ACTIVE',
) => ({
  actingPrincipalId: scope.principalId,
  actionInvocationId: '55555555-5555-4555-8555-555555555555',
  attributeDefinitionId: definitionId,
  colorDetails,
  controlledAttributeValueId: valueId,
  evidenceRefs: ['record:swatch'],
  lifecycleState,
  name,
  reason: 'Reviewed Color',
  recordedAt: new Date('2026-09-18T00:00:00.000Z'),
  revision: number,
  specialization: 'COLOR',
  tenantId,
});
type Table = typeof controlledAttributeValues | typeof controlledAttributeValueRevisions;
const mock = (rows: Map<Table, object[]>) => ({
  select: () => ({
    from: (table: Table) => {
      const result = () => Effect.succeed(rows.get(table) ?? []);
      return { where: () => ({ limit: result, pipe: result }) };
    },
  }),
});

describe('Color governed reads', () => {
  it.effect('keeps stable identity and exact swatch/preview snapshots across rename', () =>
    Effect.gen(function* stableColorHistory() {
      const rows = new Map<Table, object[]>([
        [
          controlledAttributeValues,
          [
            {
              attributeDefinitionId: definitionId,
              colorDetails: revisedDetails,
              controlledAttributeValueId: valueId,
              currentRevision: 2,
              lifecycleState: 'ACTIVE',
              name: 'Tmavý antracit',
              specialization: 'COLOR',
              tenantId,
            },
          ],
        ],
        [
          controlledAttributeValueRevisions,
          [revision(1, 'Antracit', details), revision(2, 'Tmavý antracit', revisedDetails)],
        ],
      ]);
      // @ts-expect-error Mock implements only the exercised transaction reads.
      const reads = colorReadsForScope(mock(rows), scope);
      const current = yield* reads.current(valueRef);
      const history = yield* reads.history(valueRef);
      expect(Option.isSome(current) && current.value.assignable).toBe(true);
      expect(Option.isSome(current) && current.value.valueRef).toEqual(valueRef);
      expect(history[0]?.displayName).toBe('Antracit');
      expect(history[0]?.colorDetails).toEqual(details);
      expect(history[1]?.colorDetails).toEqual(revisedDetails);
      expect(Option.isSome(current)).toBe(true);
      if (Option.isSome(current)) {
        expect(
          Schema.is(ColorCurrentResponseSchema)({
            ...current.value,
            colorDetails: current.value.colorDetails === null ? Option.none() : Option.some(current.value.colorDetails),
            recordedAt: current.value.recordedAt.toISOString(),
          }),
        ).toBe(true);
      }
      expect(
        Schema.is(ColorHistoryResponseSchema)({
          revisions: history.map((row) => ({
            ...row,
            colorDetails: row.colorDetails === null ? Option.none() : Option.some(row.colorDetails),
            recordedAt: row.recordedAt.toISOString(),
          })),
        }),
      ).toBe(true);
    }),
  );

  it.effect('retains retired Color without making it assignable', () =>
    Effect.gen(function* retiredColor() {
      const rows = new Map<Table, object[]>([
        [
          controlledAttributeValues,
          [
            {
              attributeDefinitionId: definitionId,
              colorDetails: details,
              controlledAttributeValueId: valueId,
              currentRevision: 1,
              lifecycleState: 'RETIRED',
              name: 'Antracit',
              specialization: 'COLOR',
              tenantId,
            },
          ],
        ],
        [controlledAttributeValueRevisions, [revision(1, 'Antracit', details, 'RETIRED')]],
      ]);
      // @ts-expect-error Mock implements only the exercised transaction reads.
      const current = yield* colorReadsForScope(mock(rows), scope).current(valueRef);
      expect(Option.isSome(current) && current.value.assignable).toBe(false);
    }),
  );

  it.effect('does not invent missing legacy provenance and fails closed on inconsistent heads', () =>
    Effect.gen(function* legacyColor() {
      const rows = new Map<Table, object[]>([
        [
          controlledAttributeValues,
          [
            {
              attributeDefinitionId: definitionId,
              colorDetails: null,
              controlledAttributeValueId: valueId,
              currentRevision: 1,
              lifecycleState: 'ACTIVE',
              name: 'Legacy',
              specialization: 'COLOR',
              tenantId,
            },
          ],
        ],
        [controlledAttributeValueRevisions, [revision(1, 'Legacy', null)]],
      ]);
      // @ts-expect-error Mock implements only the exercised transaction reads.
      const reads = colorReadsForScope(mock(rows), scope);
      const legacy = yield* reads.current(valueRef);
      expect(Option.isSome(legacy) && legacy.value.colorDetails).toBeNull();
      if (Option.isSome(legacy)) {
        const encoded = Schema.encodeSync(ColorCurrentResponseSchema)({
          ...legacy.value,
          colorDetails: Option.none(),
          recordedAt: legacy.value.recordedAt.toISOString(),
        });
        expect(encoded.colorDetails).toBeNull();
        expect(encoded.attributeDefinitionId).toBe(definitionId);
      }
      rows.set(controlledAttributeValues, [
        {
          attributeDefinitionId: definitionId,
          colorDetails: details,
          controlledAttributeValueId: valueId,
          currentRevision: 1,
          lifecycleState: 'ACTIVE',
          name: 'Legacy',
          specialization: 'COLOR',
          tenantId,
        },
      ]);
      const error = yield* Effect.flip(reads.current(valueRef));
      expect(error).toBeInstanceOf(CatalogPersistenceUnavailable);
    }),
  );

  it.effect('does not find a missing or non-Color value and rejects another Tenant', () =>
    Effect.gen(function* missingColor() {
      const rows = new Map<Table, object[]>();
      // @ts-expect-error Mock implements only the exercised transaction reads.
      const reads = colorReadsForScope(mock(rows), scope);
      expect(Option.isNone(yield* reads.current(valueRef))).toBe(true);
      expect(Schema.is(ColorCurrentRequestSchema)({ valueRef })).toBe(true);
      const error = yield* Effect.flip(
        reads.current({ ...valueRef, tenantId: '99999999-9999-4999-8999-999999999999' }),
      );
      expect(error).toBeInstanceOf(CatalogPersistenceUnavailable);
    }),
  );
});
