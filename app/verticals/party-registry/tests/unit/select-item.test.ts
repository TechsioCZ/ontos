import { expect, it } from 'effect-rstest';
import { selectItem } from '../../src/ui/select-item.ts';

it('keeps Czech labels in native options without changing their internal values', () => {
  for (const [value, label] of [
    ['all', 'Všechny stavy'],
    ['ACTIVE', 'Aktivní'],
    ['ARCHIVED', 'Archivovaný'],
    ['vip', 'Významný zákazník'],
  ] as const) {
    expect(selectItem(value, label)).toEqual({ displayValue: label, label, value });
  }
});
