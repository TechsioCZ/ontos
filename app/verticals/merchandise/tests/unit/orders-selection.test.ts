import { describe, expect, it } from 'effect-rstest';

import { commonOrderTransitions } from '../../src/routes/[lang]/prodej/objednavky/orders-model.ts';

describe('bulk order status choices', () => {
  it('offers no action for an empty selection', () => {
    expect(commonOrderTransitions([])).toEqual([]);
  });

  it('keeps only a transition legal for every selected order', () => {
    expect(commonOrderTransitions([{ status: 'NEW' }, { status: 'CONFIRMED' }])).toEqual(['CANCELLED']);
    expect(commonOrderTransitions([{ status: 'SHIPPED' }, { status: 'SHIPPED' }])).toEqual(['DELIVERED']);
  });

  it('does not offer a status change for mixed incompatible or terminal orders', () => {
    expect(commonOrderTransitions([{ status: 'NEW' }, { status: 'SHIPPED' }])).toEqual([]);
    expect(commonOrderTransitions([{ status: 'NEW' }, { status: 'CANCELLED' }])).toEqual([]);
    expect(commonOrderTransitions([{ status: 'DELIVERED' }])).toEqual([]);
  });
});
