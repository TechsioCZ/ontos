import { describe, expect, it } from 'effect-rstest';

import {
  assessGtinAssignment,
  assessSkuAssignment,
  assessSkuCorrection,
  isValidSkuCode,
  normalizeSku,
  skuUniquenessKey,
  validateGtin,
} from '../../shared/domain/commercial-code.ts';

const variant = { kind: 'VARIANT', tenantId: 'tenant-a', variantId: 'v1' } as const;
const otherVariant = { kind: 'VARIANT', tenantId: 'tenant-a', variantId: 'v2' } as const;
const option = { kind: 'PACKAGE_OPTION', packageDefinitionId: 'box', tenantId: 'tenant-a' } as const;
const current = { attribution: 'LEGITIMATE', code: 'AB-12', state: 'CURRENT', target: variant } as const;

describe('Catalog commercial codes', () => {
  it('normalizes only the SKU comparison, preserving the supplied display text', () => {
    expect(normalizeSku('  ab-12  ')).toBe('AB-12');
    expect(skuUniquenessKey('tenant-a', ' ab-12 ')).toBe(skuUniquenessKey('tenant-a', 'AB-12'));
    expect(skuUniquenessKey('tenant-a', '0012')).not.toBe(skuUniquenessKey('tenant-a', '12'));
    expect(skuUniquenessKey('tenant-a', 'AB-12')).not.toBe(skuUniquenessKey('tenant-a', 'AB12'));
    expect(skuUniquenessKey('tenant-a', 'A B')).not.toBe(skuUniquenessKey('tenant-a', 'AB'));
    expect(skuUniquenessKey('tenant-a', 'AB-12')).not.toBe(skuUniquenessKey('tenant-b', 'AB-12'));
    expect(current.code).toBe('AB-12');
    expect(normalizeSku('\u00A0straße\u00A0')).toBe('STRASSE');
    expect(skuUniquenessKey('tenant-a', 'straße')).toBe(skuUniquenessKey('tenant-a', 'STRASSE'));
    expect(skuUniquenessKey('tenant-a', '😀a')).toBe(skuUniquenessKey('tenant-a', '😀A'));
    expect(isValidSkuCode('😀'.repeat(240))).toBe(true);
    expect(isValidSkuCode('😀'.repeat(241))).toBe(false);
  });

  it('uses ECMAScript whitespace trimming and Unicode uppercase for every SKU key', () => {
    expect(normalizeSku('\t\u00A0ab-12\u00A0\t')).toBe('AB-12');
    expect(skuUniquenessKey('tenant-a', '\tab-12\t')).toBe(skuUniquenessKey('tenant-a', 'AB-12'));
    expect(skuUniquenessKey('tenant-a', '\u00A0ab-12\u00A0')).toBe(skuUniquenessKey('tenant-a', 'AB-12'));
    expect(skuUniquenessKey('tenant-a', 'straße')).toBe(skuUniquenessKey('tenant-a', 'STRASSE'));
    expect(skuUniquenessKey('tenant-a', 'a\tb')).not.toBe(skuUniquenessKey('tenant-a', 'AB'));
    expect(skuUniquenessKey('tenant-a', 'a\u00A0b')).not.toBe(skuUniquenessKey('tenant-a', 'A B'));
    expect(assessSkuAssignment({ code: '\t\u00A0', target: variant }, []).status).toBe('INVALID');
  });

  it('keeps Variant and Package Option targets separate across Current and historical codes', () => {
    expect(assessSkuAssignment({ code: ' ab-12 ', target: otherVariant }, [current]).status).toBe('CONFLICT');
    expect(assessSkuAssignment({ code: 'AB-12', target: option }, [current]).status).toBe('CONFLICT');
    expect(assessSkuAssignment({ code: 'AB-12', target: variant }, [current]).status).toBe('VALID');
    expect(assessSkuAssignment({ code: 'NEW', target: variant }, [current]).status).toBe('CONFLICT');
    const historical = { ...current, state: 'HISTORICAL' } as const;
    expect(assessSkuAssignment({ code: 'AB-12', target: option }, [historical]).status).toBe('CONFLICT');
    expect(assessSkuAssignment({ code: 'NEW', target: variant }, [historical]).status).toBe('VALID');
    expect(
      assessSkuAssignment({ code: 'AB-12', target: { ...otherVariant, tenantId: 'tenant-b' } }, [current]).status,
    ).toBe('VALID');
    expect(assessSkuAssignment({ code: '  ', target: variant }, []).status).toBe('INVALID');
  });

  it('allows documented correction only with evidence in the same Tenant', () => {
    expect(assessSkuCorrection(current, otherVariant, 'proof').status).toBe('INVALID');
    const mistaken = { ...current, attribution: 'DOCUMENTED_ERROR' } as const;
    expect(assessSkuCorrection(mistaken, otherVariant, '').status).toBe('INVALID');
    expect(assessSkuCorrection(mistaken, { ...otherVariant, tenantId: 'tenant-b' }, 'proof').status).toBe('INVALID');
    expect(assessSkuCorrection(mistaken, otherVariant, 'proof').status).toBe('VALID');
  });

  it('checks supported GTIN lengths and check digits without claiming attribution', () => {
    expect(validateGtin('96385074')).toEqual({ format: 'GTIN_8', status: 'VALID' });
    expect(validateGtin('042100005264')).toEqual({ format: 'GTIN_12', status: 'VALID' });
    expect(validateGtin('4006381333931')).toEqual({ format: 'GTIN_13', status: 'VALID' });
    expect(validateGtin('10012345678902')).toEqual({ format: 'GTIN_14', status: 'VALID' });
    expect(validateGtin('4006381333932').status).toBe('INVALID');
    expect(validateGtin(' 4006381333931 ').status).toBe('INVALID');
    expect(validateGtin('AB-12').status).toBe('INVALID');
    const packageLevel = { kind: 'PACKAGE_LEVEL', packageDefinitionId: 'box', tenantId: 'tenant-a' } as const;
    expect(
      assessGtinAssignment({ attribution: 'UNCONFIRMED', code: '10012345678902', target: packageLevel }).status,
    ).toBe('INVALID');
    expect(
      assessGtinAssignment({ attribution: 'CONFIRMED', code: '10012345678902', target: packageLevel }).status,
    ).toBe('VALID');
  });
});
