import { Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { SetProductManufacturerResultSchema } from '../../shared/actions/set-product-manufacturer.ts';
import {
  SetProductManufacturerRecoveryRequestSchema,
  SetProductManufacturerRecoveryResponseSchema,
} from '../../shared/apis/set-product-manufacturer-recovery.ts';
import { setProductManufacturerRecoveryRead } from '../../src/api/set-product-manufacturer-recovery.read.ts';
import { SetProductTypeResultSchema } from '../../shared/actions/set-product-type.ts';
import {
  SetProductTypeRecoveryRequestSchema,
  SetProductTypeRecoveryResponseSchema,
} from '../../shared/apis/set-product-type-recovery.ts';
import { setProductTypeRecoveryRead } from '../../src/api/set-product-type-recovery.read.ts';
import { SetProductUnitTargetDivisibilityResultSchema } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import {
  SetProductUnitTargetDivisibilityRecoveryRequestSchema,
  SetProductUnitTargetDivisibilityRecoveryResponseSchema,
} from '../../shared/apis/set-product-unit-target-divisibility-recovery.ts';
import { setProductUnitTargetDivisibilityRecoveryRead } from '../../src/api/set-product-unit-target-divisibility-recovery.read.ts';
import { SetVariantAttributeOverrideResultSchema } from '../../shared/actions/set-variant-attribute-override.ts';
import {
  SetVariantAttributeOverrideRecoveryRequestSchema,
  SetVariantAttributeOverrideRecoveryResponseSchema,
} from '../../shared/apis/set-variant-attribute-override-recovery.ts';
import { setVariantAttributeOverrideRecoveryRead } from '../../src/api/set-variant-attribute-override-recovery.read.ts';
import { SetVariantLocalizedFactsResultSchema } from '../../shared/actions/set-variant-localized-facts.ts';
import {
  SetVariantLocalizedFactsRecoveryRequestSchema,
  SetVariantLocalizedFactsRecoveryResponseSchema,
} from '../../shared/apis/set-variant-localized-facts-recovery.ts';
import { setVariantLocalizedFactsRecoveryRead } from '../../src/api/set-variant-localized-facts-recovery.read.ts';

const invocationId = '33333333-3333-4333-8333-333333333333';
const cases = [
  [
    'set-product-manufacturer',
    SetProductManufacturerResultSchema,
    SetProductManufacturerRecoveryRequestSchema,
    SetProductManufacturerRecoveryResponseSchema,
    setProductManufacturerRecoveryRead,
  ],
  [
    'set-product-type',
    SetProductTypeResultSchema,
    SetProductTypeRecoveryRequestSchema,
    SetProductTypeRecoveryResponseSchema,
    setProductTypeRecoveryRead,
  ],
  [
    'set-product-unit-target-divisibility',
    SetProductUnitTargetDivisibilityResultSchema,
    SetProductUnitTargetDivisibilityRecoveryRequestSchema,
    SetProductUnitTargetDivisibilityRecoveryResponseSchema,
    setProductUnitTargetDivisibilityRecoveryRead,
  ],
  [
    'set-variant-attribute-override',
    SetVariantAttributeOverrideResultSchema,
    SetVariantAttributeOverrideRecoveryRequestSchema,
    SetVariantAttributeOverrideRecoveryResponseSchema,
    setVariantAttributeOverrideRecoveryRead,
  ],
  [
    'set-variant-localized-facts',
    SetVariantLocalizedFactsResultSchema,
    SetVariantLocalizedFactsRecoveryRequestSchema,
    SetVariantLocalizedFactsRecoveryResponseSchema,
    setVariantLocalizedFactsRecoveryRead,
  ],
] as const;

describe('Set Action typed recovery reads', () => {
  for (const [slug, resultSchema, requestSchema, responseSchema, read] of cases) {
    it(`${slug} retains its exact result schema and requires an invocation ID`, () => {
      expect(responseSchema).toBe(resultSchema);
      expect(Schema.decodeUnknownSync(requestSchema)({ invocationId })).toEqual({ invocationId });
      expect(() => Schema.decodeUnknownSync(requestSchema)({})).toThrow();
      expect(read).toBeDefined();
    });
  }
});
