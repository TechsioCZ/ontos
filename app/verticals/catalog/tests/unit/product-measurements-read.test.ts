import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { attributeValueItems } from '../../src/database/schema.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueRevisions,
  attributeValueSets,
  products,
} from '../../src/database/schema.ts';
import { productMeasurementsReadForScope } from '../../src/persistence/product-measurements-read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const setId = '44444444-4444-4444-8444-444444444444';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-measurements-test:run:1',
    authMethod: 'system',
    principalId: '99999999-9999-4999-8999-999999999999',
    tenantId,
  }),
  correlationId: 'product-measurements-test',
};
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const definition = {
  allowsNone: 0,
  allowsNotApplicable: 0,
  allowsUnknown: 0,
  applicableLevels: ['PRODUCT'],
  attributeDefinitionId: definitionId,
  canonicalUnit: 'mm',
  controlledValueKind: null,
  currentRevision: 2,
  decimalPlaces: 0,
  maximumValue: null,
  meaning: 'Product width',
  measuredQuantity: 'length',
  minimumValue: null,
  multiplicity: 'SINGLE',
  name: 'Width',
  tenantId,
  valueKind: 'MEASUREMENT',
};
const set = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: setId,
  currentRevision: 3,
  currentState: 'SET',
  productId,
  tenantId,
  variantId: null,
};
const item = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: setId,
  numericValue: '80',
  ordinal: 0,
  tenantId,
  unit: 'mm',
  valueKind: 'MEASUREMENT',
};
const revision = {
  attributeValueSetId: setId,
  changeKind: 'SET',
  revision: 3,
  tenantId,
  valueSnapshot: {
    attributeDefinitionRevision: 2,
    productTypeId: '55555555-5555-4555-8555-555555555555',
    productTypeRevision: 1,
    sourceProductValueRevision: null,
    values: [{ amount: 80, kind: 'MEASUREMENT', unit: 'mm' }],
  },
};

type Table =
  | typeof products
  | typeof attributeValueSets
  | typeof attributeDefinitions
  | typeof attributeDefinitionRevisions
  | typeof attributeValueRevisions
  | typeof attributeValueItems;

const query = (result: readonly object[]) =>
  Object.assign(Effect.succeed(result), {
    limit: () => Effect.succeed(result),
    orderBy: () => Effect.succeed(result),
  });

const fixture = (
  options: {
    readonly absent?: boolean;
    readonly definitionDrift?: boolean;
    readonly itemDrift?: boolean;
    readonly removed?: boolean;
    readonly snapshotDrift?: boolean;
  } = {},
) => {
  const rows = (table: Table): readonly object[] => {
    if (table === products) {
      return [{ productId }];
    }
    if (table === attributeValueSets) {
      return options.absent === true ? [] : [{ ...set, currentState: options.removed === true ? 'REMOVED' : 'SET' }];
    }
    if (table === attributeDefinitions) {
      return [definition];
    }
    if (table === attributeDefinitionRevisions) {
      return [{ ...definition, name: options.definitionDrift === true ? 'Other' : 'Width', revision: 2 }];
    }
    if (table === attributeValueRevisions) {
      return [
        {
          ...revision,
          changeKind: options.removed === true ? 'REMOVED' : 'SET',
          valueSnapshot: {
            ...revision.valueSnapshot,
            values:
              options.removed === true
                ? []
                : [{ amount: options.snapshotDrift === true ? 81 : 80, kind: 'MEASUREMENT', unit: 'mm' }],
          },
        },
      ];
    }
    return options.removed === true ? [] : [{ ...item, numericValue: options.itemDrift === true ? '81' : '80' }];
  };
  const transaction = {
    select: () => ({ from: (table: Table) => ({ where: () => query(rows(table)) }) }),
  };
  // SAFETY: This fixture implements only the read query shape exercised by this service.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only query stub; remove when a typed repository test harness exists. Owner: Catalog #433.
  return productMeasurementsReadForScope(transaction as never, scope);
};

describe('Product measurements read', () => {
  it.effect('returns Product-specific measured values with their pinned Definition revision', () =>
    Effect.gen(function* knownMeasurement() {
      const result = yield* fixture().read(productRef);
      expect(result).toEqual({
        measurements: [
          {
            amount: 80,
            attributeDefinitionId: definitionId,
            attributeDefinitionRevision: 2,
            attributeValueSetId: setId,
            attributeValueSetRevision: 3,
            canonicalUnit: 'mm',
            meaning: 'Product width',
            quantity: 'length',
            unit: 'mm',
          },
        ],
        status: 'KNOWN',
      });
    }),
  );
  it.effect('does not invent a measurement when none is recorded or a set is removed', () =>
    Effect.gen(function* absentMeasurement() {
      expect(yield* fixture({ absent: true }).read(productRef)).toEqual({ status: 'ABSENT' });
      expect(yield* fixture({ removed: true }).read(productRef)).toEqual({ status: 'ABSENT' });
    }),
  );
  it.effect('fails closed on current/immutable evidence mismatch', () =>
    Effect.gen(function* inconsistentMeasurement() {
      expect(yield* fixture({ definitionDrift: true }).read(productRef)).toEqual({ status: 'UNAVAILABLE' });
      expect(yield* fixture({ itemDrift: true }).read(productRef)).toEqual({ status: 'UNAVAILABLE' });
      expect(yield* fixture({ snapshotDrift: true }).read(productRef)).toEqual({ status: 'UNAVAILABLE' });
    }),
  );
  it.effect('rejects a foreign Product reference', () =>
    Effect.gen(function* foreignProduct() {
      expect(yield* fixture().read({ ...productRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toEqual({
        status: 'UNAVAILABLE',
      });
    }),
  );
});
