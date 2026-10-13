import { comboboxTranslations } from '@app/admin-ui';
import { Combobox } from '@techsio/ui-kit/molecules/combobox';
import type { ComboboxProps } from '@techsio/ui-kit/molecules/combobox';
import { useEffect, useRef, useState } from 'react';

/**
 * ui-kit Combobox that opens its list on a click into the text field, like the Selects next to it. ui-kit does not
 * forward zag's `openOnClick`, so this component holds the open state and opens the list on that click.
 * It never shows ui-kit's clear button, because zag names it "Clear value" in English and ui-kit offers no prop
 * for a Czech label. Deleting the text or picking another option replaces the value instead.
 */
export const PickerCombobox = <T,>(props: ComboboxProps<T>) => {
  const { onOpenChange } = props;
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    // A native listener on the wrapper only sees clicks inside it. React would also deliver clicks on the
    // portalled options, which must not reopen the list they just closed.
    const openOnFieldClick = (event: MouseEvent) => {
      const input = field?.querySelector<HTMLInputElement>('input[role="combobox"]');
      if (input !== null && input !== undefined && event.target === input && !input.disabled && !input.readOnly) {
        setOpen(true);
      }
    };
    field?.addEventListener('click', openOnFieldClick);
    return () => {
      field?.removeEventListener('click', openOnFieldClick);
    };
  }, []);

  return (
    <div ref={fieldRef}>
      <Combobox
        translations={comboboxTranslations}
        {...props}
        clearable={false}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange?.(next);
        }}
        open={open}
      />
    </div>
  );
};
