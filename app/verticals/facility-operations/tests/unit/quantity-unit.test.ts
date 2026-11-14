import { expect, it } from 'effect-rstest';
import { quantityUnitLabel } from '../../src/ui/quantity-unit.ts';

it('declines spelled-out stock units for single, few, zero, higher and negative counts', () => {
  for (const [unit, forms] of [
    ['karton', ['karton', 'kartony', 'kartony', 'kartonů', 'kartonů', 'kartonů', 'kartonu']],
    ['role', ['role', 'role', 'role', 'rolí', 'rolí', 'rolí', 'role']],
    ['pytel', ['pytel', 'pytle', 'pytle', 'pytlů', 'pytlů', 'pytlů', 'pytle']],
    ['kanystr', ['kanystr', 'kanystry', 'kanystry', 'kanystrů', 'kanystrů', 'kanystrů', 'kanystru']],
  ] as const) {
    for (const [index, count] of [1, 2, 4, 0, 5, 21, 1.5].entries()) {
      expect(quantityUnitLabel(count, unit)).toBe(forms[index]);
      expect(quantityUnitLabel(-count, unit)).toBe(forms[index]);
    }
  }
});

it('preserves abbreviations and custom units exactly as recorded', () => {
  for (const unit of ['ks', 'bal', 'kg', 'l', 'm²', 'sada']) {
    for (const count of [0, 1, 2, 6, 44]) {
      expect(quantityUnitLabel(count, unit)).toBe(unit);
    }
  }
});
