import { expect, it } from 'effect-rstest';
import { selectItem } from '../../src/ui/select-item.ts';

it('keeps Czech labels in native options without changing their internal values', () => {
  for (const [value, label] of [
    ['all', 'Všechny typy'],
    ['camera', 'Kamera'],
    ['in_operation', 'V provozu'],
    ['out_of_service', 'Mimo provoz'],
  ] as const) {
    expect(selectItem(value, label)).toEqual({ displayValue: label, label, value });
  }
});
