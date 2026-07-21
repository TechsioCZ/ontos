import type { SelectOption, SelectOptionOrderMode } from '../shared/task-property-definition.ts';

export const orderSelectOptions = (
  options: readonly SelectOption[],
  mode: SelectOptionOrderMode,
  locale: string,
): SelectOption[] => {
  if (mode === 'manual') {
    return options.toSorted(
      (left, right) =>
        left.manualPosition - right.manualPosition || left.optionId.localeCompare(right.optionId),
    );
  }

  const collator = new Intl.Collator(locale, { sensitivity: 'variant', usage: 'sort' });
  const direction = mode === 'reverse_alphabetical' ? -1 : 1;

  return options.toSorted((left, right) => {
    const alphabeticalOrder =
      collator.compare(left.name.normalize('NFC'), right.name.normalize('NFC')) ||
      left.optionId.localeCompare(right.optionId);

    return direction * alphabeticalOrder;
  });
};
