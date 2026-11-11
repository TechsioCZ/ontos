import { DatePicker, FormInput } from '@app/admin-ui/form-controls';
import { Button } from '@techsio/ui-kit/atoms/button';
import { FormTextarea } from '@techsio/ui-kit/molecules/form-textarea';
import { Switch } from '@techsio/ui-kit/molecules/switch';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';

export type Props = ComboboxProps<string>;

/** Wrapped controls may be required; ui-kit controls may be used when the field is optional. */
export const Form = ({ label }: { readonly label: string }) => (
  <>
    <FormInput id="a" label={label} required />
    <DatePicker.Root required>
      <DatePicker.Label>{label}</DatePicker.Label>
    </DatePicker.Root>
    <FormTextarea id="b" label={label} />
    <Switch required={false}>{label}</Switch>
    <Button type="submit">{label}</Button>
  </>
);
