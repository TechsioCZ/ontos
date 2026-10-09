import { describe, expect, it } from 'effect-rstest';

import { normalizePurchaseQuantity } from '../../shared/domain/purchase-quantity.ts';

const rule = { revision: 7, rounding: 'UP', step: '0.01', tenantId: 'tenant-1', unitId: 'metre' } as const;
const request = { amount: '2.537', divisible: true, targetId: 'variant-1', tenantId: 'tenant-1', unitId: 'metre' };

describe('Catalog purchase Quantity', () => {
  it('normalizes an exact off-step divisible amount during preparation with visible provenance', () => {
    expect(normalizePurchaseQuantity(request, rule, 'PREPARE')).toEqual({
      changed: true,
      notice: 'ROUNDED',
      requested: '2.537',
      resulting: '2.54',
      rounding: 'UP',
      status: 'VALID',
      step: '0.01',
      targetId: 'variant-1',
      tenantId: 'tenant-1',
      unitId: 'metre',
      unitRuleRevision: 7,
    });
  });

  it('never legalizes a fractional indivisible target by rounding', () => {
    const pieces = { ...request, amount: '0.5', divisible: false, unitId: 'piece' };
    expect(normalizePurchaseQuantity(pieces, { ...rule, step: '1', unitId: 'piece' }, 'PREPARE').status).toBe(
      'INVALID',
    );
    expect(
      normalizePurchaseQuantity({ ...pieces, amount: '2' }, { ...rule, step: '1', unitId: 'piece' }, 'PREPARE').status,
    ).toBe('VALID');
  });

  it('rejects zero, negative, non-finite and unexpressible purchase quantities', () => {
    for (const amount of ['0', '-1', 'NaN', 'Infinity', '1e309', '1.2.3']) {
      expect(normalizePurchaseQuantity({ ...request, amount }, rule, 'PREPARE').status).toBe('INVALID');
    }
  });

  it('requires a matching explicit versioned Unit rule without guessing a rounding direction', () => {
    expect(normalizePurchaseQuantity(request, { ...rule, rounding: null }, 'PREPARE').status).toBe('UNVERIFIABLE');
    expect(normalizePurchaseQuantity(request, { ...rule, tenantId: 'other' }, 'PREPARE').status).toBe('UNVERIFIABLE');
    expect(normalizePurchaseQuantity(request, { ...rule, step: '0' }, 'PREPARE').status).toBe('UNVERIFIABLE');
  });

  it('requires re-preparation instead of changing approved or committing quantity', () => {
    expect(normalizePurchaseQuantity(request, rule, 'APPROVED').status).toBe('REPREPARE_REQUIRED');
    expect(normalizePurchaseQuantity(request, rule, 'COMMITTING').status).toBe('REPREPARE_REQUIRED');
  });

  it('rejects normalization down to zero and calculates half-up exactly', () => {
    expect(
      normalizePurchaseQuantity({ ...request, amount: '0.1' }, { ...rule, rounding: 'DOWN', step: '1' }, 'PREPARE')
        .status,
    ).toBe('INVALID');
    const result = normalizePurchaseQuantity(
      { ...request, amount: '2.535' },
      { ...rule, rounding: 'HALF_UP' },
      'PREPARE',
    );
    expect(result.status === 'VALID' && result.resulting).toBe('2.54');
  });
});
