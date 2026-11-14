// expect-count: 5
import { DatePicker } from '@techsio/ui-kit/molecules/date-picker';
import { FormInput as KitInput } from '@techsio/ui-kit/molecules/form-input';
import { RadioGroup } from '@techsio/ui-kit/molecules/radio-group';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import type { ComponentProps } from 'react';

/** A local wrapper may pass `required` on through its props. */
export const Field = (props: ComponentProps<typeof KitInput>) => <KitInput {...props} />;

export const Form = ({ condition, label }: { readonly condition: boolean; readonly label: string }) => (
  <>
    <KitInput id="a" label={label} required />
    <Switch required={condition}>{label}</Switch>
    <RadioGroup required>
      <RadioGroup.Label>{label}</RadioGroup.Label>
    </RadioGroup>
    <DatePicker.Root required>
      <DatePicker.Label>{label}</DatePicker.Label>
    </DatePicker.Root>
  </>
);
