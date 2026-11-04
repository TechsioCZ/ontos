import { SelectTemplate as UiKitSelectTemplate } from '@techsio/ui-kit/templates/select';
import type { SelectItem } from '@techsio/ui-kit/molecules/select';
import { Schema } from 'effect';
import type { ComponentProps } from 'react';

type UiKitSelectProps = ComponentProps<typeof UiKitSelectTemplate>;

const isText = Schema.is(Schema.String);

/**
 * ui-kit's hidden native `<option>` prints `displayValue`, else the item's value. Most lists use IDs as values, so the
 * native option text became an ID. Each option's text label is also passed as `displayValue`, so the native option
 * carries the name a person reads. Rich labels keep their own `displayValue`. Visible items are unchanged.
 */
export const withNativeLabels = <Item extends SelectItem>(items: readonly Item[]) =>
  items.map((item) => ({
    ...item,
    displayValue: item.displayValue ?? (isText(item.label) ? item.label : item.value),
  }));

export const SelectTemplate = ({
  items,
  ...props
}: Omit<UiKitSelectProps, 'items'> & { readonly items: readonly SelectItem[] }) => (
  <UiKitSelectTemplate {...props} items={withNativeLabels(items)} />
);
