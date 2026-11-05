import { Select } from '@techsio/ui-kit/molecules/select';

import type { PeopleChoice } from './people-view-model.ts';

/** Feature-local composition of the existing kit select, not a new primitive. */
export const PeopleChoiceField = ({
  disabled = false,
  items,
  label,
  multiple = false,
  onChange,
  value,
}: {
  readonly disabled?: boolean;
  readonly items: readonly PeopleChoice[];
  readonly label: string;
  readonly multiple?: boolean;
  readonly onChange: (value: string[]) => void;
  readonly value: readonly string[];
}) => {
  const choices = items.map((item) => ({ label: item.label, value: item.id }));
  return (
    <Select
      disabled={disabled}
      items={choices}
      multiple={multiple}
      onValueChange={(details) => onChange(details.value)}
      value={[...value]}
    >
      <Select.Label>{label}</Select.Label>
      <Select.Control>
        <Select.Trigger>
          <Select.ValueText placeholder={label} />
        </Select.Trigger>
      </Select.Control>
      <Select.Positioner>
        <Select.Content>
          {choices.map((item) => (
            <Select.Item item={item} key={item.value}>
              <Select.ItemText>{item.label}</Select.ItemText>
              <Select.ItemIndicator />
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Positioner>
    </Select>
  );
};
