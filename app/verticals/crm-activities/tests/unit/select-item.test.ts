import { expect, it } from 'effect-rstest';
import { selectItem } from '../../src/ui/select-item.ts';

it('keeps Czech labels in native options without changing their internal values', () => {
  for (const [value, label] of [
    ['party-123', 'Jiří Šťastný'],
    ['task-456', 'Domluvit prohlídku Nájemparku'],
  ] as const) {
    expect(selectItem(value, label)).toEqual({ displayValue: label, label, value });
  }
});
