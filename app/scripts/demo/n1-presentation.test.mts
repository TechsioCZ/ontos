import { describe, expect, it } from 'effect-rstest';
import { colourLabel, productTitle, variantLabelOf } from './n1-presentation.mts';

describe('N1 product presentation', () => {
  it('names a verified colour in the title', () => {
    expect(colourLabel('38SA075404-BLK2')).toBe('černá 2');
    expect(productTitle('Pánská bunda Spyder Titan Jacket', '38SA075404-BLK1')).toBe(
      'Pánská bunda Spyder Titan Jacket – černá 1',
    );
    expect(productTitle('Pánská mikina Spyder Bandit 1/2 Zip', '38A485330-CBT')).toBe(
      'Pánská mikina Spyder Bandit 1/2 Zip – kobaltová',
    );
  });

  it('keeps the SKU colour code where no verified name exists, so duplicate models stay distinct', () => {
    expect(productTitle('Pánská mikina Spyder Prospect 1/2 Zip', '38A013507-STM')).toBe(
      'Pánská mikina Spyder Prospect 1/2 Zip – STM',
    );
  });

  it('shows the size only for a variant that carries the source option', () => {
    expect(
      variantLabelOf({ name: 'Source option L/XL', parameters: [{ label: 'Source option', value: 'L/XL' }] }),
    ).toBe('L/XL');
    expect(variantLabelOf({ name: 'M' })).toBe('M');
  });
});
