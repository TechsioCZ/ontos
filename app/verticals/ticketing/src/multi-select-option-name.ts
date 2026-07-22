import { rejectAction } from '@app/core-runtime';
import { prepareSelectOptionName } from './select-option-name.ts';

type MultiSelectOptionNameAction =
  | 'createMultiSelectOption'
  | 'createMultiSelectOptionAndSelect'
  | 'updateMultiSelectOption';

export const prepareMultiSelectOptionName = (
  name: string,
  action: MultiSelectOptionNameAction,
): ReturnType<typeof prepareSelectOptionName> => {
  const prepared = prepareSelectOptionName(name);
  if (prepared.displayName.length === 0) {
    throw rejectAction({
      code: `ticketing.${action}.name_required`,
      message: 'An option name is required.',
    });
  }
  if (prepared.displayName.includes(',')) {
    throw rejectAction({
      code: `ticketing.${action}.comma_not_allowed`,
      message: 'A Multi-select option name cannot contain a comma.',
    });
  }
  return prepared;
};
