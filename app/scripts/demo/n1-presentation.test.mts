import { describe, expect, it } from 'effect-rstest';
import { colourNameOf, productTitle, variantLabelOf } from './n1-presentation.mts';

describe('N1 product presentation', () => {
  it('names verified colours from N1 and the legacy source', () => {
    expect(colourNameOf('38SA075404-BLK2')).toBe('černá');
    expect(colourNameOf('38A485330-CBT')).toBe('kobaltová');
    expect(colourNameOf('38A485330-SLB')).toBe('břidlicově modrá');
  });

  it('names the photo colours, with the full code deciding the digit variants', () => {
    expect(colourNameOf('38SA075404-BLK1')).toBe('červeno-černá');
    expect(colourNameOf('38C125310-BLK3')).toBe('tmavě modrá');
    expect(colourNameOf('38SD125415-ACI2')).toBe('starorůžová');
    expect(colourNameOf('38A013507-STM')).toBe('šedá');
    expect(productTitle('Pánská mikina Spyder Prospect 1/2 Zip', '38A013507-STM')).toBe(
      'Pánská mikina Spyder Prospect 1/2 Zip – šedá',
    );
  });

  it('keeps the models of one family distinct by colour name, never by SKU code', () => {
    const family = ['38SA075404-BLK1', '38SA075404-BLK2'].map((sku) => colourNameOf(sku));
    expect(new Set(family).size).toBe(2);
    const bandit = ['38A485324-LMB', '38A485324-SPR', '38A485324-STM'].map((sku) => colourNameOf(sku));
    expect(new Set(bandit).size).toBe(3);
    expect(bandit.some((name) => name !== undefined && /^[A-Z]+$/u.test(name))).toBe(false);
  });

  it('shows the size only for a variant that carries the source option', () => {
    expect(
      variantLabelOf({ name: 'Source option L/XL', parameters: [{ label: 'Source option', value: 'L/XL' }] }),
    ).toBe('L/XL');
    expect(variantLabelOf({ name: 'M' })).toBe('M');
  });
});
