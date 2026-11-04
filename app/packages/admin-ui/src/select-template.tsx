import { SelectTemplate as UiKitSelectTemplate } from '@techsio/ui-kit/templates/select';
import type { ComponentProps } from 'react';

type UiKitSelectProps = ComponentProps<typeof UiKitSelectTemplate>;

interface SelectOption {
  readonly disabled?: boolean;
  readonly displayValue?: string;
  readonly label: string;
  readonly value: string;
}

/**
 * ui-kit's hidden native `<option>` prints `displayValue`, else the item's value. Most lists use IDs as values, so the
 * native option text became an ID. Each option's label is also passed as `displayValue`, so the native option carries
 * the name a person reads. Visible items are unchanged.
 */
export const SelectTemplate = ({
  items,
  ...props
}: Omit<UiKitSelectProps, 'items'> & { readonly items: readonly SelectOption[] }) => (
  <UiKitSelectTemplate
    {...props}
    items={items.map((item) => ({ ...item, displayValue: item.displayValue ?? item.label }))}
  />
);
